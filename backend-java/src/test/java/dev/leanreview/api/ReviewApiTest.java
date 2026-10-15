package dev.leanreview.api;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.leanreview.LeanReviewApplication;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

class ReviewApiTest {
  @TempDir Path directory;
  private final ObjectMapper json = new ObjectMapper();
  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private String origin;
  private String cookie;

  private ConfigurableApplicationContext start() throws Exception {
    if (!Files.exists(directory.resolve("leanreview.sqlite"))) {
      Path fixture = Path.of("../tests/fixtures/backend-compatibility/databases/v3");
      try (var paths = Files.walk(fixture)) {
        for (Path file : paths.toList()) {
          Path target = directory.resolve(fixture.relativize(file));
          if (Files.isDirectory(file)) Files.createDirectories(target);
          else Files.copy(file, target);
        }
      }
    }
    int port;
    try (var socket = new ServerSocket(0, 0, java.net.InetAddress.getLoopbackAddress())) {
      port = socket.getLocalPort();
    }
    origin = "http://127.0.0.1:" + port;
    cookie = null;
    return new SpringApplicationBuilder(LeanReviewApplication.class)
        .run(
            "--spring.main.web-application-type=servlet",
            "--server.port=" + port,
            "--leanreview.origin=" + origin,
            "--leanreview.data-directory=" + directory,
            "--logging.level.root=OFF",
            "--spring.main.banner-mode=off");
  }

  private HttpResponse<String> call(String method, String path, Object body) throws Exception {
    var builder = HttpRequest.newBuilder(URI.create(origin + path)).timeout(Duration.ofSeconds(10));
    if (cookie != null) builder.header("Cookie", cookie);
    if (!method.equals("GET")) builder.header("Origin", origin);
    builder.header("Content-Type", "application/json");
    return client.send(
        builder
            .method(
                method,
                body == null
                    ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
            .build(),
        HttpResponse.BodyHandlers.ofString());
  }

  private void signIn(ConfigurableApplicationContext context) throws Exception {
    String nonce = context.getBean(LocalAccess.class).startupLink().split("#bootstrap=")[1];
    var response = call("POST", "/api/session", Map.of("nonce", nonce));
    assertThat(response.statusCode()).isEqualTo(200);
    cookie = response.headers().firstValue("Set-Cookie").orElseThrow().split(";")[0];
  }

  private JsonNode review() throws Exception {
    var response = call("GET", "/api/sessions/session-fixture", null);
    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
    return json.readTree(response.body());
  }

  @Test
  void protectsAndPersistsManualReviewEditsAcrossHttpAndRestart() throws Exception {
    String draft;
    try (var context = start()) {
      assertThat(call("GET", "/api/sessions/session-fixture", null).statusCode()).isEqualTo(401);
      signIn(context);
      assertThat(review().path("snapshot").path("id").asText()).isEqualTo("snapshot-current");
      var progress =
          call(
              "POST",
              "/api/sessions/session-fixture/progress",
              Map.of(
                  "snapshotId",
                  "snapshot-current",
                  "fileIds",
                  new String[] {"file-ts"},
                  "reviewed",
                  false));
      assertThat(progress.statusCode()).isEqualTo(200);
      assertThat(json.readTree(progress.body()).path("state").path("reviewed").isEmpty()).isTrue();
      var added =
          call(
              "POST",
              "/api/sessions/session-fixture/drafts",
              Map.of(
                  "snapshotId",
                  "snapshot-current",
                  "fileId",
                  "file-ts",
                  "side",
                  "after",
                  "line",
                  1,
                  "text",
                  " café draft "));
      assertThat(added.statusCode()).isEqualTo(200);
      var drafts = json.readTree(added.body()).path("state").path("drafts");
      draft = drafts.get(drafts.size() - 1).path("id").asText();
      assertThat(drafts.get(drafts.size() - 1).path("text").asText()).isEqualTo("café draft");
      var stale =
          call(
              "POST",
              "/api/sessions/session-fixture/progress",
              Map.of(
                  "snapshotId",
                  "snapshot-history",
                  "fileIds",
                  new String[] {"file-ts"},
                  "reviewed",
                  true));
      assertThat(stale.statusCode()).isEqualTo(400);
      assertThat(stale.body()).contains("Snapshot changed.");
      assertThat(
              call(
                      "POST",
                      "/api/sessions/session-fixture/drafts",
                      Map.of(
                          "snapshotId",
                          "snapshot-current",
                          "fileId",
                          "file-ts",
                          "side",
                          "after",
                          "line",
                          99999,
                          "text",
                          "bad"))
                  .statusCode())
          .isEqualTo(400);
      assertThat(
              call(
                      "POST",
                      "/api/sessions/session-fixture/progress",
                      Map.of("padding", "x".repeat(1024 * 1024)))
                  .statusCode())
          .isEqualTo(413);
    }
    try (var context = start()) {
      signIn(context);
      assertThat(review().path("state").path("drafts").toString()).contains("café draft");
      assertThat(
              call(
                      "DELETE",
                      "/api/sessions/session-fixture/drafts/" + draft,
                      Map.of("snapshotId", "snapshot-current"))
                  .statusCode())
          .isEqualTo(200);
      assertThat(review().path("state").path("drafts").toString()).doesNotContain("café draft");
    }
  }
}
