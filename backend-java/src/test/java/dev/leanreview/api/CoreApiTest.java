package dev.leanreview.api;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.LeanReviewApplication;
import dev.leanreview.git.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;

class CoreApiTest {
  @TempDir Path temporary;
  final ObjectMapper json = new ObjectMapper();
  final HttpClient client = HttpClient.newHttpClient();
  String origin, cookie;

  record Reply(int status, JsonNode body) {}

  Reply call(String method, String route, JsonNode body) throws Exception {
    var request =
        HttpRequest.newBuilder(URI.create(origin + route))
            .header("Origin", origin)
            .timeout(java.time.Duration.ofSeconds(40));
    if (cookie != null) request.header("Cookie", cookie);
    request
        .method(
            method,
            body == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body.toString()))
        .header(
            "Content-Type",
            route.endsWith("/coverage/import")
                ? "application/vnd.leanreview.coverage+json"
                : "application/json");
    var response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    if (response.headers().firstValue("Set-Cookie").isPresent())
      cookie = response.headers().firstValue("Set-Cookie").get().split(";")[0];
    assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
    return new Reply(response.statusCode(), json.readTree(response.body()));
  }

  Path copy() throws Exception {
    Path root = Path.of("../tests/fixtures/backend-compatibility/databases/v3");
    Path data = temporary.resolve("data");
    try (var files = Files.walk(root)) {
      for (Path file : files.toList()) {
        Path to = data.resolve(root.relativize(file));
        if (Files.isDirectory(file)) Files.createDirectories(to);
        else Files.copy(file, to);
      }
    }
    return data;
  }

  int port() throws Exception {
    try (var socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
      return socket.getLocalPort();
    }
  }

  @Test
  void frozenCoreResponsesAndAtomicStateEditsWorkOverHttp() throws Exception {
    int port = port();
    origin = "http://127.0.0.1:" + port;
    try (var app =
        new SpringApplicationBuilder(LeanReviewApplication.class)
            .run(
                "--spring.main.web-application-type=servlet",
                "--server.port=" + port,
                "--leanreview.origin=" + origin,
                "--leanreview.data-directory=" + copy(),
                "--logging.level.root=ERROR",
                "--spring.main.banner-mode=off")) {
      assertThat(call("GET", "/api/sessions", null).status).isEqualTo(401);
      for (JsonNode example :
          json.readTree(Path.of("../tests/fixtures/backend-compatibility/http.json").toFile())) {
        if (!example.path("name").asText().startsWith("unauthorized ")
            || example.path("response").path("status").asInt() != 401) continue;
        JsonNode request = example.path("request");
        Reply actual =
            call(
                request.path("method").asText(),
                request.path("path").asText(),
                request.has("body") ? request.path("body") : null);
        assertThat(actual.status)
            .as(example.path("name").asText())
            .isEqualTo(example.path("response").path("status").asInt());
        assertThat(actual.body).isEqualTo(example.path("response").path("body"));
      }
      String nonce = app.getBean(LocalAccess.class).startupLink().split("bootstrap=")[1];
      assertThat(call("POST", "/api/session", json.createObjectNode().put("nonce", nonce)).status)
          .isEqualTo(200);
      // The stored v3 fixture is named leanreview; the HTTP oracle uses a freshly created
      // repository.
      Reply saved = call("GET", "/api/sessions", null);
      assertThat(saved.status).isEqualTo(200);
      assertThat(saved.body.get(0).path("id").asText()).isEqualTo("session-fixture");
      assertThat(saved.body.get(0).path("name").asText()).isEqualTo("leanreview");
      var names =
          Set.of(
              "unknown route",
              "provider",
              "set provider",
              "invalid provider budget",
              "invalid local provider",
              "manifest",
              "unauthorized analysis",
              "stale manifest",
              "cancel idle analysis",
              "stale refresh",
              "recovered review",
              "historical review",
              "missing session",
              "missing snapshot",
              "invalid create",
              "set editor",
              "reject editor missing file",
              "stale progress",
              "unknown progress file",
              "mark progress",
              "accept grouping",
              "invalid grouping",
              "coverage",
              "coverage artifact",
              "missing coverage artifact",
              "import unaligned coverage",
              "set test config",
              "reject unconfirmed tests",
              "cancel interrupted tests",
              "recovered partial graph",
              "graph status only",
              "missing graph source",
              "invalid graph options",
              "cancel idle graph",
              "start capped graph",
              "completed capped graph",
              "captured graph source",
              "invalid draft coordinates");
      for (JsonNode example :
          json.readTree(Path.of("../tests/fixtures/backend-compatibility/http.json").toFile())) {
        if (!names.contains(example.path("name").asText())) continue;
        JsonNode request = example.path("request");
        Reply actual =
            call(
                request.path("method").asText(),
                request.path("path").asText(),
                request.has("body") ? request.path("body") : null);
        if (example.path("name").asText().equals("completed capped graph")) {
          long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(15);
          while (actual.body.path("run").path("status").asText().equals("running")
              && System.nanoTime() < deadline) {
            Thread.sleep(20);
            actual = call("GET", request.path("path").asText(), null);
          }
        }
        assertThat(actual.status)
            .as(example.path("name").asText())
            .isEqualTo(example.path("response").path("status").asInt());
        assertThat(normalize(actual.body, ""))
            .as(example.path("name").asText())
            .isEqualTo(example.path("response").path("body"));
      }
      ObjectNode draft =
          json.createObjectNode()
              .put("snapshotId", "snapshot-current")
              .put("fileId", "file-ts")
              .put("side", "after")
              .put("line", 2)
              .put("text", "Keep café");
      Reply created = call("POST", "/api/sessions/session-fixture/drafts", draft);
      assertThat(created.status).isEqualTo(200);
      JsonNode drafts = created.body.path("state").path("drafts");
      String id = drafts.get(drafts.size() - 1).path("id").asText();
      assertThat(
              call(
                      "DELETE",
                      "/api/sessions/session-fixture/drafts/" + id,
                      json.createObjectNode().put("snapshotId", "snapshot-current"))
                  .body
                  .path("state")
                  .path("drafts")
                  .size())
          .isEqualTo(drafts.size() - 1);
      assertThat(
              call("GET", "/api/sessions/session-fixture?snapshot=snapshot-history", null)
                  .body
                  .path("state")
                  .path("reviewed")
                  .size())
          .isEqualTo(0);
    }
  }

  private JsonNode normalize(JsonNode node, String key) {
    if (node.isNumber()
        && node.asDouble() == Math.floor(node.asDouble())
        && node.asDouble() >= Integer.MIN_VALUE
        && node.asDouble() <= Integer.MAX_VALUE)
      return json.getNodeFactory().numberNode(node.asInt());
    if (node.isObject()) {
      ObjectNode result = json.createObjectNode();
      node.fields()
          .forEachRemaining(
              field -> result.set(field.getKey(), normalize(field.getValue(), field.getKey())));
      return result;
    }
    if (node.isArray()) {
      ArrayNode result = json.createArrayNode();
      node.forEach(item -> result.add(normalize(item, "")));
      return result;
    }
    if (node.isTextual() && key.endsWith("At"))
      return json.getNodeFactory().textNode("<timestamp>");
    if (node.isTextual() && node.asText().equals("/fixture/leanreview"))
      return json.getNodeFactory().textNode("<repository>");
    return node;
  }

  @Test
  void patchBytesMatchTheExistingNodeImplementation() throws Exception {
    for (JsonNode example :
        json.readTree(Path.of("../tests/fixtures/core-git-patches.json").toFile()))
      assertThat(
              TextPatch.create(
                  example.path("beforePath").asText(),
                  example.path("afterPath").asText(),
                  example.path("before").asText(),
                  example.path("after").asText()))
          .as(example.path("name").asText())
          .isEqualTo(example.path("patch").asText());
  }

  @Test
  void localCapturesRetainImmutableModesRenamesAndMetadata() throws Exception {
    Path root = temporary.resolve("repo");
    Files.createDirectories(root);
    GitProcess.run(root, "init", "-b", "main");
    GitProcess.run(root, "config", "user.name", "Fixture");
    GitProcess.run(root, "config", "user.email", "fixture@example.invalid");
    GitProcess.run(root, "config", "core.autocrlf", "false");
    Files.writeString(root.resolve("a.ts"), "const before = 1;\n");
    GitProcess.run(root, "add", ".");
    GitProcess.run(root, "commit", "-m", "fixture");
    Files.writeString(root.resolve("a.ts"), "const staged = 2;\n");
    GitProcess.run(root, "add", ".");
    Files.writeString(root.resolve("a.ts"), "const working = 3;\n");
    Files.write(root.resolve("binary"), new byte[] {0, 1, 2});
    LocalSnapshots captures = new LocalSnapshots(json);
    assertThat(captures.select(root.toString())).isEqualTo(root.toRealPath());
    ObjectNode staged =
        captures.capture(
            root, json.createObjectNode().put("mode", "staged").put("base", "main"), "session");
    assertThat(staged.path("files").get(0).path("after").path("text").asText()).contains("staged");
    ObjectNode unstaged =
        captures.capture(
            root, json.createObjectNode().put("mode", "unstaged").put("base", "main"), "session");
    assertThat(unstaged.path("files").get(0).path("before").path("text").asText())
        .contains("staged");
    assertThat(unstaged.path("files").get(0).path("after").path("text").asText())
        .contains("working");
    assertThat(unstaged.path("files").get(1).path("after").path("kind").asText())
        .isEqualTo("binary");
    GitProcess.run(root, "reset", "--hard", "HEAD");
    GitProcess.run(root, "mv", "a.ts", "renamed.ts");
    ObjectNode renamed =
        captures.capture(
            root, json.createObjectNode().put("mode", "staged").put("base", "main"), "session");
    assertThat(renamed.path("files").get(0).path("status").asText()).isEqualTo("renamed");
    assertThatThrownBy(() -> captures.select(root.resolve(".git").toString()))
        .isInstanceOf(Exception.class);
    assertThatThrownBy(() -> LocalSnapshots.contained(root, ".git/config"))
        .hasMessage("Invalid repository path.");
  }
}
