package dev.leanreview.review;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.api.WireInput;
import dev.leanreview.llm.*;
import dev.leanreview.storage.*;
import java.io.IOException;
import java.util.concurrent.*;
import org.springframework.stereotype.Service;

/** Owns one application-wide slot from credential lookup until provider work has settled. */
@Service
public class ReviewAnalysis implements AutoCloseable {
  private final Object gate = new Object();
  private final ReviewStore reviews;
  private final CoreSnapshots snapshots;
  private final ProviderSettings settings;
  private final AnalysisInput inputs;
  private final CoreReview validation;
  private final ProviderInference provider;
  private final ObjectMapper json;
  private final ExecutorService executor =
      new ThreadPoolExecutor(
          1,
          1,
          0L,
          TimeUnit.MILLISECONDS,
          new ArrayBlockingQueue<>(1),
          Thread.ofPlatform().daemon(true).name("review-analysis").factory(),
          new ThreadPoolExecutor.AbortPolicy());
  private Job job;
  private boolean closing;

  private static final class Job {
    final String sessionId, snapshotId, configKey;
    final ObjectNode review;
    final Cancellation cancellation = new Cancellation();
    final CompletableFuture<Void> done = new CompletableFuture<>();

    Job(String sessionId, ObjectNode review, String configKey) {
      this.sessionId = sessionId;
      this.review = review;
      this.snapshotId = review.path("snapshot").path("id").asText();
      this.configKey = configKey;
    }
  }

  public ReviewAnalysis(
      ReviewStore reviews,
      CoreSnapshots snapshots,
      ProviderSettings settings,
      AnalysisInput inputs,
      CoreReview validation,
      ProviderInference provider,
      ObjectMapper json) {
    this.reviews = reviews;
    this.snapshots = snapshots;
    this.settings = settings;
    this.inputs = inputs;
    this.validation = validation;
    this.provider = provider;
    this.json = json;
  }

  public ObjectNode manifest(String sessionId) throws IOException {
    return inputs
        .prepare(reviews.review(sessionId, null).path("snapshot"), settings.current())
        .manifest();
  }

  public ObjectNode start(String sessionId, JsonNode body) throws Exception {
    WireInput.object(body);
    String snapshotId = WireInput.text(body, "snapshotId"),
        manifestId = WireInput.text(body, "manifestId");
    if (!body.path("authorize").isBoolean())
      throw WireInput.invalid("boolean", body.path("authorize"), "authorize");
    ObjectNode review = snapshots.current(sessionId, snapshotId), config = settings.current();
    if (review.path("snapshot").path("files").isEmpty())
      throw new IllegalArgumentException("No changed files to analyze.");
    if (!body.path("authorize").asBoolean())
      throw new IllegalArgumentException(
          "Confirm this run’s input manifest before sending repository data.");
    var prepared = inputs.prepare(review.path("snapshot"), config);
    Job owned;
    synchronized (gate) {
      if (closing) throw new IllegalArgumentException("Application is shutting down.");
      if (job != null)
        throw new IllegalArgumentException(
            "One analysis runs at a time. Cancel or wait for the current run.");
      if (!manifestId.equals(prepared.manifest().path("id").asText()))
        throw new IllegalArgumentException(
            "Provider configuration or snapshot changed. Preview and authorize again.");
      owned = new Job(sessionId, review, settings.key(config));
      job = owned;
    }
    try {
      synchronized (gate) {
        owned.cancellation.check();
        reviews.updateCurrentState(
            sessionId,
            snapshotId,
            state -> {
              state.put("analysisStatus", "running");
              state.remove("analysisError");
              state.set("manifest", prepared.manifest());
              ObjectNode progress =
                  state
                      .putObject("analysisProgress")
                      .put("startedAt", System.currentTimeMillis())
                      .put("updatedAt", System.currentTimeMillis())
                      .put("phase", "preparing")
                      .put("completedBatches", 0)
                      .put("totalBatches", prepared.batches().size())
                      .put("completedFiles", 0)
                      .put("totalFiles", review.path("snapshot").path("files").size())
                      .putNull("estimatedRemainingMs");
              progress.putArray("currentFiles");
            });
      }
      boolean subscription = config.path("provider").asText().equals("codex");
      String token =
          subscription
              ? null
              : settings.token(config); // OS lookup occurs without a database transaction.
      check(owned);
      if (!subscription && !config.path("provider").asText().equals("ollama") && token == null)
        throw new IllegalArgumentException(
            "The API key is unavailable. Enter it in provider settings.");
      ObjectNode response = reviews.review(sessionId, null);
      executor.execute(() -> execute(owned, prepared, config, token));
      return response;
    } catch (Exception failure) {
      try {
        fail(owned, failure);
      } finally {
        release(owned);
      }
      throw failure;
    }
  }

