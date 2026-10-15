package dev.leanreview.review;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.LeanReviewApplication;
import dev.leanreview.credentials.CredentialVault;
import dev.leanreview.llm.*;
import dev.leanreview.storage.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.support.*;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

class ReviewAnalysisTest {
  @TempDir Path directory;
  final ObjectMapper json = new ObjectMapper();

  static class Probe implements ProviderInference {
    final java.util.List<Integer> batchSizes = new java.util.concurrent.CopyOnWriteArrayList<>();
    final AtomicInteger calls = new AtomicInteger();
    final CountDownLatch entered = new CountDownLatch(1);
    volatile CompletableFuture<JsonNode> result;

    public JsonNode infer(JsonNode config, String token, JsonNode input, Cancellation cancellation)
        throws Exception {
      batchSizes.add(input.path("files").size());
      calls.incrementAndGet();
      entered.countDown();
      if (result != null) return result.get(10, TimeUnit.SECONDS);
      var json = new ObjectMapper();
      ObjectNode output = json.createObjectNode();
      var layer =
          output
              .putArray("cohorts")
              .addObject()
              .put("name", "Changes")
              .put("explanation", "")
              .putArray("layers")
              .addObject()
              .put("name", "Read")
              .put("explanation", "");
      var ids = layer.putArray("fileIds");
      input.path("files").forEach(file -> ids.add(file.path("id").asText()));
      output.putArray("findings");
      return output;
    }
  }

  @Test
  void combinesSequentialBatchesWithoutOmittingOrDuplicatingChangedFiles() throws Exception {
    try (var fixture = new Fixture("batches")) {
      ObjectNode snapshot =
          (ObjectNode) fixture.store.review("session-fixture", null).path("snapshot");
      ObjectNode template = (ObjectNode) snapshot.path("files").get(0);
      snapshot.put("id", "batch-snapshot").put("sessionId", "batch-session");
      ArrayNode files = snapshot.putArray("files");
      for (int i = 0; i < 43; i++)
        files.add(
            template
                .deepCopy()
                .put("id", "file-" + i)
                .put("path", "src/f" + i + ".ts")
                .put("oldPath", "src/f" + i + ".ts"));
      fixture.snapshots.create(snapshot);
      fixture.snapshots.setting(
          "provider", fixture.settings.current().put("contextWindow", 100000));
      fixture.analysis.start("batch-session", fixture.request("batch-session"));
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(6);
      while (!fixture
              .store
              .review("batch-session", null)
              .path("state")
              .path("analysisStatus")
              .asText()
              .equals("ready")
          && System.nanoTime() < deadline) Thread.sleep(20);
      JsonNode state = fixture.store.review("batch-session", null).path("state");
      assertThat(state.path("analysisStatus").asText()).isEqualTo("ready");
      assertThat(fixture.probe.batchSizes).containsExactly(20, 20, 3);
      java.util.List<String> ids = new java.util.ArrayList<>();
      for (JsonNode cohort : state.path("proposal").path("cohorts"))
        for (JsonNode layer : cohort.path("layers"))
          layer.path("fileIds").forEach(id -> ids.add(id.asText()));
      assertThat(ids).hasSize(43).doesNotHaveDuplicates();
      assertThat(state.path("accepted").isNull()).isTrue();
    }
  }

  static class Vault implements CredentialVault.Persistent {
    volatile boolean block;
    final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);

    public void set(String account, String token) {}

