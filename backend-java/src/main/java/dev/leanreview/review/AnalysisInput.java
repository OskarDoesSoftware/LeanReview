package dev.leanreview.review;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.storage.CapturedArtifacts;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

@Service
public class AnalysisInput {
  private final ObjectMapper json;
  private static final Pattern EXCLUDED =
      Pattern.compile(
          "(^|/)(node_modules|vendor|dist|build|coverage)(/|$)|\\.(lock|min\\.js|map)$|package-lock\\.json$");

  public AnalysisInput(ObjectMapper json) {
    this.json = json;
  }

  public record Prepared(ObjectNode manifest, List<ObjectNode> batches) {}

  private int bytes(JsonNode value) throws IOException {
    return json.writeValueAsBytes(value).length;
  }

  public Prepared prepare(JsonNode snapshot, ObjectNode config) throws IOException {
    long usedBytes = 0;
    ArrayNode bodies = json.createArrayNode(),
        files = json.createArrayNode(),
        fingerprints = json.createArrayNode();
    for (JsonNode file : snapshot.path("files")) {
      String patch = file.path("patch").asText(), path = file.path("path").asText();
      int size = patch.getBytes(StandardCharsets.UTF_8).length;
      String reason =
          EXCLUDED.matcher(path).find()
              ? "Generated/vendor file excluded"
              : patch.isEmpty()
                  ? "No text diff"
                  : size > 128 * 1024
                      ? "Per-file context limit"
                      : usedBytes + size > 2 * 1024 * 1024 ? "Total context limit" : null;
      if (reason == null) usedBytes += size;
      ObjectNode body =
          bodies
              .addObject()
              .put("id", file.path("id").asText())
              .put("path", path)
              .put("status", file.path("status").asText())
              .put("diff", reason == null ? patch : "")
              .put("before", file.path("before").path("kind").asText())
              .put("after", file.path("after").path("kind").asText());
      body.put("omitted", reason);
      ObjectNode item =
          files
              .addObject()
              .put("id", file.path("id").asText())
              .put("path", path)
              .put("included", reason == null);
      if (reason != null) item.put("reason", reason);
      fingerprints.add(file.path("fingerprint"));
    }
    int budget =
        (int)
            Math.floor(
                Math.min(
                        config.path("contextWindow").asDouble() * .75,
                        config.path("contextWindow").asDouble()
                            - config.path("maxOutput").asDouble())
                    - 1024);
    if (budget < 256)
      throw new IllegalArgumentException(
          "Context window is too small for the configured output reservation.");
    ArrayNode identity =
        json.createArrayNode().add(snapshot.path("id")).add(config).add(fingerprints);
    ObjectNode manifest =
        json.createObjectNode()
            .put("id", CapturedArtifacts.digest(json.writeValueAsString(identity)))
            .put("snapshotId", snapshot.path("id").asText());
    manifest.set("config", config.deepCopy());
    manifest.set("files", files);
    manifest.put("estimatedTokens", bytes(bodies)).put("inputBudget", budget);
    List<ObjectNode> batches = new ArrayList<>();
    ArrayNode batch = json.createArrayNode();
    int used = 0;
    for (int i = 0; i < bodies.size(); i++) {
      ObjectNode body = (ObjectNode) bodies.get(i);
      int size = bytes(body);
      if (size > budget) {
        body.put("diff", "").put("omitted", "Model input budget");
        ((ObjectNode) files.get(i)).put("included", false).put("reason", "Model input budget");
        size = bytes(body);
      }
      if (size > budget)
        throw new IllegalArgumentException("File metadata exceeds model input budget.");
      if (!batch.isEmpty() && (batch.size() >= 20 || used + size > budget)) {
        ObjectNode value = json.createObjectNode();
        value.set("files", batch);
        batches.add(value);
        batch = json.createArrayNode();
        used = 0;
      }
      batch.add(body);
      used += size;
    }
    if (!batch.isEmpty()) {
      ObjectNode value = json.createObjectNode();
      value.set("files", batch);
      batches.add(value);
    }
    return new Prepared(manifest, List.copyOf(batches));
  }
}