  private void execute(
      Job owned, AnalysisInput.Prepared prepared, ObjectNode config, String token) {
    try {
      ObjectNode combined = json.createObjectNode();
      ArrayNode cohorts = combined.putArray("cohorts"), findings = combined.putArray("findings");
      int completedBatches = 0, completedFiles = 0;
      long elapsed = 0;
      for (ObjectNode batch : prepared.batches()) {
        check(owned);
        long started = System.currentTimeMillis();
        ArrayNode paths = json.createArrayNode();
        batch.path("files").forEach(file -> paths.add(file.path("path").asText()));
        progress(
            owned, json.createObjectNode().put("phase", "connecting").set("currentFiles", paths));
        JsonNode result =
            provider.infer(
                config,
                token,
                batch,
                owned.cancellation,
                phase -> progress(owned, json.createObjectNode().put("phase", phase)));
        check(owned);
        progress(owned, json.createObjectNode().put("phase", "validating"));
        var ids = new java.util.HashSet<String>();
        batch.path("files").forEach(file -> ids.add(file.path("id").asText()));
        ObjectNode subset = json.createObjectNode();
        ArrayNode files = subset.putArray("files");
        owned
            .review
            .path("snapshot")
            .path("files")
            .forEach(
                file -> {
                  if (ids.contains(file.path("id").asText())) files.add(file);
                });
        JsonNode valid = validation.validateAnalysis(result, subset);
        valid.path("cohorts").forEach(cohorts::add);
        valid.path("findings").forEach(findings::add);
        completedBatches++;
        completedFiles += batch.path("files").size();
        elapsed += Math.max(1, System.currentTimeMillis() - started);
        ObjectNode update =
            json.createObjectNode()
                .put("completedBatches", completedBatches)
                .put("completedFiles", completedFiles);
        update.putArray("currentFiles");
        int remaining = prepared.batches().size() - completedBatches;
        if (remaining == 0) update.putNull("estimatedRemainingMs");
        else
          update.put(
              "estimatedRemainingMs", Math.round((double) elapsed / completedBatches * remaining));
        progress(owned, update);
      }
      progress(owned, json.createObjectNode().put("phase", "combining"));
      JsonNode proposal = validation.validateAnalysis(combined, owned.review.path("snapshot"));
      synchronized (gate) {
        check(owned);
        reviews.updateCurrentState(
            owned.sessionId,
            owned.snapshotId,
            state -> {
              state.set("proposal", proposal);
              state.put("analysisStatus", "ready");
              state.remove("analysisError");
            });
      }
    } catch (Exception failure) {
      fail(owned, failure);
    } finally {
      release(owned);
    }
  }

  private void check(Job owned) throws IOException {
    owned.cancellation.check();
    if (!reviews.currentSnapshotId(owned.sessionId).equals(owned.snapshotId)) {
      owned.cancellation.cancel();
      throw new IllegalArgumentException("Snapshot changed. Analysis canceled.");
    }
    if (!settings.key(settings.current()).equals(owned.configKey))
      throw new IllegalArgumentException(
          "Provider configuration or snapshot changed. Preview and authorize again.");
  }

