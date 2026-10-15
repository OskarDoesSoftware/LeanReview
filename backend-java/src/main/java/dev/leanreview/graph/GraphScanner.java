package dev.leanreview.graph;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.analysis.AnalysisHelper;
import dev.leanreview.llm.Cancellation;
import dev.leanreview.storage.CapturedArtifacts;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.*;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

@Component
public class GraphScanner {
  private final ObjectMapper json;
  private final AnalysisHelper helper;
  private static final Pattern SOURCE =
      Pattern.compile("\\.(?:[cm]?[jt]sx?|java)$", Pattern.CASE_INSENSITIVE);
  private static final Pattern EXCLUDED =
      Pattern.compile("(^|/)(?:node_modules|\\.git|target|dist|build|coverage|vendor)/");
  private static final Pattern CONFIG =
      Pattern.compile("(^|/)(?:[^/]*[jt]sconfig[^/]*\\.json|package\\.json)$");

  public GraphScanner(ObjectMapper json, AnalysisHelper helper) {
    this.json = json;
    this.helper = helper;
  }

  public ObjectNode initialProgress(PinnedSources source, JsonNode options) {
    List<String> config =
        source.paths.stream()
            .filter(p -> CONFIG.matcher(p).find() && !EXCLUDED.matcher(p).find())
            .toList();
    List<String> eligible =
        source.paths.stream()
            .filter(p -> SOURCE.matcher(p).find() && !EXCLUDED.matcher(p).find())
            .toList();
    ObjectNode value =
        json.createObjectNode()
            .put(
                "phase",
                !config.isEmpty() ? "configuration" : !eligible.isEmpty() ? "reading" : "saving")
            .put("completed", 0)
            .put(
                "total",
                !config.isEmpty()
                    ? config.size()
                    : Math.min(eligible.size(), options.path("maxFiles").asInt()))
            .put("bytes", 0);
    if (!config.isEmpty()) value.put("path", config.getFirst());
    else if (!eligible.isEmpty()) value.put("path", eligible.getFirst());
    return value;
  }

  @FunctionalInterface
  public interface Reader {
    String read(String path) throws IOException;
  }

  private record Pending(ObjectNode node, JsonNode dep) {}

  private record JavaUnit(ObjectNode node, JsonNode unit) {}

  public ObjectNode scan(
      JsonNode snapshot,
      ObjectNode options,
      PinnedSources source,
      Reader reader,
      Cancellation cancel,
      Consumer<ObjectNode> progress)
      throws IOException {
    return new Scan(snapshot, options, source, reader, cancel, progress).run();
  }

  private class Scan {
    final JsonNode snapshot;
    final ObjectNode options;
    final PinnedSources source;
    final Reader reader;
    final Cancellation cancel;
    final Consumer<ObjectNode> progress;
    final LinkedHashMap<String, String> files = new LinkedHashMap<>();
    final LinkedHashMap<String, ObjectNode> nodes = new LinkedHashMap<>();
    final Map<String, String> changed = new HashMap<>();
    final Set<String> edgeIds = new HashSet<>(), warnings = new LinkedHashSet<>();
    final ArrayNode omissions = json.createArrayNode(),
        edges = json.createArrayNode(),
        configuration = json.createArrayNode();
    final List<Pending> pending = new ArrayList<>();
    final List<JavaUnit> java = new ArrayList<>();
    int bytes, scanned, failures;

    Scan(
        JsonNode snapshot,
        ObjectNode options,
        PinnedSources source,
        Reader reader,
        Cancellation cancel,
        Consumer<ObjectNode> progress) {
      this.snapshot = snapshot;
      this.options = options;
      this.source = source;
      this.reader = reader;
      this.cancel = cancel;
      this.progress = progress;
      for (JsonNode f : snapshot.path("files"))
        changed.put(
            f.path(options.path("side").asText().equals("before") ? "oldPath" : "path").asText(),
            f.path("id").asText());
    }

    void update(String phase, int completed, int total, int count, String path) {
      cancel.check();
      ObjectNode value =
          json.createObjectNode()
              .put("phase", phase)
              .put("completed", completed)
              .put("total", total)
              .put("bytes", count);
      if (path != null) value.put("path", path);
      progress.accept(value);
    }

    void omit(String name, String reason) {
      omissions.add(json.createObjectNode().put("path", name).put("reason", reason));
    }

