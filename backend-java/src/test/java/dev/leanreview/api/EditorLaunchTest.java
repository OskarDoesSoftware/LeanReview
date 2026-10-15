package dev.leanreview.api;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.leanreview.LeanReviewApplication;
import dev.leanreview.editor.EditorService;
import dev.leanreview.git.GitProcess;
import dev.leanreview.git.LocalSnapshots;
import dev.leanreview.storage.CoreSnapshots;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;

class EditorLaunchTest {
  @TempDir Path directory;

  public static class Probe {
    public static void main(String[] args) throws Exception {
      Path pending = Path.of(args[0] + ".pending");
      Files.writeString(
          pending, String.join("\n", java.util.Arrays.copyOfRange(args, 1, args.length)));
      Files.move(pending, Path.of(args[0]), java.nio.file.StandardCopyOption.ATOMIC_MOVE);
    }
  }

  @Test
  void launchesArgumentsWithoutAShellAndRejectsChangedWorkingText() throws Exception {
    var json = new ObjectMapper();
    Path root = Files.createDirectory(directory.resolve("repository"));
    GitProcess.run(root, "init", "-b", "main");
    Files.writeString(root.resolve("file with spaces.ts"), "\ufeffexport const value = 1;\n");
    try (var context =
        new SpringApplicationBuilder(LeanReviewApplication.class)
            .run(
                "--leanreview.data-directory=" + directory.resolve("data"),
                "--spring.main.web-application-type=none",
                "--logging.level.root=OFF",
                "--spring.main.banner-mode=off")) {
      var snapshots = context.getBean(CoreSnapshots.class);
      var captured =
          context
              .getBean(LocalSnapshots.class)
              .capture(
                  root,
                  json.createObjectNode().put("mode", "all").put("base", "main"),
                  UUID.randomUUID().toString());
      snapshots.create(captured);
      var editor = context.getBean(EditorService.class);
      Path output = directory.resolve("arguments.txt");
      var config =
          json.createObjectNode()
              .put("name", "Test probe")
              .put("executable", ProcessHandle.current().info().command().orElseThrow());
      config
          .putArray("args")
          .add("-cp")
          .add(Path.of("target/test-classes").toAbsolutePath().toString())
          .add(Probe.class.getName())
          .add(output.toString())
          .add("{file}")
          .add("{line}")
          .add("{column}")
          .add("literal;$(not-a-shell)");
      editor.configure(config);
      var input =
          json.createObjectNode()
              .put("snapshotId", captured.path("id").asText())
              .put("fileId", captured.path("files").get(0).path("id").asText())
              .put("side", "before")
              .put("line", 100)
              .put("column", 3);
      assertThat(editor.open(captured.path("sessionId").asText(), input).path("line").asInt())
          .isEqualTo(1);
      long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
      while (!Files.exists(output) && System.nanoTime() < deadline) Thread.sleep(20);
      assertThat(Files.readString(output))
          .isEqualTo(
              root.resolve("file with spaces.ts").toRealPath() + "\n1\n3\nliteral;$(not-a-shell)");
      Files.writeString(root.resolve("file with spaces.ts"), "changed");
      assertThatThrownBy(() -> editor.open(captured.path("sessionId").asText(), input))
          .hasMessageContaining("Working file differs");
    }
  }
}
