package dev.leanreview.coverage;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.analysis.AnalysisHelper;
import dev.leanreview.llm.Cancellation;
import dev.leanreview.storage.CapturedArtifacts;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.Pattern;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.springframework.stereotype.Component;
import org.w3c.dom.*;
import org.xml.sax.InputSource;
import org.xml.sax.helpers.DefaultHandler;

@Component
public class CoverageMetrics {
  private final ObjectMapper json;
  private final AnalysisHelper helper;

  public CoverageMetrics(ObjectMapper json, AnalysisHelper helper) {
    this.json = json;
    this.helper = helper;
  }

  public static double crap(double complexity, double coverage) {
    if (!Double.isFinite(complexity)
        || complexity < 1
        || !Double.isFinite(coverage)
        || coverage < 0
        || coverage > 1)
      throw new IllegalArgumentException("Invalid measured complexity or coverage.");
    return complexity * complexity * Math.pow(1 - coverage, 3) + complexity;
  }

  public static void provenance(JsonNode value) {
    if (value == null || value.isNull()) return;
    if (!value.isObject()
        || !value.path("version").isNumber()
        || value.path("version").asDouble() != 1
        || !value.path("reportHash").asText().matches("[a-f0-9]{64}")
        || !value.path("sourceHashes").isObject()
        || !value.path("capturedAt").isTextual()
        || !value.path("tool").isTextual()
        || value.path("tool").asText().isEmpty()
        || value.path("tool").asText().length() > 200
        || (!value.path("head").isTextual() && !value.path("head").isNull()))
      throw new IllegalArgumentException("Invalid coverage provenance.");
    for (JsonNode hash : value.path("sourceHashes"))
      if (!hash.isTextual() || !hash.asText().matches("[a-f0-9]{64}"))
        throw new IllegalArgumentException("Invalid coverage source hash.");
  }

  private static boolean alignedFile(JsonNode file, boolean aligned, JsonNode provenance) {
    return aligned
        && file.path("after").path("kind").asText().equals("text")
        && provenance
            .path("sourceHashes")
            .path(file.path("path").asText())
            .asText()
            .equals(CapturedArtifacts.digest(file.path("after").path("text").asText()));
  }

