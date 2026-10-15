package dev.leanreview.analysis;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.coverage.CoverageMetrics;
import dev.leanreview.graph.*;
import dev.leanreview.llm.Cancellation;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.Test;

class AnalysisCompatibilityTest {
  private final ObjectMapper json = new ObjectMapper();
  private final AnalysisHelper helper = new AnalysisHelper(json, "node", "helper/dist/index.js");

  @Test
  void pinnedParsersAndComplexityMatchFrozenBaseline() throws Exception {
    JsonNode fixture =
        json.readTree(Path.of("../tests/fixtures/backend-compatibility/parsers.json").toFile());
    Cancellation cancel = new Cancellation();
    JsonNode ts = fixture.path("typescript");
    assertThat(
            helper
                .call(
                    "extract",
                    json.createObjectNode()
                        .put("file", ts.path("file").asText())
                        .put("text", ts.path("text").asText()),
                    cancel)
                .path("dependencies"))
        .isEqualTo(ts.path("dependencies"));
    assertThat(
            helper
                .call(
                    "extract",
                    json.createObjectNode()
                        .put("file", "Fixture.java")
                        .put("text", fixture.path("java").path("text").asText()),
                    cancel)
                .path("classes"))
        .isEqualTo(fixture.path("java").path("classes"));
    JsonNode complexity = fixture.path("complexity");
    JsonNode units =
        helper
            .call(
                "complexity",
                json.createObjectNode()
                    .put("file", complexity.path("file").asText())
                    .put("text", complexity.path("text").asText()),
                cancel)
            .path("units");
    assertThat(units).isEqualTo(complexity.path("units"));
  }

  @Test
  void graphsAndCoverageMatchNodeReferenceIncludingPartialScansAndStaleReports() throws Exception {
    JsonNode fixture = json.readTree(Path.of("../tests/fixtures/java-analysis.json").toFile()),
        snapshot = fixture.path("snapshot");
    for (JsonNode expected : fixture.path("graphs")) {
      Cancellation cancel = new Cancellation();
      try (PinnedSources sources =
          new PinnedSources(snapshot, expected.path("side").asText(), json, cancel)) {
        ObjectNode actual =
            new GraphScanner(json, helper)
                .scan(
                    snapshot,
                    (ObjectNode) expected.path("options"),
                    sources,
                    sources::read,
                    cancel,
                    value -> {});
        assertThat(actual.path("capturedAt").asText())
            .matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z");
        actual.put("capturedAt", "<timestamp>");
        assertThat(actual).isEqualTo(expected);
      }
    }
    CoverageMetrics measure = new CoverageMetrics(json, helper);
    for (JsonNode item : fixture.path("coverage")) {
      ObjectNode actual =
          measure.measure(
              snapshot,
              item.path("format").asText(),
              item.path("report").asText(),
              item.path("provenance"),
              8,
              new Cancellation());
      actual.put("capturedAt", "<timestamp>");
      assertThat(canonical(actual)).isEqualTo(canonical(item.path("metrics")));
    }
  }

  private JsonNode canonical(JsonNode value) {
    if (value.isNumber())
      return json.getNodeFactory().numberNode(value.decimalValue().stripTrailingZeros());
    if (value.isObject()) {
      ObjectNode result = json.createObjectNode();
      value.properties().forEach(e -> result.set(e.getKey(), canonical(e.getValue())));
      return result;
    }
    if (value.isArray()) {
      ArrayNode result = json.createArrayNode();
      value.forEach(e -> result.add(canonical(e)));
      return result;
    }
    return value;
  }

  @Test
  void rejectsEntitiesInvalidCountersAndCanceledHelper() throws Exception {
    JsonNode snapshot =
        json.readTree(Path.of("../tests/fixtures/java-analysis.json").toFile()).path("snapshot");
    CoverageMetrics metrics = new CoverageMetrics(json, helper);
    assertThatThrownBy(
            () ->
                metrics.measure(
                    snapshot,
                    "jacoco",
                    "<!DOCTYPE report [<!ENTITY x SYSTEM 'file:///secret'>]><report/>",
                    null,
                    8,
                    new Cancellation()))
        .hasMessageContaining("entities");
    assertThatThrownBy(
            () ->
                metrics.measure(
                    snapshot,
                    "jacoco",
                    "<!DOCTYPE report SYSTEM 'http://127.0.0.1/secret'><report/>",
                    null,
                    8,
                    new Cancellation()))
        .hasMessageContaining("unsupported");
    assertThatThrownBy(
            () ->
                metrics.measure(
                    snapshot,
                    "istanbul",
                    "{\"src/a.ts\":{\"s\":{\"0\":-1},\"statementMap\":{}}}",
                    null,
                    8,
                    new Cancellation()))
        .hasMessageContaining("counter");
    Cancellation canceled = new Cancellation();
    canceled.cancel();
    assertThatThrownBy(() -> helper.call("complexity", json.createObjectNode(), canceled))
        .hasMessageContaining("canceled");
  }
}
