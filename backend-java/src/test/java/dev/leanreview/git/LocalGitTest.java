package dev.leanreview.git;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LocalGitTest {
  @TempDir Path root;
  private final ObjectMapper json = new ObjectMapper();
  private final LocalSnapshots git = new LocalSnapshots(json);

  private ObjectNode capture(String mode) throws Exception {
    return git.capture(
        root.toRealPath(),
        json.createObjectNode().put("mode", mode).put("base", "main"),
        "session");
  }

  private void initialize() throws Exception {
    GitProcess.run(root, "init", "-b", "main");
    GitProcess.run(root, "config", "user.name", "Fixture");
    GitProcess.run(root, "config", "user.email", "fixture@example.invalid");
    GitProcess.run(root, "config", "core.autocrlf", "false");
  }

  private void commit() throws Exception {
    GitProcess.run(root, "add", ".");
    GitProcess.run(root, "commit", "-m", "fixture", "--no-gpg-sign");
  }

  @Test
  void preservesPatchesFrozenFromTheExistingDiffLibrary() throws Exception {
    int example = 0;
    for (var fixture : json.readTree(Path.of("../tests/fixtures/git-patches.json").toFile())) {
      assertThat(
              TextPatch.create(
                  fixture.path("oldPath").asText(),
                  fixture.path("path").asText(),
                  fixture.path("before").asText(),
                  fixture.path("after").asText()))
          .as("patch fixture %s", example++)
          .isEqualTo(fixture.path("patch").asText());
    }
  }

  @Test
  void separatesIndexWorkingTreeAndUntrackedFilesAndPinsInventories() throws Exception {
    initialize();
    Files.writeString(root.resolve("source.ts"), "export const value = 1;\n");
    commit();
    Files.writeString(root.resolve("source.ts"), "export const value = 2;\n");
    GitProcess.run(root, "add", ".");
    Files.writeString(root.resolve("source.ts"), "export const value = 3;\n");
    Files.writeString(root.resolve("new.ts"), "export {};\n");
    ObjectNode staged = capture("staged"), unstaged = capture("unstaged"), all = capture("all");
    assertThat(staged.path("files").size()).isEqualTo(1);
    assertThat(staged.path("files").get(0).path("after").path("text").asText()).contains("= 2;");
    assertThat(unstaged.path("files").size()).isEqualTo(2);
    assertThat(unstaged.path("files").get(0).path("before").path("text").asText()).contains("= 2;");
    assertThat(all.path("files").get(0).path("before").path("text").asText()).contains("= 1;");
    assertThat(all.path("files").get(0).path("after").path("text").asText()).contains("= 3;");
    assertThat(unstaged.path("graphContext").path("before").path("revision").asText())
        .isEqualTo("captured-index");
    String captured = all.toString();
    Files.writeString(root.resolve("source.ts"), "later");
    assertThat(all.toString()).isEqualTo(captured);
    assertThatThrownBy(() -> git.select(Files.createDirectory(root.resolve("nested")).toString()))
        .hasMessage("Select the repository root, not a subdirectory.");
    assertThatThrownBy(() -> git.contained(root, ".git/config"))
        .hasMessage("Invalid repository path.");
  }

  @Test
  void rejectsConflictedIndexAndDoesNotFollowSymlinks() throws Exception {
    initialize();
    Files.writeString(root.resolve("conflict.ts"), "base\n");
    commit();
    GitProcess.run(root, "switch", "-c", "other");
    Files.writeString(root.resolve("conflict.ts"), "other\n");
    commit();
    GitProcess.run(root, "switch", "main");
    Files.writeString(root.resolve("conflict.ts"), "main\n");
    commit();
    assertThatThrownBy(() -> GitProcess.run(root, "merge", "other"))
        .isInstanceOf(java.io.IOException.class);
    assertThatThrownBy(() -> capture("all")).hasMessageContaining("resolve conflicts");
    GitProcess.run(root, "merge", "--abort");
    Path outside = Files.createTempFile("leanreview-outside-", ".txt");
    try {
      Files.writeString(outside, "private source outside repository");
      try {
        Files.createSymbolicLink(root.resolve("link.ts"), outside);
      } catch (java.io.IOException | UnsupportedOperationException unavailable) {
        org.junit.jupiter.api.Assumptions.abort("Symlink creation is unavailable on this platform");
      }
      var file = capture("all").path("files").get(0);
      assertThat(file.path("after").path("kind").asText()).isEqualTo("unavailable");
      assertThat(file.toString()).doesNotContain("private source");
      assertThatThrownBy(() -> LocalSnapshots.contained(root, "link.ts"))
          .hasMessage("File resolves outside the selected repository.");
    } finally {
      Files.deleteIfExists(outside);
    }
  }

  @Test
  void capturesUnbornHeadRenamesBinaryAndBranchChanges() throws Exception {
    initialize();
    Files.writeString(root.resolve("first.ts"), "export const value = 1;\n");
    GitProcess.run(root, "add", ".");
    assertThat(capture("all").path("head").isNull()).isTrue();
    assertThat(capture("all").path("files").get(0).path("status").asText()).isEqualTo("added");
    commit();
    GitProcess.run(root, "switch", "-c", "feature");
    Files.move(root.resolve("first.ts"), root.resolve("renamed.ts"));
    Files.write(root.resolve("binary.dat"), new byte[] {0, 1, 2});
    commit();
    var branch = capture("branch");
    assertThat(branch.path("files").size()).isEqualTo(2);
    var statuses = new java.util.HashSet<String>();
    branch.path("files").forEach(file -> statuses.add(file.path("status").asText()));
    assertThat(statuses).containsExactlyInAnyOrder("added", "renamed");
    for (var file : branch.path("files"))
      if (file.path("path").asText().equals("binary.dat"))
        assertThat(file.path("after").path("kind").asText()).isEqualTo("binary");
    assertThat(capture("all").path("files").size()).isZero();
  }
}
