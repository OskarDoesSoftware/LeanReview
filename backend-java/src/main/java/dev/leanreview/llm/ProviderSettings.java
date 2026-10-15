package dev.leanreview.llm;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.api.WireInput;
import dev.leanreview.credentials.CredentialVault;
import dev.leanreview.storage.*;
import java.io.IOException;
import java.net.URI;
import java.util.Set;
import org.springframework.stereotype.Service;

@Service
public class ProviderSettings {
  private final CoreSnapshots storage;
  private final ObjectMapper json;
  private final CredentialVault vault;

  public ProviderSettings(CoreSnapshots storage, ObjectMapper json, CredentialVault vault) {
    this.storage = storage;
    this.json = json;
    this.vault = vault;
  }

  public ObjectNode current() throws IOException {
    JsonNode value = storage.setting("provider");
    if (value.isNull()) throw new IllegalArgumentException("Configure an LLM provider first.");
    return validate(value);
  }

  public String key(JsonNode config) throws IOException {
    return CapturedArtifacts.digest(json.writeValueAsString(config));
  }

  public String token(JsonNode config) throws IOException {
    if (config.path("provider").asText().equals("codex")) return null;
    String key = key(config);
    return vault.get(key, storage.setting("credential-mode:" + key).asText().equals("os"));
  }

  public ObjectNode configure(JsonNode body) throws IOException {
    WireInput.object(body);
    ObjectNode config = validate(body.path("config"));
    if (!body.path("persist").isBoolean())
      throw WireInput.invalid("boolean", body.path("persist"), "persist");
    String token = body.has("token") ? WireInput.text(body, "token", 0, 10000, false) : "";
    if (config.path("provider").asText().equals("codex") && !token.isEmpty())
      throw new IllegalArgumentException(
          "Codex subscription mode does not accept API keys. Sign in with ChatGPT.");
    if (!token.isEmpty()) {
      boolean persist = body.path("persist").asBoolean();
      String key = key(config);
      vault.set(key, token, persist);
      storage.setting(
          "credential-mode:" + key, json.getNodeFactory().textNode(persist ? "os" : "session"));
    }
    storage.setting("provider", config);
    ObjectNode result = json.createObjectNode();
    result.set("config", config);
    return result;
  }

  public ObjectNode validate(JsonNode input) {
    WireInput.object(input);
    String provider = WireInput.choice(input, "provider", "ollama", "openai", "anthropic", "codex");
    String endpoint = WireInput.text(input, "endpoint"),
        model = WireInput.text(input, "model", 1, 200, false);
    if (provider.equals("codex")) endpoint = "https://chatgpt.com/codex";
    int context = bounded(input, "contextWindow", 1024, 2000000),
        output = bounded(input, "maxOutput", 256, 128000);
    boolean local = false;
    if (input.has("localOnly")) {
      if (!input.path("localOnly").isBoolean())
        throw WireInput.invalid("boolean", input.path("localOnly"), "localOnly");
      local = input.path("localOnly").asBoolean();
    }
    URI url;
    try {
      url = URI.create(endpoint);
    } catch (IllegalArgumentException invalid) {
      throw new IllegalArgumentException("Invalid provider endpoint.");
    }
    boolean loopback =
        Set.of("127.0.0.1", "localhost", "[::1]", "::1")
            .contains(url.getHost() == null ? "" : url.getHost());
    if (url.getHost() == null
        || url.getRawUserInfo() != null
        || url.getRawQuery() != null
        || url.getRawFragment() != null
        || !("https".equals(url.getScheme()) || "http".equals(url.getScheme()) && loopback))
      throw new IllegalArgumentException(
          "Use HTTPS, or HTTP for a loopback endpoint, without embedded credentials.");
    if (output >= context)
      throw new IllegalArgumentException(
          "Output reservation must be smaller than the context window.");
    if (local && (!provider.equals("ollama") || !loopback || model.contains(":cloud")))
      throw new IllegalArgumentException(
          "Local-only mode requires loopback Ollama and a local model with cloud features"
              + " disabled.");
    return json.createObjectNode()
        .put("provider", provider)
        .put("endpoint", endpoint)
        .put("model", model)
        .put("contextWindow", context)
        .put("maxOutput", output)
        .put("localOnly", local);
  }

  private int bounded(JsonNode value, String key, int min, int max) {
    int result = WireInput.positive(value, key, 0);
    if (result < min || result > max) throw new IllegalArgumentException("Invalid " + key + ".");
    return result;
  }
}
