package dev.leanreview.llm;

import com.fasterxml.jackson.databind.JsonNode;

public interface ProviderInference {
  JsonNode infer(JsonNode config, String token, JsonNode input, Cancellation cancellation)
      throws Exception;
}
