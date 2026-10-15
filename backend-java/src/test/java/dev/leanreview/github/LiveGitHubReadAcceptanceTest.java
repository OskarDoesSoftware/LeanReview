package dev.leanreview.github;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/** A read-only CLI wrapper must be explicitly supplied. This test never performs remote writes. */
@EnabledIfEnvironmentVariable(named = "LEANREVIEW_LIVE_GITHUB_READ_COMMAND", matches = ".+")
class LiveGitHubReadAcceptanceTest {
  @TempDir Path directory;

  @Test
  @EnabledIfEnvironmentVariable(named = "LEANREVIEW_LIVE_GITHUB_PR", matches = "[1-9][0-9]*")
  void realPullRequestCaptureAndDiscussionsRemainReadOnly() throws Exception {
    var command = System.getenv("LEANREVIEW_LIVE_GITHUB_READ_COMMAND");
    try (var context =
        new org.springframework.boot.builder.SpringApplicationBuilder(
                dev.leanreview.LeanReviewApplication.class)
            .run(
                "--leanreview.data-directory=" + directory.resolve("capture"),
                "--leanreview.github.command=" + command,
                "--logging.level.root=OFF",
                "--spring.main.banner-mode=off")) {
      var cli = context.getBean(GitHubCli.class);
      var github = context.getBean(GitHubReviews.class);
      var feedback = context.getBean(GitHubFeedback.class);
      var repository = cli.api("GET", "repos/OskarDoesSoftware/LeanReview", null);
      int number = Integer.parseInt(System.getenv("LEANREVIEW_LIVE_GITHUB_PR"));
      var metadata = cli.api("GET", "repos/OskarDoesSoftware/LeanReview/pulls/" + number, null);
      var review = github.open(repository.path("id").asLong(), number);
      var snapshot = review.path("snapshot");
      assertThat(snapshot.path("complete").asBoolean()).isTrue();
      assertThat(snapshot.path("files").size()).isEqualTo(metadata.path("changed_files").asInt());
      assertThat(snapshot.path("source").path("headSha"))
          .isEqualTo(metadata.path("head").path("sha"));
      assertThat(review.path("state").path("analysisStatus").asText()).isEqualTo("idle");
      assertThat(review.path("state").path("drafts").size()).isZero();
      assertThat(review.path("state").path("githubSubmissions").size()).isZero();
      String id = snapshot.path("sessionId").asText();
      assertThat(github.open(repository.path("id").asLong(), number).path("snapshot").path("id"))
          .isEqualTo(snapshot.path("id"));
      var discussions = feedback.discussions(id);
      assertThat(discussions.path("threads").isArray()).isTrue();
      assertThat(discussions.path("comments").isArray()).isTrue();
    }
  }

  @Test
  void existingKeyringAccountCanReadTheProjectThroughTheJavaAdapter() throws Exception {
    var json = new ObjectMapper();
    var cli =
        new GitHubCli(
            json, directory.toString(), System.getenv("LEANREVIEW_LIVE_GITHUB_READ_COMMAND"));
    try {
      assertThat(cli.status().path("connected").asBoolean()).isTrue();
      var repository = cli.api("GET", "repos/OskarDoesSoftware/LeanReview", null);
      assertThat(repository.path("id").asLong()).isPositive();
      assertThat(repository.path("full_name").asText())
          .isEqualToIgnoringCase("OskarDoesSoftware/LeanReview");
      assertThat(cli.pages("repos/OskarDoesSoftware/LeanReview/pulls?state=open").isArray())
          .isTrue();
    } finally {
      cli.close();
    }
  }
}