  public ObjectNode measure(
      JsonNode snapshot,
      String format,
      String report,
      JsonNode provenance,
      double threshold,
      Cancellation cancel)
      throws IOException {
    if (report != null && report.getBytes(StandardCharsets.UTF_8).length > 20 * 1024 * 1024)
      throw new IllegalArgumentException("Coverage report exceeds 20 MiB.");
    provenance(provenance);
    String reportHash = report == null ? null : CapturedArtifacts.digest(report);
    boolean aligned =
        provenance != null
            && !provenance.isNull()
            && provenance.path("reportHash").asText().equals(reportHash)
            && provenance.path("head").equals(snapshot.path("head"));
    ArrayNode warnings = json.createArrayNode();
    if (report != null && !aligned)
      warnings.add(
          "Report fingerprint/source provenance is missing or mismatched. CRAP is unavailable until"
              + " an aligned report is supplied.");
    Map<String, JsonNode> istanbul = new HashMap<>();
    List<Element> packages = List.of();
    if (report != null && format.equals("istanbul")) {
      JsonNode raw = json.readTree(report);
      if (!raw.isObject()) throw new IllegalArgumentException("Invalid Istanbul coverage report.");
      for (var entry : raw.properties()) {
        JsonNode value = entry.getValue();
        validateIstanbul(value);
        String path =
            relative(
                snapshot.path("root").asText(),
                value.has("path") ? value.path("path").asText() : entry.getKey());
        if (path == null || path.isEmpty()) continue;
        if (istanbul.put(path, value) != null)
          throw new IllegalArgumentException(
              "Ambiguous duplicate source paths in coverage report.");
      }
    }
    if (report != null && format.equals("jacoco")) packages = xml(report);
    ArrayNode sources = json.createArrayNode();
    for (JsonNode file : snapshot.path("files"))
      if (file.path("after").path("kind").asText().equals("text")
          && file.path("path").asText().matches(".*\\.[cm]?[jt]sx?$"))
        sources.add(
            json.createObjectNode()
                .put("file", file.path("path").asText())
                .put("text", file.path("after").path("text").asText()));
    Map<String, JsonNode> parsedSources = new HashMap<>();
    if (!sources.isEmpty())
      for (JsonNode parsed :
          helper.call("complexityBatch", json.createObjectNode().set("files", sources), cancel))
        parsedSources.put(parsed.path("file").asText(), parsed);
    ArrayNode files = json.createArrayNode();
    double highest = Double.NEGATIVE_INFINITY;
    int measured = 0, missing = 0, above = 0;
    boolean allAligned = true;
    for (JsonNode file : snapshot.path("files")) {
      cancel.check();
      String path = file.path("path").asText(), text = file.path("after").path("text").asText();
      if (!file.path("after").path("kind").asText().equals("text")
          || !path.matches(".*\\.(?:[cm]?[jt]sx?|java)$")) continue;
      boolean fileAligned = alignedFile(file, aligned, provenance);
      allAligned &= fileAligned;
      ObjectNode item =
          json.createObjectNode()
              .put("fileId", file.path("id").asText())
              .put("path", path)
              .put("language", path.endsWith(".java") ? "java" : "ts/js");
      ArrayNode functions = item.putArray("functions");
      files.add(item);
      if (path.endsWith(".java")) {
        item.put("convention", "JaCoCo method complexity + instruction coverage");
        Set<String> identities = new HashSet<>();
        for (Element pkg : packages)
          for (Element cls : children(pkg, "class")) {
            String source = cls.getAttribute("sourcefilename"),
                suffix =
                    (pkg.getAttribute("name").isEmpty() ? "" : pkg.getAttribute("name") + "/")
                        + source;
            if (source.isEmpty() || !(path.equals(suffix) || path.endsWith("/" + suffix))) continue;
            for (Element method : children(cls, "method")) {
              String identity =
                  cls.getAttribute("name")
                      + "#"
                      + method.getAttribute("name")
                      + method.getAttribute("desc");
              if (!identities.add(identity))
                throw new IllegalArgumentException("Duplicate method identity in JaCoCo report.");
              double line = number(method.getAttribute("line"), 0);
              double[] complexity = counter(method, "COMPLEXITY"),
                  instructions = counter(method, "INSTRUCTION");
              ObjectNode metric =
                  json.createObjectNode()
                      .put("id", CapturedArtifacts.digest(identity).substring(0, 24))
                      .put("name", identity);
              numeric(metric, "line", line);
              metric.putNull("complexity").putNull("coverage").putNull("crap");
              functions.add(metric);
              if (complexity != null && complexity[0] + complexity[1] > 0 && fileAligned)
                metric.put("complexity", complexity[0] + complexity[1]);
              int matches = 0;
              String classFile = cls.getAttribute("name").split("\\$", 2)[0] + ".java";
              for (JsonNode f : snapshot.path("files")) {
                String p = f.path("path").asText();
                if (p.equals(source) || p.endsWith("/" + classFile)) matches++;
              }
              String reason =
                  !fileAligned
                      ? "Missing/stale source provenance"
                      : matches > 1
                          ? "Ambiguous Java source mapping"
                          : !Double.isFinite(line)
                                  || line < 1
                                  || line != Math.floor(line)
                                  || line > text.split("\n", -1).length
                                  || method.getAttribute("desc").isEmpty()
                              ? "Missing/invalid method source mapping"
                              : complexity == null
                                      || complexity[0] + complexity[1] < 1
                                      || instructions == null
                                      || instructions[0] + instructions[1] == 0
                                  ? "Missing counter or zero executable denominator"
                                  : null;
              if (reason != null) metric.put("reason", reason);
              else {
                double q = instructions[1] / (instructions[0] + instructions[1]);
                metric.put("coverage", q).put("crap", crap(complexity[0] + complexity[1], q));
              }
            }
          }
        if (functions.isEmpty())
          item.put(
              "reason",
              report != null
                  ? "No matching JaCoCo methods; method count unknown."
                  : "Import or collect JaCoCo XML to measure Java methods.");
      } else {
        item.put(
            "convention", "Source classic cyclomatic complexity + per-function statement coverage");
        try {
          JsonNode parsed = parsedSources.get(path);
          if (parsed == null || parsed.has("error")) throw new IOException("Unsupported source.");
          JsonNode units = parsed.path("units");
          JsonNode coverage = istanbul.get(path);
          Map<String, List<Double>> hits = new HashMap<>();
          for (JsonNode unit : units) hits.put(unit.path("id").asText(), new ArrayList<>());
          boolean mappingError = false;
          if (coverage != null && format.equals("istanbul"))
            for (var entry : coverage.path("statementMap").properties()) {
              try {
                JsonNode span = entry.getValue();
                int start = position(text, span.path("start"), false),
                    end = position(text, span.path("end"), true);
                if (end < start || !coverage.path("s").has(entry.getKey())) {
                  mappingError = true;
                  continue;
                }
                JsonNode owner = null;
                for (JsonNode unit : units)
                  if (start >= unit.path("bodyStart").asInt()
                      && end <= unit.path("bodyEnd").asInt()
                      && (owner == null
                          || unit.path("end").asInt() - unit.path("start").asInt()
                              < owner.path("end").asInt() - owner.path("start").asInt()))
                    owner = unit;
                if (owner != null)
                  hits.get(owner.path("id").asText())
                      .add(coverage.path("s").path(entry.getKey()).asDouble());
              } catch (IllegalArgumentException error) {
                mappingError = true;
              }
            }
          for (JsonNode unit : units) {
            List<Double> counters = hits.get(unit.path("id").asText());
            String reason =
                report == null
                    ? "No coverage report"
                    : !format.equals("istanbul") || coverage == null
                        ? "No matching Istanbul source coverage"
                        : !fileAligned
                            ? "Missing/stale source provenance"
                            : mappingError
                                ? "Invalid statement source mapping"
                                : counters.isEmpty()
                                    ? "No executable statements mapped to this function"
                                    : null;
            ObjectNode metric = json.createObjectNode();
            for (String key : List.of("id", "name", "line", "complexity"))
              metric.set(key, unit.path(key));
            metric.putNull("coverage").putNull("crap");
            if (reason != null) metric.put("reason", reason);
            else {
              double q = counters.stream().filter(n -> n > 0).count() / (double) counters.size();
              metric.put("coverage", q).put("crap", crap(unit.path("complexity").asDouble(), q));
            }
            functions.add(metric);
          }
          if (units.isEmpty()) item.put("reason", "No executable functions in this file.");
        } catch (IOException error) {
          item.put("reason", "Unsupported or invalid source syntax.");
        }
      }
      for (JsonNode metric : functions)
        if (metric.path("crap").isNumber()) {
          double score = metric.path("crap").asDouble();
          measured++;
          highest = Math.max(highest, score);
          if (score > threshold) above++;
        } else missing++;
    }
    ObjectNode result =
        json.createObjectNode()
            .put("snapshotId", snapshot.path("id").asText())
            .put("format", format)
            .put("capturedAt", dev.leanreview.git.LocalSnapshots.now())
            .put("reportHash", reportHash)
            .put("aligned", aligned && allAligned);
    result.set("files", files);
    result.set("warnings", warnings);
    result.put("threshold", threshold);
    if (measured == 0) result.putNull("highest");
    else result.put("highest", highest);
    result.put("measured", measured).put("missing", missing).put("aboveThreshold", above);
    return result;
  }

