package dev.leanreview.storage;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.leanreview.LeanReviewApplication;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;

class CutoverBackupTest {
  @TempDir Path temporary;
  private final ObjectMapper json = new ObjectMapper();

  private Path copy() throws Exception {
    Path source = Path.of("../tests/fixtures/backend-compatibility/databases/v3");
    Path data = temporary.resolve("data");
    try (var files = Files.walk(source)) {
      for (Path file : files.toList()) {
        Path target = data.resolve(source.relativize(file));
        if (Files.isDirectory(file)) Files.createDirectories(target);
        else Files.copy(file, target);
      }
    }
    return data;
  }

  private org.springframework.context.ConfigurableApplicationContext start(Path data) {
    return new SpringApplicationBuilder(LeanReviewApplication.class)
        .run(
            "--leanreview.data-directory=" + data,
            "--leanreview.cutover-backup=true",
            "--spring.main.banner-mode=off",
            "--logging.level.root=OFF");
  }

  @Test
  void firstProductionStartBacksUpBeforeRecoveryAndRestoreReopensTheReview() throws Exception {
    Path data = copy();
    try (var context = start(data)) {
      assertThat(
              context
                  .getBean(ReviewStore.class)
                  .review("session-fixture", null)
                  .path("state")
                  .path("analysisStatus")
                  .asText())
          .isEqualTo("interrupted");
    }
    Path backup =
        Path.of(json.readTree(data.resolve("java-cutover.json").toFile()).path("backup").asText());
    var manifest = json.readTree(backup.resolve("backup.json").toFile());
    assertThat(manifest.path("files").size()).isGreaterThan(2);
    try (var connection =
            DriverManager.getConnection("jdbc:sqlite:" + backup.resolve("leanreview.sqlite"));
        var statement = connection.createStatement();
        var rows =
            statement.executeQuery("SELECT state FROM snapshots WHERE id='snapshot-current'")) {
      assertThat(rows.next()).isTrue();
      assertThat(json.readTree(rows.getString(1)).path("analysisStatus").asText())
          .isEqualTo("running");
    }
    try (var ignored = start(data)) {}
    try (var entries = Files.list(data.resolve("backups"))) {
      assertThat(entries.count()).isEqualTo(1);
    }
    Path restored = temporary.resolve("restored");
    try (var files = Files.walk(backup)) {
      for (Path file : files.toList()) {
        Path target = restored.resolve(backup.relativize(file));
        if (Files.isDirectory(file)) Files.createDirectories(target);
        else Files.copy(file, target);
      }
    }
    try (var context = start(restored)) {
      var review = context.getBean(ReviewStore.class).review("session-fixture", null);
      assertThat(review.path("snapshot").path("id").asText()).isEqualTo("snapshot-current");
      assertThat(review.path("state").path("drafts").get(0).path("text").asText()).contains("café");
    }
  }

  @Test
  void invalidArtifactsPreventCutoverWithoutAMarkerOrDatabaseChanges() throws Exception {
    Path data = copy();
    String digest;
    try (var entries = Files.list(data.resolve("cache"))) {
      digest = entries.findFirst().orElseThrow().getFileName().toString();
    }
    Files.writeString(data.resolve("cache").resolve(digest), "tampered");
    assertThatThrownBy(() -> start(data)).hasStackTraceContaining("Captured artifact is corrupt");
    assertThat(Files.exists(data.resolve("java-cutover.json"))).isFalse();
    try (var connection =
            DriverManager.getConnection("jdbc:sqlite:" + data.resolve("leanreview.sqlite"));
        var statement = connection.createStatement();
        var rows =
            statement.executeQuery("SELECT state FROM snapshots WHERE id='snapshot-current'")) {
      assertThat(rows.next()).isTrue();
      assertThat(json.readTree(rows.getString(1)).path("analysisStatus").asText())
          .isEqualTo("running");
    }
  }
}
