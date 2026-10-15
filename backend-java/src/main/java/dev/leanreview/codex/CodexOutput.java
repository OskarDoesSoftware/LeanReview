package dev.leanreview.codex;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.util.*;

/** Required per-file assignments make membership total and independent of JSON property order. */
public final class CodexOutput {
  public static final String INSTRUCTIONS =
      "Return fileAssignments with exactly one required entry for every supplied file ID. Each"
          + " entry chooses cohortName, cohortExplanation, layerName, layerExplanation, and a"
          + " readingOrder rank starting at zero. Reuse the exact cohort and layer names for files"
          + " that belong together. Rank files in the suggested dependency-informed reading order."
          + " Findings may reference only supplied IDs.";
  private final ObjectMapper json;
  private final List<String> ids = new ArrayList<>();

  public CodexOutput(ObjectMapper json, JsonNode input) throws CodexFailure {
    this.json = json;
    if (!input.path("files").isArray() || input.path("files").isEmpty()) throw invalid();
    for (JsonNode file : input.path("files")) {
      if (!file.path("id").isTextual() || file.path("id").asText().isEmpty()) throw invalid();
      ids.add(file.path("id").asText());
    }
    if (new HashSet<>(ids).size() != ids.size())
      throw new CodexFailure("Analysis input contains duplicate file IDs.");
  }

  private ObjectNode object() {
    return json.createObjectNode().put("type", "object");
  }

  private ObjectNode string() {
    return json.createObjectNode().put("type", "string");
  }

  public ObjectNode schema() {
    ObjectNode result = object(),
        properties = result.putObject("properties"),
        assignments = object(),
        fields = assignments.putObject("properties");
    for (String id : ids) {
      ObjectNode assignment = object(), props = assignment.putObject("properties");
      for (String key : List.of("cohortName", "cohortExplanation", "layerName", "layerExplanation"))
        props.set(key, string());
      props.set("readingOrder", json.createObjectNode().put("type", "integer"));
      assignment
          .putArray("required")
          .add("cohortName")
          .add("cohortExplanation")
          .add("layerName")
          .add("layerExplanation")
          .add("readingOrder");
      assignment.put("additionalProperties", false);
      fields.set(id, assignment);
    }
    assignments.set("required", json.valueToTree(ids));
    assignments.put("additionalProperties", false);
    properties.set("fileAssignments", assignments);
    ObjectNode finding = object(), props = finding.putObject("properties"), fileId = string();
    fileId.set("enum", json.valueToTree(ids));
    props.set("fileId", fileId);
    ObjectNode line = json.createObjectNode();
    line.putArray("anyOf")
        .add(json.createObjectNode().put("type", "integer").put("exclusiveMinimum", 0))
        .add(json.createObjectNode().put("type", "null"));
    props.set("line", line);
    ObjectNode kind = string();
    kind.putArray("enum").add("bug").add("security").add("performance").add("improvement");
    props.set("kind", kind);
    props.set("message", string());
    finding.putArray("required").add("fileId").add("line").add("kind").add("message");
    finding.put("additionalProperties", false);
    ObjectNode findings = json.createObjectNode().put("type", "array");
    findings.set("items", finding);
    properties.set("findings", findings);
    result.putArray("required").add("fileAssignments").add("findings");
    result.put("additionalProperties", false);
    return result;
  }

  public ObjectNode parse(JsonNode value) throws CodexFailure {
    exact(value, Set.of("fileAssignments", "findings"));
    JsonNode assignments = value.path("fileAssignments");
    exact(assignments, new HashSet<>(ids));
    for (String id : ids) {
      JsonNode item = assignments.path(id);
      exact(
          item,
          Set.of(
              "cohortName", "cohortExplanation", "layerName", "layerExplanation", "readingOrder"));
      for (String key :
          List.of("cohortName", "cohortExplanation", "layerName", "layerExplanation")) {
        int max = key.endsWith("Name") ? 100 : 2000;
        JsonNode text = item.path(key);
        if (!text.isTextual()
            || text.asText().length() > max
            || key.endsWith("Name") && text.asText().isEmpty()) throw invalid();
      }
      JsonNode rank = item.path("readingOrder");
      if (!rank.isNumber()
          || rank.asDouble() != Math.floor(rank.asDouble())
          || rank.asDouble() < 0
          || rank.asDouble() >= ids.size()) throw invalid();
    }
    if (!value.path("findings").isArray()) throw invalid();
    for (JsonNode finding : value.path("findings")) {
      exact(finding, Set.of("fileId", "line", "kind", "message"));
      if (!ids.contains(finding.path("fileId").asText())
          || !Set.of("bug", "security", "performance", "improvement")
              .contains(finding.path("kind").asText())
          || !finding.path("message").isTextual()
          || finding.path("message").asText().isEmpty()
          || finding.path("message").asText().length() > 4000) throw invalid();
      JsonNode line = finding.path("line");
      if (!line.isNull()
          && (!line.isNumber()
              || line.asDouble() != Math.floor(line.asDouble())
              || line.asDouble() < 1
              || line.asDouble() > 9007199254740991d)) throw invalid();
    }
    List<String> ordered = new ArrayList<>(ids);
    ordered.sort(
        Comparator.comparingDouble(id -> assignments.path(id).path("readingOrder").asDouble()));
    ObjectNode result = json.createObjectNode();
    ArrayNode cohorts = result.putArray("cohorts");
    for (String id : ordered) {
      JsonNode item = assignments.path(id);
      ObjectNode cohort = null;
      for (JsonNode existing : cohorts)
        if (existing.path("name").equals(item.path("cohortName"))) cohort = (ObjectNode) existing;
      if (cohort == null) {
        cohort =
            cohorts
                .addObject()
                .put("name", item.path("cohortName").asText())
                .put("explanation", item.path("cohortExplanation").asText());
        cohort.putArray("layers");
      }
      ArrayNode layers = (ArrayNode) cohort.path("layers");
      ObjectNode layer = null;
      for (JsonNode existing : layers)
        if (existing.path("name").equals(item.path("layerName"))) layer = (ObjectNode) existing;
      if (layer == null) {
        layer =
            layers
                .addObject()
                .put("name", item.path("layerName").asText())
                .put("explanation", item.path("layerExplanation").asText());
        layer.putArray("fileIds");
      }
      ((ArrayNode) layer.path("fileIds")).add(id);
    }
    ArrayNode findings = result.putArray("findings");
    for (JsonNode finding : value.path("findings")) {
      ObjectNode copy = (ObjectNode) finding.deepCopy();
      if (copy.path("line").isNumber()) copy.put("line", copy.path("line").asLong());
      findings.add(copy);
    }
    return result;
  }

  private void exact(JsonNode value, Set<String> keys) throws CodexFailure {
    if (!value.isObject() || value.size() != keys.size()) throw invalid();
    for (String key : keys) if (!value.has(key)) throw invalid();
  }

  private CodexFailure invalid() {
    return new CodexFailure(
        "Codex returned an invalid structured analysis. The accepted review was preserved.");
  }
}
