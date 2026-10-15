package dev.leanreview.github;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.LeanReviewApplication;
import dev.leanreview.analysis.AnalysisHelper;
import dev.leanreview.review.CoreReview;
import dev.leanreview.storage.*;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;

class GitHubWorkflowTest {
  @TempDir Path directory;
  final ObjectMapper json = new ObjectMapper();

  void control(Path fixture, String key, boolean value) throws Exception {
    Path file = fixture.resolve("state.json");
    ObjectNode state = (ObjectNode) json.readTree(Files.readString(file));
    state.put(key, value);
    Files.writeString(file, json.writeValueAsString(state));
  }

  @Test
  void discoveryPaginatesRepositoriesPullsAndTeamsBeforeFilteringReviewRequests() throws Exception {
    Path fixture = directory.resolve("discovery-provider");
    var command =
        List.of(
            AnalysisHelper.executable("node"),
            Path.of("../tests/fixtures/github-cli.mjs").toAbsolutePath().toString(),
            fixture.toString());
    try (var context =
        new SpringApplicationBuilder(LeanReviewApplication.class)
            .run(
                "--leanreview.data-directory=" + directory.resolve("discovery-data"),
                "--leanreview.github.command=" + json.writeValueAsString(command),
                "--logging.level.root=OFF",
                "--spring.main.banner-mode=off")) {
      var cli = context.getBean(GitHubCli.class);
      var github = context.getBean(GitHubReviews.class);
      cli.login();
      long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
      while (!cli.status().path("connected").asBoolean() && System.nanoTime() < deadline)
        Thread.sleep(100);
      assertThat(cli.status().path("connected").asBoolean()).isTrue();
      control(fixture, "paginate", true);
      JsonNode repositories = github.repositories();
      assertThat(repositories.size()).isEqualTo(101);
      assertThat(repositories.get(100).path("id").asLong()).isEqualTo(42);
      JsonNode pulls = github.pulls(42);
      assertThat(pulls.size()).isEqualTo(101);
      assertThat(pulls.get(0).path("needsMyReview").asBoolean()).isFalse();
      assertThat(pulls.get(100).path("number").asInt()).isEqualTo(7);
      assertThat(pulls.get(100).path("needsMyReview").asBoolean()).isTrue();
    }
  }

