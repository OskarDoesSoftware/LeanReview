package dev.leanreview.codex;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.analysis.AnalysisHelper;
import dev.leanreview.llm.Cancellation;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class CodexProviderTest {
  @TempDir Path directory;
  final ObjectMapper json = new ObjectMapper();
  final JsonNode config =
      new ObjectMapper()
          .createObjectNode()
          .put("provider", "codex")
          .put("endpoint", "https://chatgpt.com/codex")
          .put("model", "fixture-codex")
          .put("contextWindow", 8192)
          .put("maxOutput", 2048)
          .put("localOnly", false);

  JsonNode input() {
    ObjectNode input = json.createObjectNode();
    input
        .putArray("files")
        .addObject()
        .put("id", "file-1")
        .put("path", "private.ts")
        .put("diff", "private diff");
    return input;
  }

  class Fixture implements AutoCloseable {
    final Path log = directory.resolve(UUID.randomUUID() + ".jsonl");
    final CodexRpc rpc;
    final CodexProvider provider;

    Fixture(String scenario) {
      rpc =
          new CodexRpc(
              json,
              directory.resolve("profile-" + UUID.randomUUID()),
              () ->
                  List.of(
                      AnalysisHelper.executable("node"),
                      Path.of("../tests/fixtures/java-codex-app-server.mjs")
                          .toAbsolutePath()
                          .toString(),
                      scenario,
                      log.toString()));
      provider = new CodexProvider(json, rpc);
    }

    List<JsonNode> messages() throws Exception {
      List<JsonNode> result = new ArrayList<>();
      if (!Files.exists(log)) return result;
      for (String line : Files.readAllLines(log)) result.add(json.readTree(line));
      return result;
    }

    JsonNode method(String name) throws Exception {
      return messages().stream()
          .filter(m -> m.path("method").asText().equals(name))
          .findFirst()
          .orElse(json.nullNode());
    }

    JsonNode infer() throws Exception {
      return provider.infer(config, input(), new Cancellation());
    }

    public void close() throws Exception {
      provider.close();
      // Windows can report process exit just before releasing its working-directory handle.
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
      while (true) {
        try {
          Files.deleteIfExists(rpc.workspace());
          break;
        } catch (java.io.IOException error) {
          if (System.nanoTime() >= deadline) throw error;
          Thread.sleep(20);
        }
      }
    }
  }

  @Test
  void outputSchemasAndStableMembershipMatchNodeForOneTwoAndFortyNineFiles() throws Exception {
    JsonNode examples = json.readTree(Path.of("../tests/fixtures/java-codex-output.json").toFile());
    for (JsonNode example : examples) {
      CodexOutput output = new CodexOutput(json, example.path("input"));
      assertThat(output.schema()).isEqualTo(example.path("schema"));
      assertThat(output.parse(example.path("value"))).isEqualTo(example.path("parsed"));
      ObjectNode invalid = (ObjectNode) example.path("value").deepCopy();
      ((ObjectNode) invalid.path("fileAssignments")).remove("file-0");
      assertThatThrownBy(() -> output.parse(invalid)).hasMessageContaining("invalid structured");
    }
  }

  @Test
  void statusAndInferenceUseAnIsolatedProcessAndNeverReturnCredentialFields() throws Exception {
    try (Fixture f = new Fixture("success")) {
      JsonNode status = f.provider.status();
      assertThat(status.path("connected").asBoolean()).isTrue();
      assertThat(status.path("models")).hasSize(2);
      assertThat(status.path("limits").get(0).path("primary").path("usedPercent").asInt())
          .isEqualTo(20);
      assertThat(f.method("turn/start").isNull()).isTrue();
      assertThat(Files.readString(f.log)).doesNotContain("private.ts");
      assertThat(
              f.infer()
                  .path("cohorts")
                  .get(0)
                  .path("layers")
                  .get(0)
                  .path("fileIds")
                  .get(0)
                  .asText())
          .isEqualTo("file-1");
      JsonNode launch = f.messages().getFirst();
      assertThat(Path.of(launch.path("cwd").asText()).toRealPath())
          .isEqualTo(f.rpc.workspace().toRealPath());
      assertThat(launch.path("env").size()).isEqualTo(1);
      assertThat(launch.path("env").path("CODEX_HOME").asText()).isEqualTo(f.rpc.home().toString());
      assertThat(launch.path("args").toString())
          .contains(
              "forced_login_method",
              "features.shell_tool=false",
              "features.skip_host_skill_discovery=true");
      JsonNode thread = f.method("thread/start").path("params"),
          turn = f.method("turn/start").path("params");
      assertThat(thread.path("permissions").asText()).isEqualTo(CodexRpc.PERMISSIONS);
      assertThat(thread.path("ephemeral").asBoolean()).isTrue();
      assertThat(thread.path("cwd").asText()).isEqualTo(f.rpc.workspace().toString());
      assertThat(turn.path("outputSchema")).isEqualTo(new CodexOutput(json, input()).schema());
      assertThat(json.readTree(turn.path("input").get(0).path("text").asText())).isEqualTo(input());
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"login", "login-fast"})
  void handlesLoginCompletionEvenBeforeLoginIdIsStored(String scenario) throws Exception {
    try (Fixture f = new Fixture(scenario)) {
      assertThat(f.provider.status().path("connected").asBoolean()).isFalse();
      assertThat(f.provider.login().path("authUrl").asText())
          .isEqualTo("https://auth.openai.com/authorize?fixture=1");
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      JsonNode status;
      do {
        Thread.sleep(20);
        status = f.provider.status();
      } while (!status.path("connected").asBoolean() && System.nanoTime() < deadline);
      assertThat(status.path("connected").asBoolean()).isTrue();
      assertThat(status.path("loginPending").asBoolean()).isFalse();
      f.infer();
      f.provider.logout();
      assertThat(f.provider.status().path("connected").asBoolean()).isFalse();
    }
  }

  @Test
  void cancelAndFailedLoginDoNotExposeServerDetails() throws Exception {
    try (Fixture f = new Fixture("signed-out")) {
      f.provider.login();
      f.provider.cancelLogin();
      assertThat(f.provider.status().path("loginPending").asBoolean()).isFalse();
      assertThat(f.method("account/login/cancel").isObject()).isTrue();
    }
    try (Fixture f = new Fixture("login-fails")) {
      f.provider.login();
      Thread.sleep(150);
      JsonNode status = f.provider.status();
      assertThat(status.path("loginError").asText()).contains("did not finish");
      assertThat(status.toString()).doesNotContain("sensitive error");
    }
    try (Fixture f = new Fixture("unsafe-login")) {
      assertThatThrownBy(() -> f.provider.login()).hasMessageContaining("unexpected sign-in URL");
    }
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "signed-out",
        "api-key",
        "exhausted",
        "blocked",
        "unknown-usage",
        "usage-error",
        "wrong-provider"
      })
  void rejectsBeforeStartingInference(String scenario) throws Exception {
    try (Fixture f = new Fixture(scenario)) {
      assertThatThrownBy(f::infer).message().doesNotContain("sensitive error");
      assertThat(f.method("turn/start").isMissingNode() || f.method("turn/start").isNull())
          .isTrue();
    }
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "failed-turn",
        "bad-output",
        "disconnect",
        "turn-error",
        "tool",
        "exit",
        "invalid-rpc",
        "oversized-rpc",
        "oversized-output",
        "repeated-cursor"
      })
  void boundedFailuresDoNotEchoDiagnostics(String scenario) throws Exception {
    try (Fixture f = new Fixture(scenario)) {
      assertThatThrownBy(f::infer)
          .isInstanceOf(CodexFailure.class)
          .message()
          .doesNotContain("sensitive error");
    }
  }

  @Test
  void cancelsOwnedProcessPreventsAccountChangesAndReconnects() throws Exception {
    try (Fixture f = new Fixture("hang");
        var workers = Executors.newVirtualThreadPerTaskExecutor()) {
      Cancellation cancel = new Cancellation();
      Future<?> result =
          workers.submit(
              () ->
                  assertThatThrownBy(() -> f.provider.infer(config, input(), cancel))
                      .hasMessageContaining("canceled"));
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      while (f.method("turn/start").isNull() && System.nanoTime() < deadline) Thread.sleep(20);
      assertThatThrownBy(() -> f.provider.logout()).hasMessageContaining("cancel analysis first");
      cancel.cancel();
      result.get(5, TimeUnit.SECONDS);
      long pid = f.messages().getFirst().path("pid").asLong();
      assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
      long child = f.messages().getFirst().path("childPid").asLong();
      assertThat(ProcessHandle.of(child).map(ProcessHandle::isAlive).orElse(false)).isFalse();
      assertThat(f.provider.status().path("connected").asBoolean()).isTrue();
    }
  }

  @Test
  void missingExecutableAndRequestTimeoutHaveNoImplicitInstallOrFallback() throws Exception {
    assertThatThrownBy(() -> CodexRpc.discover("", directory.toString()))
        .hasMessageContaining("Codex CLI was not found");
    try (Fixture f = new Fixture("success")) {
      f.rpc.ready();
      assertThatThrownBy(
              () ->
                  f.rpc.request(
                      "turn/start",
                      json.createObjectNode()
                          .set(
                              "sandboxPolicy",
                              json.createObjectNode()
                                  .put("type", "readOnly")
                                  .set(
                                      "access",
                                      json.createObjectNode().put("type", "restricted")))))
          .hasMessageContaining("RPC -32600");
    }
    try (Fixture f = new Fixture("request-timeout")) {
      f.rpc.ready();
      assertThatThrownBy(() -> f.rpc.request("account/read", json.createObjectNode(), 50))
          .hasMessageContaining("timed out");
      long pid = f.messages().getFirst().path("pid").asLong();
      assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
    }
  }

  @Test
  void shutdownAndStartupCancellationReapOwnedProcesses() throws Exception {
    for (String scenario : List.of("hang", "hang-initialize")) {
      Fixture f = new Fixture(scenario);
      Cancellation cancellation = new Cancellation();
      try (var workers = Executors.newVirtualThreadPerTaskExecutor()) {
        Future<?> work =
            workers.submit(
                () ->
                    assertThatThrownBy(() -> f.provider.infer(config, input(), cancellation))
                        .isInstanceOf(Exception.class));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        String method = scenario.equals("hang") ? "turn/start" : "initialize";
        while (f.method(method).isNull() && System.nanoTime() < deadline) Thread.sleep(20);
        long pid = f.messages().getFirst().path("pid").asLong();
        if (scenario.equals("hang")) f.close();
        else cancellation.cancel();
        work.get(5, TimeUnit.SECONDS);
        assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
        long child = f.messages().getFirst().path("childPid").asLong();
        assertThat(ProcessHandle.of(child).map(ProcessHandle::isAlive).orElse(false)).isFalse();
      } finally {
        cancellation.cancel();
        f.close();
      }
    }
  }

  @Test
  void ignoresOtherThreadsDeniesServerToolRequestsAndDiscardsStderr() throws Exception {
    java.io.PrintStream previous = System.err;
    var captured = new java.io.ByteArrayOutputStream();
    System.setErr(new java.io.PrintStream(captured));
    try (Fixture f = new Fixture("wrong-thread")) {
      assertThat(f.infer().path("cohorts")).hasSize(1);
      f.rpc.request("fixture/requestTool");
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      JsonNode denied;
      do {
        Thread.sleep(10);
        denied =
            f.messages().stream()
                .filter(m -> m.path("id").asText().equals("server-request"))
                .findFirst()
                .orElse(json.nullNode());
      } while (denied.isNull() && System.nanoTime() < deadline);
      assertThat(denied.path("error").path("code").asInt()).isEqualTo(-32601);
      assertThat(denied.has("result")).isFalse();
      assertThat(f.provider.status().toString()).doesNotContain("fixture-only-secret-login-token");
    } finally {
      System.setErr(previous);
    }
    assertThat(captured.toString(java.nio.charset.StandardCharsets.UTF_8))
        .doesNotContain("fixture-only-secret-login-token");
  }
}
