package dev.leanreview.llm;

import com.fasterxml.jackson.databind.JsonNode;

public interface ProviderInference {
  JsonNode infer(JsonNode config, String token, JsonNode input, Cancellation cancellation)
      throws Exception;

  default JsonNode infer(
      JsonNode config,
      String token,
      JsonNode input,
      Cancellation cancellation,
      java.util.function.Consumer<String> progress)
      throws Exception {
    return infer(config, token, input, cancellation);
  }
}
