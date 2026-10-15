package dev.leanreview.api;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.LeanReviewApplication;
import dev.leanreview.analysis.AnalysisHelper;
import dev.leanreview.credentials.CredentialVault;
import dev.leanreview.review.ReviewAnalysis;
import dev.leanreview.storage.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.support.*;
import org.springframework.boot.builder.SpringApplicationBuilder;

class CodexApiTest {
  @TempDir Path directory;
  final ObjectMapper json = new ObjectMapper();
  final HttpClient client = HttpClient.newHttpClient();
  String origin, cookie;

  record Reply(int status, JsonNode body) {}

  Reply call(String route, JsonNode body) throws Exception {
    var request =
        HttpRequest.newBuilder(URI.create(origin + "/api" + route))
            .timeout(Duration.ofSeconds(40))
            .header("Origin", origin)
            .header("Content-Type", "application/json");
    if (cookie != null) request.header("Cookie", cookie);
    request.method(
        body == null ? "GET" : "POST",
        body == null
            ? HttpRequest.BodyPublishers.noBody()
            : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
    var response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    if (response.headers().firstValue("Set-Cookie").isPresent())
      cookie = response.headers().firstValue("Set-Cookie").get().split(";")[0];
    assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
    assertThat(response.body()).doesNotContain("fixture-only-secret-login-token");
    return new Reply(response.statusCode(), json.readTree(response.body()));
  }

  @ParameterizedTest
  @ValueSource(strings = {"success", "exhausted", "hang"})
  void protectedSubscriptionAnalysisPreservesHumanWorkAndRequiresAuthorization(String scenario)
      throws Exception {
    Path data = directory.resolve("data"),
        source = Path.of("../tests/fixtures/backend-compatibility/databases/v3"),
        log = directory.resolve("protocol.jsonl");
    try (var files = Files.walk(source)) {
      for (Path file : files.toList()) {
        Path target = data.resolve(source.relativize(file));
        if (Files.isDirectory(file)) Files.createDirectories(target);
        else Files.copy(file, target);
      }
    }
    int port;
    try (var socket = new java.net.ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
      port = socket.getLocalPort();
    }
    origin = "http://127.0.0.1:" + port;
    cookie = null;
    AtomicInteger vaultCalls = new AtomicInteger();
    List<String> command =
        List.of(
            AnalysisHelper.executable("node"),
            Path.of("../tests/fixtures/java-codex-app-server.mjs").toAbsolutePath().toString(),
            scenario,
            log.toString());
    try (var context =
        new SpringApplicationBuilder(LeanReviewApplication.class)
            .initializers(
                application -> {
                  BeanDefinitionRegistry registry =
                      (BeanDefinitionRegistry) application.getBeanFactory();
                  var vault = new RootBeanDefinition(CredentialVault.Persistent.class);
                  vault.setInstanceSupplier(
                      () ->
                          new CredentialVault.Persistent() {
                            public void set(String account, String token) {
                              vaultCalls.incrementAndGet();
                              throw new IllegalStateException();
                            }

                            public String get(String account) {
                              vaultCalls.incrementAndGet();
                              throw new IllegalStateException();
                            }
                          });
                  vault.setPrimary(true);
                  registry.registerBeanDefinition("forbiddenApiKeyVault", vault);
                })
            .run(
                "--spring.main.web-application-type=servlet",
                "--server.port=" + port,
                "--leanreview.origin=" + origin,
                "--leanreview.data-directory=" + data,
                "--leanreview.codex.command=" + json.writeValueAsString(command),
                "--logging.level.root=ERROR",
                "--spring.main.banner-mode=off")) {
      for (String route : List.of("status", "login", "cancel-login", "logout"))
        assertThat(
                call("/codex/" + route, route.equals("status") ? null : json.createObjectNode())
                    .status)
            .isEqualTo(401);
      assertThat(Files.exists(log)).isFalse();
      String nonce = context.getBean(LocalAccess.class).startupLink().split("bootstrap=")[1];
      assertThat(call("/session", json.createObjectNode().put("nonce", nonce)).status)
          .isEqualTo(200);
      assertThat(call("/codex/status", null).body.path("connected").asBoolean()).isTrue();
      ObjectNode
          config =
              json.createObjectNode()
                  .put("provider", "codex")
                  .put("endpoint", "https://ignored.example")
                  .put("model", "fixture-codex")
                  .put("contextWindow", 8192)
                  .put("maxOutput", 2048)
                  .put("localOnly", false),
          body = json.createObjectNode().put("persist", false);
      body.set("config", config);
      body.put("token", "forbidden-key");
      assertThat(call("/provider", body).status).isEqualTo(400);
      body.remove("token");
      assertThat(call("/provider", body).body.path("config").path("endpoint").asText())
          .isEqualTo("https://chatgpt.com/codex");
      ReviewStore reviews = context.getBean(ReviewStore.class);
      JsonNode initial = reviews.review("session-fixture", null);
      ObjectNode grouping = json.createObjectNode();
      ObjectNode layer =
          grouping
              .putArray("cohorts")
              .addObject()
              .put("name", "Human grouping")
              .put("explanation", "Accepted work")
              .putArray("layers")
              .addObject()
              .put("name", "Read")
              .put("explanation", "Manual");
      ArrayNode ids = layer.putArray("fileIds");
      initial.path("snapshot").path("files").forEach(file -> ids.add(file.path("id").asText()));
      grouping.putArray("findings");
      reviews.updateCurrentState(
          "session-fixture",
          "snapshot-current",
          state -> {
            state.set("accepted", grouping);
            state.put("futureHumanEdit", "retained");
          });
      JsonNode drafts =
          reviews.review("session-fixture", null).path("state").path("drafts").deepCopy();
      JsonNode manifest = call("/sessions/session-fixture/manifest", null).body;
      ObjectNode authorize =
          json.createObjectNode()
              .put("snapshotId", "snapshot-current")
              .put("manifestId", manifest.path("id").asText())
              .put("authorize", false);
      assertThat(call("/sessions/session-fixture/analysis", authorize).status).isEqualTo(400);
      assertThat(Files.readString(log)).doesNotContain("src/choose.ts", "turn/start");
      authorize.put("authorize", true);
      assertThat(call("/sessions/session-fixture/analysis", authorize).status).isEqualTo(202);
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
      if (scenario.equals("hang")) {
        while (!Files.readString(log).contains("turn/start") && System.nanoTime() < deadline)
          Thread.sleep(20);
        assertThat(
                call(
                        "/sessions/session-fixture/cancel",
                        json.createObjectNode().put("snapshotId", "snapshot-current"))
                    .status)
            .isEqualTo(200);
        ObjectNode next = (ObjectNode) reviews.review("session-fixture", null).path("snapshot");
        next.put("id", "refreshed-codex");
        context.getBean(CoreSnapshots.class).refresh("session-fixture", "snapshot-current", next);
        context.getBean(ReviewAnalysis.class).close();
        assertThat(
                reviews
                    .review("session-fixture", null)
                    .path("state")
                    .path("analysisStatus")
                    .asText())
            .isEqualTo("idle");
        assertThat(reviews.review("session-fixture", null).path("state").path("proposal").isNull())
            .isTrue();
      } else {
        JsonNode state;
        do {
          Thread.sleep(20);
          state = reviews.review("session-fixture", null).path("state");
        } while (state.path("analysisStatus").asText().equals("running")
            && System.nanoTime() < deadline);
        assertThat(state.path("accepted")).isEqualTo(grouping);
        assertThat(state.path("drafts")).isEqualTo(drafts);
        assertThat(state.path("futureHumanEdit").asText()).isEqualTo("retained");
        if (scenario.equals("success")) {
          assertThat(state.path("analysisStatus").asText()).isEqualTo("ready");
          assertThat(
                  state
                      .path("proposal")
                      .path("cohorts")
                      .get(0)
                      .path("layers")
                      .get(0)
                      .path("fileIds"))
              .hasSize(initial.path("snapshot").path("files").size());
          assertThat(state.path("analysisProgress").path("completedFiles").asInt())
              .isEqualTo(initial.path("snapshot").path("files").size());
        } else {
          assertThat(state.path("analysisStatus").asText()).isEqualTo("failed");
          assertThat(state.path("analysisError").asText()).contains("allowance is exhausted");
          assertThat(Files.readString(log)).doesNotContain("turn/start");
        }
      }
      assertThat(vaultCalls.get()).isZero();
    }
    long pid = json.readTree(Files.readAllLines(log).getFirst()).path("pid").asLong();
    assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
    try (var files = Files.walk(data)) {
      for (Path file : files.filter(Files::isRegularFile).toList())
        assertThat(new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1))
            .doesNotContain("fixture-only-secret-login-token", "forbidden-key");
    }
  }
}