  private void progress(Job owned, ObjectNode update) {
    synchronized (gate) {
      if (job != owned || owned.cancellation.canceled()) return;
      try {
        check(owned);
        reviews.updateCurrentState(
            owned.sessionId,
            owned.snapshotId,
            state -> {
              if (!state.path("analysisStatus").asText().equals("running")
                  || !state.path("analysisProgress").isObject()) return;
              ObjectNode progress = (ObjectNode) state.path("analysisProgress");
              long now = System.currentTimeMillis();
              if (progress.path("estimatedRemainingMs").isNumber())
                progress.put(
                    "estimatedRemainingMs",
                    Math.max(
                        0,
                        progress.path("estimatedRemainingMs").asLong()
                            - (now - progress.path("updatedAt").asLong())));
              progress.setAll(update);
              progress.put("updatedAt", now);
            });
      } catch (IOException error) {
        throw new java.io.UncheckedIOException(error);
      }
    }
  }

  private void fail(Job owned, Exception failure) {
    // Never persist arbitrary parser/provider exception text, which can contain source or secrets.
    String candidate = failure.getMessage();
    java.util.Set<String> publicMessages =
        java.util.Set.of(
            "Provider request timed out.",
            "Provider request failed. Check configuration or retry; the accepted review was"
                + " preserved.",
            "Provider returned invalid structured result.",
            "Provider output was truncated.",
            "Provider did not complete the response.",
            "Provider output was refused or incomplete.",
            "Provider returned no bounded structured result.",
            "The API key is unavailable. Enter it in provider settings.",
            "Provider configuration or snapshot changed. Preview and authorize again.",
            "Analysis contains an empty cohort.",
            "Analysis contains an empty layer.",
            "Analysis contains an invented or duplicated file.",
            "Analysis omitted a changed file.",
            "Finding references an invented file.",
            "Finding line is outside the captured file.");
    String message =
        candidate != null
                && (failure instanceof dev.leanreview.codex.CodexFailure
                    || publicMessages.contains(candidate)
                    || candidate.matches(
                        "Provider returned HTTP [0-9]{3}\\. Check configuration or retry; the"
                            + " accepted review was preserved\\."))
            ? candidate
            : "Analysis failed. The accepted review was preserved.";
    try {
      reviews.updateSnapshotState(
          owned.sessionId,
          owned.snapshotId,
          state -> {
            state.put("analysisStatus", owned.cancellation.canceled() ? "canceled" : "failed");
            state.put(
                "analysisError", owned.cancellation.canceled() ? "Analysis canceled." : message);
          });
    } catch (IOException | RuntimeException unavailable) {
      System.err.println("Could not save analysis failure.");
    }
  }

  public void cancel(String snapshotId) {
    synchronized (gate) {
      if (job != null && job.snapshotId.equals(snapshotId)) {
        job.cancellation.cancel();
        fail(job, new IllegalArgumentException("Analysis canceled."));
      }
    }
  }

  public ObjectNode configure(JsonNode body) throws IOException {
    ObjectNode result = settings.configure(body);
    synchronized (gate) {
      if (job != null) {
        job.cancellation.cancel();
        fail(job, new IllegalArgumentException("Analysis canceled."));
      }
    }
    return result;
  }

  private void release(Job owned) {
    synchronized (gate) {
      if (job == owned) job = null;
      owned.done.complete(null);
    }
  }

  public void close() {
    Job active;
    synchronized (gate) {
      closing = true;
      active = job;
      if (active != null) {
        active.cancellation.cancel();
        fail(active, new IllegalArgumentException("Analysis canceled."));
      }
    }
    executor.shutdown();
    if (active != null)
      try {
        active.done.get(30, TimeUnit.SECONDS);
      } catch (Exception unavailable) {
        executor.shutdownNow();
      }
  }
}
