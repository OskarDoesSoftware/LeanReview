package dev.leanreview.storage;

import static org.assertj.core.api.Assertions.*;

import dev.leanreview.LeanReviewApplication;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

class ReviewStateTest {
  @TempDir Path temporary;

  @Test
  void competingRefreshesAcceptOnlyOneAndRetainLatestProgress() throws Exception {
    try (var context = start();
        var executor = Executors.newFixedThreadPool(2)) {
      var store = context.getBean(ReviewStore.class);
      var snapshots = context.getBean(CoreSnapshots.class);
      var captured =
          (com.fasterxml.jackson.databind.node.ObjectNode)
              store.review("session-fixture", null).path("snapshot");
      store.updateCurrentState(
          "session-fixture",
          "snapshot-current",
          state -> state.withArray("reviewed").add("file-java"));
      var go = new CountDownLatch(1);
      var outcomes = new ArrayList<Future<Boolean>>();
      for (int i = 0; i < 2; i++) {
        var next =
            captured
                .deepCopy()
                .put("id", java.util.UUID.randomUUID().toString())
                .put("capturedAt", "2026-10-15T12:00:00.000Z");
        outcomes.add(
            executor.submit(
                () -> {
                  go.await();
                  try {
                    snapshots.refresh("session-fixture", "snapshot-current", next);
                    return true;
                  } catch (IllegalArgumentException stale) {
                    assertThat(stale)
                        .hasMessage("Snapshot changed. Reload this review before editing.");
                    return false;
                  }
                }));
      }
      go.countDown();
      int accepted = 0;
      for (var outcome : outcomes) if (outcome.get(30, TimeUnit.SECONDS)) accepted++;
      assertThat(accepted).isEqualTo(1);
      var review = store.review("session-fixture", null);
      assertThat(review.path("history").size()).isEqualTo(3);
      assertThat(review.path("state").path("reviewed").toString()).contains("file-java");
      assertThat(
              store
                  .review("session-fixture", "snapshot-current")
                  .path("state")
                  .path("reviewed")
                  .toString())
          .contains("file-java");
    }
  }

  private ConfigurableApplicationContext start() throws Exception {
    Path source = Path.of("../tests/fixtures/backend-compatibility/databases/v3");
    try (var paths = Files.walk(source)) {
      for (Path file : paths.toList()) {
        Path destination = temporary.resolve(source.relativize(file));
        if (Files.isDirectory(file)) Files.createDirectories(destination);
        else Files.copy(file, destination);
      }
    }
    return new SpringApplicationBuilder(LeanReviewApplication.class)
        .run(
            "--leanreview.data-directory=" + temporary,
            "--logging.level.root=OFF",
            "--spring.main.banner-mode=off");
  }

  @Test
  void stateEditsPreserveOtherFieldsAndRejectHistoricalSnapshots() throws Exception {
    try (var context = start()) {
      var store = context.getBean(ReviewStore.class);
      var before = store.review("session-fixture", null).path("state");
      var edited =
          store
              .updateCurrentState(
                  "session-fixture",
                  "snapshot-current",
                  state -> state.put("futureField", "preserved"))
              .path("state");
      assertThat(edited.path("drafts")).isEqualTo(before.path("drafts"));
      assertThat(edited.path("reviewed")).isEqualTo(before.path("reviewed"));
      assertThat(edited.path("futureField").asText()).isEqualTo("preserved");
      assertThatThrownBy(
              () ->
                  store.updateCurrentState(
                      "session-fixture",
                      "snapshot-history",
                      state -> state.put("futureField", "invalid")))
          .hasMessage("Snapshot changed. Reload this review before editing.");
      assertThat(store.review("session-fixture", null).path("state")).isEqualTo(edited);
    }
  }

  @Test
  void invalidEditsRollbackWithoutChangingTheSavedReview() throws Exception {
    try (var context = start()) {
      var store = context.getBean(ReviewStore.class);
      var before = store.review("session-fixture", null);
      assertThatThrownBy(
              () ->
                  store.updateCurrentState(
                      "session-fixture",
                      "snapshot-current",
                      state -> {
                        state.put("analysisStatus", "invalid");
                        throw new IllegalArgumentException("Invalid edit.");
                      }))
          .hasMessage("Invalid edit.");
      assertThat(store.review("session-fixture", null)).isEqualTo(before);
    }
  }

  @Test
  void simultaneousReviewEditsDoNotOverwriteEachOther() throws Exception {
    try (var context = start();
        var executor = Executors.newFixedThreadPool(4)) {
      var store = context.getBean(ReviewStore.class);
      var go = new CountDownLatch(1);
      var ready = new CountDownLatch(4);
      var pending = new ArrayList<Future<?>>();
      for (int worker = 0; worker < 4; worker++) {
        final String field = "edit-" + worker;
        pending.add(
            executor.submit(
                () -> {
                  ready.countDown();
                  if (!go.await(10, TimeUnit.SECONDS))
                    throw new IllegalStateException("No start signal");
                  for (int edit = 0; edit < 5; edit++) {
                    store.updateCurrentState(
                        "session-fixture",
                        "snapshot-current",
                        state -> state.put(field, state.path(field).asInt() + 1));
                  }
                  return null;
                }));
      }
      assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
      go.countDown();
      for (var task : pending) task.get(30, TimeUnit.SECONDS);
      var state = store.review("session-fixture", null).path("state");
      for (int worker = 0; worker < 4; worker++)
        assertThat(state.path("edit-" + worker).asInt()).isEqualTo(5);
      assertThat(state.path("drafts").size()).isPositive();
    }
  }
}