    ObjectNode node(String name, String kind, String language, String path, String label) {
      String id = CapturedArtifacts.digest(kind + ":" + name).substring(0, 24);
      return nodes.computeIfAbsent(
          id,
          key -> {
            ObjectNode n =
                json.createObjectNode()
                    .put("id", id)
                    .put("label", label)
                    .put("kind", kind)
                    .put("language", language);
            if (path != null) {
              n.put("path", path);
              if (changed.containsKey(path)) n.put("fileId", changed.get(path));
            }
            n.put("changed", path != null && changed.containsKey(path));
            return n;
          });
    }

    void edge(ObjectNode from, ObjectNode target, JsonNode dep, String status, String resolver) {
      if (edges.size() >= 200000) {
        warnings.add("Edge cap reached; graph is partial.");
        return;
      }
      String identity =
          from.path("id").asText()
              + ":"
              + target.path("id").asText()
              + ":"
              + dep.path("kind").asText()
              + ":"
              + dep.path("line").asInt()
              + ":"
              + dep.path("specifier").asText()
              + ":"
              + dep.path("typeOnly").asBoolean();
      String id = CapturedArtifacts.digest(identity).substring(0, 24);
      if (!edgeIds.add(id)) return;
      edges.add(
          json.createObjectNode()
              .put("id", id)
              .put("source", from.path("id").asText())
              .put("target", target.path("id").asText())
              .put("kind", dep.path("kind").asText())
              .put("typeOnly", dep.path("typeOnly").asBoolean())
              .put("status", status)
              .put("path", from.path("path").asText())
              .put("line", dep.path("line").asInt())
              .put("specifier", dep.path("specifier").asText())
              .put("resolver", resolver));
    }

