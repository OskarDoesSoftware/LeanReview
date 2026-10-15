package dev.leanreview.analysis;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.LeanReviewApplication;
import dev.leanreview.coverage.TestJobs;
import dev.leanreview.git.*;
import dev.leanreview.graph.GraphJobs;
import dev.leanreview.storage.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;

class AnalysisJobsTest {
  @TempDir Path directory;
  final ObjectMapper json = new ObjectMapper();

  @Test
  void explicitRunsBindPreviewPreserveMeasurementsOnFailureAndCancelOwnedTree() throws Exception {
    Path root = directory.resolve("repo");
    Files.createDirectories(root);
    GitProcess.run(root, "init", "-b", "main");
    GitProcess.run(root, "config", "user.name", "Fixture");
    GitProcess.run(root, "config", "user.email", "fixture@example.invalid");
    Files.writeString(root.resolve("a.ts"), "export function a() { return 1; }\n");
    Files.writeString(root.resolve("b.ts"), "export const pinned = 1;\n");
    GitProcess.run(root, "add", ".");
    GitProcess.run(root, "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    Files.writeString(root.resolve("a.ts"), "export function a() { return 2; }\n");
    try (var context =
        new SpringApplicationBuilder(LeanReviewApplication.class)
            .run(
                "--leanreview.data-directory=" + directory.resolve("data"),
                "--spring.main.web-application-type=none",
                "--logging.level.root=OFF",
                "--spring.main.banner-mode=off")) {
      CoreSnapshots snapshots = context.getBean(CoreSnapshots.class);
      LocalSnapshots git = context.getBean(LocalSnapshots.class);
      TestJobs jobs = context.getBean(TestJobs.class);
      AnalysisStore store = context.getBean(AnalysisStore.class);
      JsonNode snapshot =
          git.capture(
              git.select(root.toString()),
              json.createObjectNode().put("mode", "all"),
              "test-session");
      snapshots.create((ObjectNode) snapshot);
      String id = snapshot.path("id").asText();
      GraphJobs graphs = context.getBean(GraphJobs.class);
      Files.writeString(root.resolve("b.ts"), "live working tree must not leak");
      ObjectNode options =
          json.createObjectNode()
              .put("side", "after")
              .put("maxFiles", 10000)
              .put("maxBytes", 20 * 1024 * 1024);
      graphs.start(snapshot, options);
      assertThatThrownBy(() -> graphs.start(snapshot, options))
          .hasMessageContaining("already running");
      long graphDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
      while (graphs.view(id, "after", true).path("run").path("status").asText().equals("running")
          && System.nanoTime() < graphDeadline) Thread.sleep(20);
      JsonNode graph = graphs.view(id, "after", false);
      assertThat(graph.path("run").path("status").asText())
          .withFailMessage(graph.toString())
          .isEqualTo("succeeded");
      String node = null;
      for (JsonNode n : graph.path("graph").path("nodes"))
        if (n.path("path").asText().equals("b.ts")) node = n.path("id").asText();
      assertThat(graphs.source(id, "after", node).path("text").asText())
          .isEqualTo("export const pinned = 1;\n");
      assertThat(graphs.view(id, "after", true).path("graph").isNull()).isTrue();
      Files.writeString(root.resolve("b.ts"), "export const pinned = 1;\n");
      String report =
          "{\"a.ts\":{\"statementMap\":{\"0\":{\"start\":{\"line\":1,\"column\":22},\"end\":{\"line\":1,\"column\":31}}},\"s\":{\"0\":1}}}";
      ObjectNode config =
          config(
              "require('node:fs').writeFileSync('coverage.json',"
                  + json.writeValueAsString(report)
                  + ")",
              30);
      jobs.config(root.toString(), config);
      JsonNode preview = jobs.prepare(snapshot, "istanbul");
      String firstPreview = preview.path("id").asText();
      assertThat(Files.exists(root.resolve("coverage.json"))).isFalse();
      Files.writeString(root.resolve("a.ts"), "changed");
      assertThatThrownBy(() -> jobs.start(snapshot, firstPreview))
          .hasMessageContaining("differs from snapshot");
      Files.writeString(root.resolve("a.ts"), "export function a() { return 2; }\n");
      JsonNode run = jobs.start(snapshot, preview.path("id").asText());
      JsonNode finished = await(store, run.path("id").asText());
      assertThat(finished.path("status").asText())
          .withFailMessage(finished.toString())
          .isEqualTo("succeeded");
      assertThat(finished.path("metrics").path("measured").asInt()).isEqualTo(1);
      assertThat(Files.exists(root.resolve("coverage.json.leanreview.json"))).isTrue();
      JsonNode saved = store.coverage(id, "istanbul");
      assertThatThrownBy(() -> jobs.start(snapshot, firstPreview))
          .hasMessageContaining("Preview again");
      jobs.config(root.toString(), config("process.exit(3)", 30));
      preview = jobs.prepare(snapshot, "istanbul");
      run = start(jobs, snapshot, preview);
      finished = await(store, run.path("id").asText());
      assertThat(finished.path("status").asText()).isEqualTo("failed");
      assertThat(store.coverage(id, "istanbul")).isEqualTo(saved);
      jobs.config(
          root.toString(),
          config(
              "const fs=require('node:fs'); const"
                  + " c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);"
                  + " fs.writeFileSync('child.pid',String(c.pid)); setInterval(()=>{},1000)",
              30));
      preview = jobs.prepare(snapshot, "istanbul");
      run = start(jobs, snapshot, preview);
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
      while (!Files.exists(root.resolve("child.pid")) && System.nanoTime() < deadline)
        Thread.sleep(20);
      long pid = Long.parseLong(Files.readString(root.resolve("child.pid")));
      jobs.cancel(run.path("id").asText());
      finished = await(store, run.path("id").asText());
      assertThat(finished.path("status").asText()).isEqualTo("canceled");
      assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
      assertThat(store.coverage(id, "istanbul")).isEqualTo(saved);
      jobs.config(root.toString(), config("setInterval(()=>{},1000)", 1));
      preview = jobs.prepare(snapshot, "istanbul");
      run = start(jobs, snapshot, preview);
      finished = await(store, run.path("id").asText());
      assertThat(finished.path("status").asText()).isEqualTo("failed");
      assertThat(finished.path("error").asText()).contains("timeout");
      ObjectNode shell = config("", 30);
      ObjectNode shellStep = (ObjectNode) shell.path("steps").get(0);
      shellStep.put("executable", "echo").put("shell", true);
      shellStep.putArray("args").add("\"shell fixture\"").add("> \"shell output.txt\"");
      jobs.config(root.toString(), shell);
      preview = jobs.prepare(snapshot, "istanbul");
      run = start(jobs, snapshot, preview);
      finished = await(store, run.path("id").asText());
      assertThat(Files.readString(root.resolve("shell output.txt"))).contains("shell fixture");
      assertThat(finished.path("error").asText()).contains("not regenerated");
      ObjectNode invalid = config("", 30).put("reportPath", "../outside.json");
      jobs.config(root.toString(), invalid);
      assertThatThrownBy(() -> jobs.prepare(snapshot, "istanbul"))
          .hasMessageContaining("repository-contained");
    }
  }

  private ObjectNode config(String script, int timeout) {
    ObjectNode config =
        json.createObjectNode()
            .put("format", "istanbul")
            .put("cwd", ".")
            .put("reportPath", "coverage.json")
            .put("timeoutSeconds", timeout)
            .put("threshold", 8);
    ObjectNode step =
        config.putArray("steps").addObject().put("executable", "node").put("shell", false);
    step.putArray("args").add("-e").add(script);
    return config;
  }

  private JsonNode start(TestJobs jobs, JsonNode snapshot, JsonNode preview) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    while (true)
      try {
        return jobs.start(snapshot, preview.path("id").asText());
      } catch (IllegalArgumentException e) {
        if (!e.getMessage().startsWith("A test run is already active")
            || System.nanoTime() > deadline) throw e;
        Thread.sleep(10);
      }
  }

  private JsonNode await(AnalysisStore store, String id) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
    JsonNode value;
    while ((value = store.test(id)).path("status").asText().equals("running")
        && System.nanoTime() < deadline) Thread.sleep(20);
    assertThat(value.path("status").asText()).isNotEqualTo("running");
    return value;
  }
}
