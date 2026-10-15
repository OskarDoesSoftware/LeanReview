package dev.leanreview.codex;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.leanreview.llm.Cancellation;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/** Explicit opt-in, synthetic code only. Uses CLI-owned login without copying or reading tokens. */
@EnabledIfEnvironmentVariable(named = "LEANREVIEW_LIVE_CODEX_DATA", matches = ".+")
class LiveCodexAcceptanceTest {
  @Test
  void subscribedAccountAnalyzesOneSyntheticFileAndReapsItsProcess() throws Exception {
    var json = new ObjectMapper();
    var rpc =
        new CodexRpc(
            json,
            Path.of(System.getenv("LEANREVIEW_LIVE_CODEX_DATA")).resolve("codex"),
            () -> CodexRpc.discover("", System.getenv("PATH")));
    var provider = new CodexProvider(json, rpc);
    try {
      var status = provider.status();
      assertThat(status.path("connected").asBoolean()).isTrue();
      String model = "";
      for (var entry : status.path("models")) {
        if (model.isEmpty() || entry.path("isDefault").asBoolean())
          model = entry.path("model").asText();
      }
      assertThat(model).isNotBlank();
      var config =
          json.createObjectNode()
              .put("provider", "codex")
              .put("endpoint", "https://chatgpt.com/codex")
              .put("model", model)
              .put("contextWindow", 16384)
              .put("maxOutput", 2048)
              .put("localOnly", false);
      var input = json.createObjectNode();
      input
          .putArray("files")
          .addObject()
          .put("id", "synthetic-file")
          .put("path", "example.ts")
          .put("status", "modified")
          .put("diff", "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n");
      var result = provider.infer(config, input, new Cancellation());
      assertThat(result.path("cohorts").isArray()).isTrue();
      assertThat(result.path("cohorts").toString()).contains("synthetic-file");
    } finally {
      provider.close();
      rpc.close();
    }
  }
}