  @Test
  void capturedReviewRetainsDraftsAndReconcilesAmbiguousPublicationWithoutResending()
      throws Exception {
    Path fixture = directory.resolve("provider");
    var command =
        List.of(
            AnalysisHelper.executable("node"),
            Path.of("../tests/fixtures/github-cli.mjs").toAbsolutePath().toString(),
            fixture.toString());
    try (var context =
        new SpringApplicationBuilder(LeanReviewApplication.class)
            .run(
                "--leanreview.data-directory=" + directory.resolve("data"),
                "--leanreview.github.command=" + json.writeValueAsString(command),
                "--logging.level.root=OFF",
                "--spring.main.banner-mode=off")) {
      var cli = context.getBean(GitHubCli.class);
      var github = context.getBean(GitHubReviews.class);
      var feedback = context.getBean(GitHubFeedback.class);
      var operations = context.getBean(CoreReview.class);
      var store = context.getBean(ReviewStore.class);
      assertThat(cli.status().path("connected").asBoolean()).isFalse();
      cli.login();
      long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
      while (!cli.status().path("connected").asBoolean() && System.nanoTime() < deadline)
        Thread.sleep(100);
      assertThat(cli.status().path("connected").asBoolean()).isTrue();
      assertThat(github.repositories().get(0).path("id").asLong()).isEqualTo(42);
      ObjectNode review = github.open(42, 7);
      String id = review.path("snapshot").path("sessionId").asText(),
          snapshot = review.path("snapshot").path("id").asText();
      assertThat(review.path("snapshot").path("complete").asBoolean()).isTrue();
      assertThat(review.path("state").path("analysisStatus").asText()).isEqualTo("idle");
      assertThat(review.path("snapshot").path("files").get(0).path("after").path("text").asText())
          .contains("value = 2");
      assertThat(github.open(42, 7).path("snapshot").path("id").asText()).isEqualTo(snapshot);
      JsonNode file = review.path("snapshot").path("files").get(0);
      ObjectNode draft =
          json.createObjectNode()
              .put("snapshotId", snapshot)
              .put("fileId", file.path("id").asText())
              .put("side", "after")
              .put("line", 1)
              .put("text", "Check the rule.");
      review = operations.mutate(id, draft, "drafts", null);
      String draftId = review.path("state").path("drafts").get(0).path("id").asText();
      assertThat(feedback.discussions(id).path("threads").size()).isEqualTo(1);
      ObjectNode publish =
          json.createObjectNode()
              .put("snapshotId", snapshot)
              .put("decision", "COMMENT")
              .put("message", "Review feedback")
              .put("submissionId", UUID.randomUUID().toString());
      publish.putArray("draftIds").add(draftId);
      assertThat(feedback.preview(id, publish).path("drafts").size()).isEqualTo(1);
      assertThat(
              json.readTree(Files.readString(fixture.resolve("state.json"))).path("reviews").size())
          .isZero();
      control(fixture, "failPublish", true);
      assertThat(feedback.publish(id, publish).path("status").asText()).isEqualTo("uncertain");
      assertThat(store.review(id, null).path("state").path("drafts").size()).isEqualTo(1);
      Path providerState = fixture.resolve("state.json");
      ObjectNode forged = (ObjectNode) json.readTree(Files.readString(providerState));
      ((ObjectNode) forged.path("comments").get(0)).putObject("user").put("login", "another-user");
      Files.writeString(providerState, json.writeValueAsString(forged));
      assertThat(feedback.publish(id, publish).path("status").asText()).isEqualTo("uncertain");
      assertThat(store.review(id, null).path("state").path("drafts").size()).isEqualTo(1);
      ((ObjectNode) forged.path("comments").get(0)).putObject("user").put("login", "reviewer");
      Files.writeString(providerState, json.writeValueAsString(forged));
      assertThat(feedback.publish(id, publish).path("status").asText()).isEqualTo("complete");
      assertThat(
              json.readTree(Files.readString(fixture.resolve("state.json"))).path("reviews").size())
          .isEqualTo(1);
      assertThat(store.review(id, null).path("state").path("drafts").size()).isZero();
      control(fixture, "failPublish", false);
      control(fixture, "failDefinite", true);
      review = operations.mutate(id, draft, "drafts", null);
      String retainedId = review.path("state").path("drafts").get(0).path("id").asText();
      publish.put("submissionId", UUID.randomUUID().toString()).put("decision", "APPROVE");
      publish.putArray("draftIds").add(retainedId);
      assertThat(feedback.publish(id, publish).path("status").asText()).isEqualTo("failed");
      assertThat(store.review(id, null).path("state").path("drafts").size()).isEqualTo(1);
      control(fixture, "failDefinite", false);
      publish.put("submissionId", UUID.randomUUID().toString());
      assertThat(feedback.publish(id, publish).path("status").asText()).isEqualTo("complete");
      // Confirmed inline feedback must not be resent when a later reply is rejected.
      review = operations.mutate(id, draft, "drafts", null);
      String partialInline = review.path("state").path("drafts").get(0).path("id").asText();
      review =
          feedback.replyDraft(
              id,
              json.createObjectNode()
                  .put("snapshotId", snapshot)
                  .put("replyTo", "5000000000000000011")
                  .put("text", "Keep this reply local on failure."));
      String partialReply = review.path("state").path("drafts").get(1).path("id").asText();
      assertThat(review.path("state").path("drafts").get(1).path("replyTo").asText())
          .isEqualTo("5000000000000000011");
      assertThat(
              feedback
                  .checkDraft(
                      id,
                      json.createObjectNode()
                          .put("snapshotId", snapshot)
                          .put("draftId", partialReply))
                  .path("state")
                  .path("drafts")
                  .size())
          .isEqualTo(2);
      publish
          .put("submissionId", UUID.randomUUID().toString())
          .put("decision", "COMMENT")
          .put("message", "");
      publish.putArray("draftIds").add(partialInline).add(partialReply);
      control(fixture, "failReply", true);
      assertThat(feedback.publish(id, publish).path("status").asText()).isEqualTo("failed");
      JsonNode retained = github.open(42, 7).path("state").path("drafts");
      assertThat(retained.size()).isEqualTo(1);
      assertThat(retained.get(0).path("id").asText()).isEqualTo(partialReply);
      assertThat(retained.get(0).path("text").asText())
          .isEqualTo("Keep this reply local on failure.");
      int publishedReviews =
          json.readTree(Files.readString(fixture.resolve("state.json"))).path("reviews").size();
      control(fixture, "failReply", false);
      control(fixture, "failReplyUncertain", true);
      publish.put("submissionId", UUID.randomUUID().toString());
      publish.putArray("draftIds").add(partialReply);
      assertThat(feedback.publish(id, publish).path("status").asText()).isEqualTo("uncertain");
      assertThat(store.review(id, null).path("state").path("drafts").size()).isEqualTo(1);
      assertThat(feedback.publish(id, publish).path("status").asText()).isEqualTo("complete");
      control(fixture, "failReplyUncertain", false);
      assertThat(store.review(id, null).path("state").path("drafts").size()).isZero();
      assertThat(
              json.readTree(Files.readString(fixture.resolve("state.json"))).path("reviews").size())
          .isEqualTo(publishedReviews);
      control(fixture, "newHead", true);
      assertThat(feedback.status(id).path("newCommits").asBoolean()).isTrue();
      assertThat(github.open(42, 7).path("snapshot").path("id").asText()).isEqualTo(snapshot);
      assertThatThrownBy(() -> feedback.preview(id, publish)).hasMessageContaining("New commits");
      ObjectNode refreshed = github.refresh(id, snapshot);
      assertThat(refreshed.path("history").size()).isEqualTo(2);
      assertThat(
              store
                  .review(id, snapshot)
                  .path("snapshot")
                  .path("files")
                  .get(0)
                  .path("after")
                  .path("text")
                  .asText())
          .contains("value = 2");
      control(fixture, "incomplete", true);
      ObjectNode incomplete = github.refresh(id, refreshed.path("snapshot").path("id").asText());
      publish.put("snapshotId", incomplete.path("snapshot").path("id").asText());
      assertThatThrownBy(() -> feedback.preview(id, publish)).hasMessageContaining("incomplete");
      Path hosts = directory.resolve("data/github-cli/hosts.yml");
      Files.writeString(hosts, "github.com:\n  oauth_token: fixture-plaintext-secret\n");
      assertThatThrownBy(cli::status).hasMessageContaining("Plaintext credentials were rejected");
      assertThat(Files.exists(hosts)).isFalse();
    }
  }
}
