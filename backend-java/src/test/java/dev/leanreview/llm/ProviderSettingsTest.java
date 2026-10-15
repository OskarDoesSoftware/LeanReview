package dev.leanreview.llm;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

class ProviderSettingsTest {
  final ObjectMapper json = new ObjectMapper();
  final ProviderSettings settings = new ProviderSettings(null, json, null);

  ObjectNode config() {
    return json.createObjectNode()
        .put("provider", "ollama")
        .put("endpoint", "http://127.0.0.1:11434")
        .put("model", "fixture")
        .put("contextWindow", 8192)
        .put("maxOutput", 2048)
        .put("localOnly", true);
  }

  @Test
  void credentialIdentityMatchesTheExistingNodeConfigurationHash() throws Exception {
    assertThat(settings.key(settings.validate(config())))
        .isEqualTo("2cb1e60ef15ab83d630f50c65357417b31282d83a67fb9248c23ecb2ff5265ab");
  }

  @Test
  void rejectsCredentialBearingUrlsRemoteLocalOnlyAndInvalidBudgets() {
    for (String endpoint :
        new String[] {
          "https://user:private-token@example.test",
          "https://example.test?key=private-token",
          "https://example.test#private-token",
          "http://remote.example.test"
        }) {
      ObjectNode config = config().put("endpoint", endpoint).put("localOnly", false);
      assertThatThrownBy(() -> settings.validate(config))
          .hasMessage("Use HTTPS, or HTTP for a loopback endpoint, without embedded credentials.");
    }
    assertThatThrownBy(() -> settings.validate(config().put("model", "fixture:cloud")))
        .hasMessageContaining("Local-only mode requires");
    assertThatThrownBy(() -> settings.validate(config().put("maxOutput", 8192)))
        .hasMessage("Output reservation must be smaller than the context window.");
    assertThatThrownBy(() -> settings.validate(config().put("provider", "codex")))
        .hasMessageContaining("not available in the Java backend yet");
  }
}