    ObjectNode run() throws IOException {
      warnings.add(
          "Incoming relationships cover scanned sources only. Java resolution is bounded source"
              + " analysis, without compiler/classpath or generated-code completeness.");
      if (!source.complete)
        warnings.add(
            "Pinned repository inventory is incomplete or unavailable. Refresh legacy snapshots to"
                + " capture full context.");
      List<String> eligible =
          source.paths.stream()
              .filter(p -> SOURCE.matcher(p).find() && !EXCLUDED.matcher(p).find())
              .toList();
      List<String> configs =
          new ArrayList<>(
              source.paths.stream()
                  .filter(p -> CONFIG.matcher(p).find() && !EXCLUDED.matcher(p).find())
                  .toList());
      Set<String> seen = new HashSet<>();
      int configBytes = 0;
      for (int i = 0; i < configs.size(); i++) {
        String name = configs.get(i);
        update("configuration", seen.size(), configs.size(), configBytes, name);
        if (!seen.add(name)) continue;
        if (configuration.size() >= 500 || configBytes > 2 * 1024 * 1024) {
          warnings.add("Configuration capture limit reached; resolution is partial.");
          break;
        }
        try {
          String text = reader.read(name);
          configBytes += text.getBytes(StandardCharsets.UTF_8).length;
          if (configBytes > 2 * 1024 * 1024) throw new IOException("Configuration byte cap");
          files.put(name, text);
          configuration.add(name);
          if (!name.endsWith("package.json")) {
            JsonNode target =
                helper
                    .call(
                        "configuration",
                        json.createObjectNode().put("file", name).put("text", text),
                        cancel)
                    .path("target");
            if (target.isTextual()) {
              if (source.paths.contains(target.asText())) configs.add(target.asText());
              else warnings.add("Missing captured TS config: " + target.asText());
            }
          }
        } catch (IOException error) {
          omit(name, "Error: " + error.getMessage());
        }
      }
      int attempts = 0;
      boolean byteCap = false;
      for (String name : eligible) {
        update(
            "reading",
            attempts,
            Math.min(eligible.size(), options.path("maxFiles").asInt()),
            bytes,
            name);
        if (attempts >= options.path("maxFiles").asInt()) {
          omit(name, "Source file scan cap reached");
          continue;
        }
        if (byteCap) {
          omit(name, "Source byte scan cap reached");
          continue;
        }
        attempts++;
        try {
          String text = reader.read(name);
          int size = text.getBytes(StandardCharsets.UTF_8).length;
          if (bytes + size > options.path("maxBytes").asInt()) {
            byteCap = true;
            omit(name, "Source byte scan cap reached");
            continue;
          }
          files.put(name, text);
          bytes += size;
        } catch (IOException error) {
          omit(name, error.getMessage());
        }
      }
      ArrayNode inputs = json.createArrayNode();
      for (String name : eligible)
        if (files.containsKey(name))
          inputs.add(json.createObjectNode().put("file", name).put("text", files.get(name)));
      update("parsing", 0, inputs.size(), bytes, null);
      JsonNode extracted =
          helper.call("extractBatch", json.createObjectNode().set("files", inputs), cancel);
      for (JsonNode parsed : extracted) {
        String name = parsed.path("file").asText();
        update("parsing", scanned + failures, inputs.size(), bytes, name);
        // Node creates a TS module before parsing, including failed parse nodes.
        ObjectNode module =
            name.endsWith(".java") ? null : node(name, "module", "ts/js", name, name);
        if (parsed.has("error")) {
          failures++;
          omit(name, parsed.path("error").asText());
          continue;
        }
        if (name.endsWith(".java"))
          for (JsonNode unit : parsed.path("classes")) {
            ObjectNode n =
                node(
                    name + ":" + unit.path("name").asText(),
                    "class",
                    "java",
                    name,
                    unit.path("name").asText());
            n.set("line", unit.path("line"));
            String pkg = unit.path("packageName").asText();
            if (pkg.isEmpty()) pkg = "<default package>";
            ObjectNode p = node(pkg, "package", "java", null, pkg);
            p.put("changed", p.path("changed").asBoolean() || n.path("changed").asBoolean());
            n.set("packageId", p.path("id"));
            java.add(new JavaUnit(n, unit));
          }
        else for (JsonNode dep : parsed.path("dependencies")) pending.add(new Pending(module, dep));
        scanned++;
      }
      ObjectNode resolveInput = json.createObjectNode();
      resolveInput.set("files", json.valueToTree(files));
      resolveInput.set(
          "listed",
          json.valueToTree(
              source.paths.stream().filter(p -> !EXCLUDED.matcher(p).find()).toList()));
      ArrayNode requests = resolveInput.putArray("requests");
      for (Pending p : pending) {
        ObjectNode request = json.createObjectNode();
        request.set("file", p.node.path("path"));
        request.set("specifier", p.dep.path("specifier"));
        request.put("dynamic", p.dep.path("dynamic").asBoolean());
        requests.add(request);
      }
      JsonNode resolution = helper.call("resolve", resolveInput, cancel);
      for (JsonNode warning : resolution.path("warnings")) warnings.add(warning.asText());
      for (int i = 0; i < pending.size(); i++) {
        Pending p = pending.get(i);
        if (edges.size() % 100 == 0)
          update("resolving", edges.size(), pending.size(), bytes, p.node.path("path").asText());
        JsonNode r = resolution.path("resolutions").path(i);
        String spec = p.dep.path("specifier").asText();
        boolean dynamic = p.dep.path("dynamic").asBoolean();
        String target = dynamic || r.path("target").isNull() ? null : r.path("target").asText();
        String status =
            target != null
                ? "resolved"
                : dynamic
                        || r.path("internal").asBoolean()
                        || spec.startsWith(".")
                        || spec.startsWith("/")
                        || spec.startsWith("#")
                    ? "unresolved"
                    : "external";
        edge(
            p.node,
            target != null
                ? node(target, "module", "ts/js", target, target)
                : node(status + ":ts:" + spec, status, "ts/js", null, spec),
            p.dep,
            status,
            target != null
                ? "TypeScript 6.0.3 captured-config module resolution"
                : status.equals("external")
                    ? "Declared external package; target not resolved"
                    : "Unresolved literal/computed source dependency");
      }
      Map<String, List<JavaUnit>> index = new HashMap<>();
      for (JavaUnit item : java)
        index.computeIfAbsent(item.unit.path("name").asText(), k -> new ArrayList<>()).add(item);
      for (JavaUnit item : java)
        for (JsonNode dep : item.unit.path("references")) {
          cancel.check();
          String spec = dep.path("specifier").asText();
          Set<String> candidates = new LinkedHashSet<>();
          String pkg = item.unit.path("packageName").asText();
          for (String candidate :
              List.of(
                  spec,
                  pkg.isEmpty() ? spec : pkg + "." + spec,
                  item.unit.path("name").asText() + "." + spec))
            if (index.containsKey(candidate)) candidates.add(candidate);
          for (JsonNode imp : item.unit.path("references"))
            if (imp.path("kind").asText().equals("import")) {
              String imported = imp.path("specifier").asText(), candidate = null;
              if (imported.endsWith(".*"))
                candidate = imported.substring(0, imported.length() - 1) + spec;
              else {
                String shortName = imported.substring(imported.lastIndexOf('.') + 1);
                if (spec.equals(shortName) || spec.startsWith(shortName + "."))
                  candidate = imported + spec.substring(shortName.length());
              }
              if (candidate != null && index.containsKey(candidate)) candidates.add(candidate);
            }
          if (dep.path("kind").asText().equals("import") && !spec.endsWith(".*")) {
            String prefix = spec;
            while (prefix.contains(".")) {
              prefix = prefix.substring(0, prefix.lastIndexOf('.'));
              if (index.containsKey(prefix)) {
                candidates.add(prefix);
                break;
              }
            }
          }
          List<JavaUnit> matches =
              candidates.size() == 1 ? index.get(candidates.iterator().next()) : List.of();
          ObjectNode target = matches.size() == 1 ? matches.getFirst().node : null;
          if (target != null && target.path("id").equals(item.node.path("id"))) continue;
          String status =
              target != null
                  ? "resolved"
                  : spec.matches("^(java|javax|jdk)\\..*") ? "external" : "unresolved";
          edge(
              item.node,
              target != null ? target : node(status + ":java:" + spec, status, "java", null, spec),
              dep,
              status,
              target != null
                  ? "Tree-sitter Java source declarations, package/import/type context"
                  : status.equals("external")
                      ? "Declared platform dependency; classpath not inspected"
                      : "Unresolved or ambiguous Java source reference; no classpath execution");
        }
      update("saving", scanned, eligible.size(), bytes, null);
      ObjectNode result =
          json.createObjectNode()
              .put("version", 1)
              .put("snapshotId", snapshot.path("id").asText())
              .put("side", options.path("side").asText())
              .put("revision", source.revision)
              .put("capturedAt", dev.leanreview.git.LocalSnapshots.now());
      result.set("options", options);
      result.set("nodes", json.valueToTree(nodes.values()));
      result.set("edges", edges);
      result.set("cycles", cycles(nodes.keySet(), edges));
      ObjectNode coverage =
          result
              .putObject("coverage")
              .put("listed", source.paths.size())
              .put("eligible", eligible.size())
              .put("scanned", scanned)
              .put("skipped", eligible.size() - scanned)
              .put("bytes", bytes)
              .put("parserFailures", failures);
      int unresolved = 0;
      for (JsonNode e : edges) if (e.path("status").asText().equals("unresolved")) unresolved++;
      coverage
          .put("unresolved", unresolved)
          .put("incoming", "scanned sources only")
          .put(
              "complete",
              source.complete
                  && scanned == eligible.size()
                  && failures == 0
                  && omissions.isEmpty()
                  && warnings.stream()
                      .noneMatch(
                          w ->
                              Pattern.compile(
                                      "cap reached|limit reached|Missing"
                                          + " captured|Unsupported|Invalid")
                                  .matcher(w)
                                  .find()));
      coverage.set("omissions", omissions);
      coverage.set("warnings", json.valueToTree(warnings));
      ObjectNode provenance =
          result
              .putObject("provenance")
              .put("typescript", "TypeScript 6.0.3 source/module resolver")
              .put(
                  "java",
                  "Tree-sitter Java 0.20.2 grammar via tree-sitter-wasms 0.1.13 / runtime 0.20.8");
      provenance.set("configuration", configuration);
      return result;
    }
  }