  private static String relative(String root, String path) {
    String name = path.replace('\\', '/').replaceFirst("^\\./", ""),
        prefix = root.replace('\\', '/').replaceFirst("/$", "") + "/";
    if (name.regionMatches(true, 0, prefix, 0, prefix.length()))
      return name.substring(prefix.length());
    if (name.startsWith("/")
        || name.matches("^[A-Za-z]:.*")
        || Arrays.asList(name.split("/", -1)).contains("..")) return null;
    return name;
  }

  private static void validateIstanbul(JsonNode file) {
    if (!file.isObject()
        || (file.has("path") && !file.path("path").isTextual())
        || !file.path("statementMap").isObject()
        || !file.path("s").isObject())
      throw new IllegalArgumentException("Invalid Istanbul coverage report.");
    for (JsonNode span : file.path("statementMap")) {
      point(span.path("start"), false);
      point(span.path("end"), true);
    }
    for (JsonNode n : file.path("s"))
      if (!n.isNumber() || !Double.isFinite(n.asDouble()) || n.asDouble() < 0)
        throw new IllegalArgumentException("Invalid Istanbul coverage counter.");
  }

  private static void point(JsonNode point, boolean nullable) {
    if (!point.path("line").isIntegralNumber()
        || !point.path("line").canConvertToInt()
        || point.path("line").asInt() < 1
        || !(nullable && point.path("column").isNull())
            && (!point.path("column").isIntegralNumber()
                || !point.path("column").canConvertToInt()
                || point.path("column").asInt() < 0))
      throw new IllegalArgumentException("Invalid coverage coordinate.");
  }