    public String get(String account) throws Exception {
      if (block) {
        entered.countDown();
        if (!release.await(10, TimeUnit.SECONDS))
          throw new IllegalStateException("Fixture timeout");
      }
      return null;
    }
  }

  class Fixture implements AutoCloseable {
    final Probe probe = new Probe();
    final Vault vault = new Vault();
    final ConfigurableApplicationContext context;
    final ReviewAnalysis analysis;
    final ReviewStore store;
    final CoreSnapshots snapshots;
    final ProviderSettings settings;
    final Path data;

    Fixture(String name) throws Exception {
      data = directory.resolve(name);
      Path source = Path.of("../tests/fixtures/backend-compatibility/databases/v3");
      try (var paths = Files.walk(source)) {
        for (Path file : paths.toList()) {
          Path target = data.resolve(source.relativize(file));
          if (Files.isDirectory(file)) Files.createDirectories(target);
          else Files.copy(file, target);
        }
      }
      context =
          new SpringApplicationBuilder(LeanReviewApplication.class)
              .initializers(
                  application -> {
                    BeanDefinitionRegistry registry =
                        (BeanDefinitionRegistry) application.getBeanFactory();
                    var provider = new RootBeanDefinition(ProviderInference.class);
                    provider.setInstanceSupplier(() -> probe);
                    provider.setPrimary(true);
                    registry.registerBeanDefinition("fixtureInference", provider);
                    var persistent = new RootBeanDefinition(CredentialVault.Persistent.class);
                    persistent.setInstanceSupplier(() -> vault);
                    persistent.setPrimary(true);
                    registry.registerBeanDefinition("fixtureCredentials", persistent);
                  })
              .run(
                  "--spring.main.web-application-type=none",
                  "--leanreview.data-directory=" + data,
                  "--logging.level.root=OFF",
                  "--spring.main.banner-mode=off");
      analysis = context.getBean(ReviewAnalysis.class);
      store = context.getBean(ReviewStore.class);
      snapshots = context.getBean(CoreSnapshots.class);
      settings = context.getBean(ProviderSettings.class);
    }

    ObjectNode request(String session) throws Exception {
      var review = store.review(session, null);
      return json.createObjectNode()
          .put("snapshotId", review.path("snapshot").path("id").asText())
          .put("manifestId", analysis.manifest(session).path("id").asText())
          .put("authorize", true);
    }

    void persistentLookup() throws Exception {
      snapshots.setting(
          "credential-mode:" + settings.key(settings.current()),
          json.getNodeFactory().textNode("os"));
    }

    void otherSession() throws Exception {
      ObjectNode snapshot = (ObjectNode) store.review("session-fixture", null).path("snapshot");
      snapshot.put("id", "other-snapshot").put("sessionId", "other");
      snapshots.create(snapshot);
    }

    JsonNode state() throws Exception {
      return store.review("session-fixture", null).path("state");
    }

    void awaitStatus(String expected) throws Exception {
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(6);
      while (!state().path("analysisStatus").asText().equals(expected)
          && System.nanoTime() < deadline) Thread.sleep(20);
      assertThat(state().path("analysisStatus").asText()).isEqualTo(expected);
    }

    public void close() {
      vault.release.countDown();
      if (probe.result != null) probe.result.completeExceptionally(new CancellationException());
      context.close();
    }
  }

  @Test
  void reservesSlotDuringCredentialsAndKeepsItUntilCanceledWorkSettles() throws Exception {
    try (var fixture = new Fixture("pending");
        var executor = Executors.newVirtualThreadPerTaskExecutor()) {
      fixture.otherSession();
      fixture.persistentLookup();
      fixture.vault.block = true;
      JsonNode accepted = fixture.state().path("accepted").deepCopy();
      JsonNode proposal = fixture.state().path("proposal").deepCopy();
      var request = fixture.request("session-fixture");
      var pending = executor.submit(() -> fixture.analysis.start("session-fixture", request));
      assertThat(fixture.vault.entered.await(5, TimeUnit.SECONDS)).isTrue();
      assertThatThrownBy(() -> fixture.analysis.start("other", fixture.request("other")))
          .hasMessageContaining("One analysis");
      fixture.analysis.cancel("snapshot-current");
      fixture.awaitStatus("canceled");
      assertThatThrownBy(() -> fixture.analysis.start("other", fixture.request("other")))
          .hasMessageContaining("One analysis");
      fixture.vault.release.countDown();
      assertThatThrownBy(() -> pending.get(5, TimeUnit.SECONDS))
          .isInstanceOf(ExecutionException.class)
          .hasCauseInstanceOf(IllegalArgumentException.class);
      assertThat(fixture.probe.calls.get()).isZero();
      assertThat(fixture.state().path("accepted")).isEqualTo(accepted);
      assertThat(fixture.state().path("proposal")).isEqualTo(proposal);
      fixture.analysis.start("other", fixture.request("other"));
    }
  }

  @Test
  void checksSnapshotAndProviderAgainAfterCredentialsBeforeAnyProviderCall() throws Exception {
    for (String change : new String[] {"snapshot", "provider"})
      try (var fixture = new Fixture(change);
          var executor = Executors.newVirtualThreadPerTaskExecutor()) {
        fixture.persistentLookup();
        fixture.vault.block = true;
        var request = fixture.request("session-fixture");
        var pending = executor.submit(() -> fixture.analysis.start("session-fixture", request));
        assertThat(fixture.vault.entered.await(5, TimeUnit.SECONDS)).isTrue();
        if (change.equals("snapshot")) {
          ObjectNode next =
              (ObjectNode) fixture.store.review("session-fixture", null).path("snapshot");
          next.put("id", "refreshed");
          fixture.snapshots.refresh("session-fixture", "snapshot-current", next);
        } else {
          ObjectNode config = fixture.settings.current();
          config.put("model", "changed");
          fixture.snapshots.setting("provider", config);
        }
        fixture.vault.release.countDown();
        assertThatThrownBy(() -> pending.get(5, TimeUnit.SECONDS))
            .isInstanceOf(ExecutionException.class)
            .hasMessageContaining(change.equals("snapshot") ? "Snapshot changed" : "configuration");
        assertThat(fixture.probe.calls.get()).isZero();
      }
  }

  @Test
  void preservesHumanEditsOnSuccessAndNeverPersistsProviderExceptionSecrets() throws Exception {
    try (var fixture = new Fixture("edits")) {
      String token = "fixture-secret-analysis-25";
      ObjectNode configuration = json.createObjectNode();
      configuration.set("config", fixture.settings.current());
      configuration.put("token", token).put("persist", false);
      fixture.analysis.configure(configuration);
      fixture.probe.result = new CompletableFuture<>();
      fixture.analysis.start("session-fixture", fixture.request("session-fixture"));
      assertThat(fixture.probe.entered.await(5, TimeUnit.SECONDS)).isTrue();
      JsonNode accepted = fixture.state().path("accepted").deepCopy();
      fixture.store.updateCurrentState(
          "session-fixture",
          "snapshot-current",
          state -> {
            state.put("futureHumanEdit", "retained");
            state.withArray("reviewed").add("file-java");
          });
      fixture.probe.result.completeExceptionally(
          new IllegalArgumentException("private provider source and " + token));
      fixture.awaitStatus("failed");
      assertThat(fixture.state().path("futureHumanEdit").asText()).isEqualTo("retained");
      assertThat(fixture.state().path("accepted")).isEqualTo(accepted);
      assertThat(fixture.state().path("analysisError").asText())
          .doesNotContain(token, "private provider source");
      fixture.probe.result = null;
      // Wait for the previous worker to release its slot before the next explicit run.
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      while (true)
        try {
          fixture.analysis.start("session-fixture", fixture.request("session-fixture"));
          break;
        } catch (IllegalArgumentException busy) {
          if (!busy.getMessage().startsWith("One analysis") || System.nanoTime() > deadline)
            throw busy;
          Thread.sleep(10);
        }
      fixture.awaitStatus("ready");
      assertThat(fixture.state().path("proposal").path("cohorts").isEmpty()).isFalse();
      assertThat(fixture.state().path("accepted")).isEqualTo(accepted);
      assertThat(fixture.state().path("futureHumanEdit").asText()).isEqualTo("retained");
      fixture.context
          .close(); // Inspect consistent, unlocked SQLite files after the application stops.
      try (var files = Files.walk(fixture.data)) {
        for (Path file : files.filter(Files::isRegularFile).toList())
          assertThat(
                  new String(
                      Files.readAllBytes(file), java.nio.charset.StandardCharsets.ISO_8859_1))
              .doesNotContain(token);
      }
    }
  }

  @Test
  void cancelAndRefreshDiscardLateResultsAndKeepNewSnapshotIdle() throws Exception {
    try (var fixture = new Fixture("refresh")) {
      fixture.probe.result = new CompletableFuture<>();
      fixture.analysis.start("session-fixture", fixture.request("session-fixture"));
      assertThat(fixture.probe.entered.await(5, TimeUnit.SECONDS)).isTrue();
      fixture.analysis.cancel("snapshot-current");
      ObjectNode next = (ObjectNode) fixture.store.review("session-fixture", null).path("snapshot");
      next.put("id", "refreshed");
      fixture.snapshots.refresh("session-fixture", "snapshot-current", next);
      assertThatThrownBy(
              () -> fixture.analysis.start("session-fixture", fixture.request("session-fixture")))
          .hasMessageContaining("One analysis");
      fixture.probe.result.complete(json.createObjectNode());
      fixture.analysis.close();
      assertThat(fixture.state().path("analysisStatus").asText()).isEqualTo("idle");
      assertThat(fixture.state().path("proposal").isNull()).isTrue();
      assertThat(
              fixture
                  .store
                  .review("session-fixture", "snapshot-current")
                  .path("state")
                  .path("analysisStatus")
                  .asText())
          .isEqualTo("canceled");
    }
  }

  @Test
  void malformedAndInventedResultsPreserveAcceptedReviewAndDrafts() throws Exception {
    try (var fixture = new Fixture("invalid")) {
      JsonNode accepted = fixture.state().path("accepted").deepCopy(),
          drafts = fixture.state().path("drafts").deepCopy();
      fixture.probe.result = new CompletableFuture<>();
      fixture.analysis.start("session-fixture", fixture.request("session-fixture"));
      assertThat(fixture.probe.entered.await(5, TimeUnit.SECONDS)).isTrue();
      ObjectNode invalid = json.createObjectNode();
      invalid
          .putArray("cohorts")
          .addObject()
          .put("name", "Changes")
          .put("explanation", "")
          .putArray("layers")
          .addObject()
          .put("name", "Read")
          .put("explanation", "")
          .putArray("fileIds")
          .add("invented-file");
      invalid.putArray("findings");
      fixture.probe.result.complete(invalid);
      fixture.awaitStatus("failed");
      assertThat(fixture.state().path("accepted")).isEqualTo(accepted);
      assertThat(fixture.state().path("drafts")).isEqualTo(drafts);
      assertThat(fixture.state().path("analysisError").asText())
          .isEqualTo("Analysis contains an invented or duplicated file.");
    }
  }
}