  private ArrayNode cycles(Set<String> nodes, ArrayNode edges) {
    Map<String, List<String>> out = new LinkedHashMap<>(), incoming = new LinkedHashMap<>();
    for (String id : nodes) {
      out.put(id, new ArrayList<>());
      incoming.put(id, new ArrayList<>());
    }
    for (JsonNode edge : edges)
      if (edge.path("status").asText().equals("resolved")) {
        String a = edge.path("source").asText(), b = edge.path("target").asText();
        out.get(a).add(b);
        incoming.get(b).add(a);
      }
    Set<String> visited = new HashSet<>();
    List<String> order = new ArrayList<>();
    record Frame(String id, boolean done) {}
    for (String n : nodes) {
      if (visited.contains(n)) continue;
      Deque<Frame> stack = new ArrayDeque<>();
      stack.push(new Frame(n, false));
      while (!stack.isEmpty()) {
        Frame frame = stack.pop();
        if (frame.done) {
          order.add(frame.id);
          continue;
        }
        if (!visited.add(frame.id)) continue;
        stack.push(new Frame(frame.id, true));
        for (String next : out.get(frame.id))
          if (!visited.contains(next)) stack.push(new Frame(next, false));
      }
    }
    visited.clear();
    Collections.reverse(order);
    ArrayNode result = json.createArrayNode();
    for (String n : order) {
      if (!visited.add(n)) continue;
      List<String> group = new ArrayList<>();
      Deque<String> stack = new ArrayDeque<>();
      stack.push(n);
      while (!stack.isEmpty()) {
        String id = stack.pop();
        group.add(id);
        for (String next : incoming.get(id)) if (visited.add(next)) stack.push(next);
      }
      if (group.size() > 1 || out.get(n).contains(n)) {
        Collections.sort(group);
        result.add(json.valueToTree(group));
      }
    }
    return result;
  }
}
