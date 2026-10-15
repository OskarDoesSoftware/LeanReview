package dev.leanreview.review;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class AnalysisInputTest {
  private final ObjectMapper json = new ObjectMapper();

  @Test
  void manifestMatchesFrozenNodeContractExactly() throws Exception {
    JsonNode http =
        json.readTree(Path.of("../tests/fixtures/backend-compatibility/http.json").toFile());
    JsonNode snapshot = null, expected = null;
    for (JsonNode item : http) {
      if (item.path("name").asText().equals("recovered review"))
        snapshot = item.path("response").path("body").path("snapshot");
      if (item.path("name").asText().equals("manifest"))
        expected = item.path("response").path("body");
    }
    var prepared = new AnalysisInput(json).prepare(snapshot, (ObjectNode) expected.path("config"));
    assertThat(prepared.manifest()).isEqualTo(expected);
    assertThat(prepared.batches()).hasSize(1);
  }

  @Test
  void exclusionsBudgetsAndSequentialTwentyFileBatchesRemainBounded() throws Exception {
    ObjectNode snapshot = json.createObjectNode().put("id", "snapshot");
    ArrayNode files = snapshot.putArray("files");
    for (int i = 0; i < 43; i++) {
      var file =
          files
              .addObject()
              .put("id", "f" + i)
              .put("path", i == 0 ? "vendor/generated.ts" : "src/f" + i + ".ts")
              .put("status", "added")
              .put("fingerprint", "fp" + i)
              .put("patch", "+const x = 1;\n");
      file.putObject("before").put("kind", "absent");
      file.putObject("after").put("kind", "text");
    }
    ObjectNode config =
        json.createObjectNode()
            .put("provider", "ollama")
            .put("endpoint", "http://localhost:11434")
            .put("model", "fixture")
            .put("contextWindow", 8192)
            .put("maxOutput", 2048)
            .put("localOnly", true);
    var prepared = new AnalysisInput(json).prepare(snapshot, config);
    assertThat(prepared.manifest().path("files").get(0).path("reason").asText())
        .isEqualTo("Generated/vendor file excluded");
    assertThat(prepared.batches()).hasSize(3);
    for (var batch : prepared.batches())
      assertThat(batch.path("files").size()).isLessThanOrEqualTo(20);
    ((ObjectNode) files.get(1)).put("patch", "x".repeat(128 * 1024 + 1));
    var omitted = new AnalysisInput(json).prepare(snapshot, config);
    assertThat(omitted.manifest().path("files").get(1).path("reason").asText())
        .isEqualTo("Per-file context limit");
    config.put("contextWindow", 1024).put("maxOutput", 256);
    assertThatThrownBy(() -> new AnalysisInput(json).prepare(snapshot, config))
        .hasMessageContaining("Context window is too small");
  }
}