  private static int position(String text, JsonNode point, boolean nullable) {
    point(point, nullable);
    List<Integer> lines = new ArrayList<>();
    lines.add(0);
    for (int i = 0; i < text.length(); i++) {
      char ch = text.charAt(i);
      if (ch == '\r') {
        if (i + 1 < text.length() && text.charAt(i + 1) == '\n') i++;
        lines.add(i + 1);
      } else if (ch == '\n' || ch == '\u2028' || ch == '\u2029') lines.add(i + 1);
    }
    int index = point.path("line").asInt() - 1;
    if (index >= lines.size()) throw new IllegalArgumentException("Invalid coverage coordinate.");
    int start = lines.get(index),
        end = index + 1 < lines.size() ? lines.get(index + 1) : text.length();
    if (nullable && point.path("column").isNull()) {
      while (end > start && (text.charAt(end - 1) == '\r' || text.charAt(end - 1) == '\n')) end--;
      return end;
    }
    long position = (long) start + point.path("column").asInt();
    if (position > end) throw new IllegalArgumentException("Invalid coverage coordinate.");
    return (int) position;
  }

  private static List<Element> xml(String report) {
    if (Pattern.compile("<!ENTITY|<!DOCTYPE[^>]*\\[", Pattern.CASE_INSENSITIVE)
        .matcher(report)
        .find())
      throw new IllegalArgumentException("Custom XML entities/internal DTDs are not supported.");
    String xml =
        report.replaceAll(
            "<!DOCTYPE\\s+report\\s+PUBLIC\\s+\"-//JACOCO//DTD Report [^\"]+\"\\s+\"[^\"]+\"\\s*>",
            "");
    if (Pattern.compile("<!DOCTYPE", Pattern.CASE_INSENSITIVE).matcher(xml).find())
      throw new IllegalArgumentException("Invalid or unsupported JaCoCo XML.");
    try {
      DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
      factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
      factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
      factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
      factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
      factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
      factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
      factory.setXIncludeAware(false);
      factory.setExpandEntityReferences(false);
      var builder = factory.newDocumentBuilder();
      builder.setErrorHandler(new DefaultHandler());
      Element root = builder.parse(new InputSource(new StringReader(xml))).getDocumentElement();
      if (!root.getTagName().equals("report"))
        throw new IllegalArgumentException("Expected a JaCoCo report element.");
      return children(root, "package");
    } catch (IllegalArgumentException e) {
      throw e;
    } catch (Exception e) {
      throw new IllegalArgumentException("Invalid or unsupported JaCoCo XML.");
    }
  }

  private static List<Element> children(Element parent, String name) {
    List<Element> result = new ArrayList<>();
    for (Node child = parent.getFirstChild(); child != null; child = child.getNextSibling())
      if (child instanceof Element element && element.getTagName().equals(name))
        result.add(element);
    return result;
  }

  private static double[] counter(Element method, String type) {
    List<Element> matches =
        children(method, "counter").stream()
            .filter(e -> e.getAttribute("type").equals(type))
            .toList();
    if (matches.size() != 1) return null;
    Element value = matches.getFirst();
    double missed = number(value.getAttribute("missed"), Double.NaN),
        covered = number(value.getAttribute("covered"), Double.NaN);
    if (!safeInteger(missed) || !safeInteger(covered) || !safeInteger(missed + covered))
      return null;
    return new double[] {missed, covered};
  }

  private static double number(String text, double absent) {
    if (text.isEmpty()) return absent;
    try {
      return Double.parseDouble(text);
    } catch (NumberFormatException e) {
      return Double.NaN;
    }
  }

  private static boolean safeInteger(double n) {
    return Double.isFinite(n) && n >= 0 && n == Math.floor(n) && n <= 9007199254740991d;
  }

  private static void numeric(ObjectNode node, String key, double n) {
    if (Double.isFinite(n)) node.put(key, n);
    else node.putNull(key);
  }
}
