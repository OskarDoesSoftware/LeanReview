package dev.leanreview.graph;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.analysis.AnalysisStore;
import dev.leanreview.llm.Cancellation;
import dev.leanreview.storage.CapturedArtifacts;
import jakarta.annotation.PreDestroy;
import java.io.*;
import java.util.concurrent.*;
import org.springframework.stereotype.Service;

@Service
public class GraphJobs {
  private final ObjectMapper json;
  private final AnalysisStore store;
  private final CapturedArtifacts artifacts;
  private final GraphScanner scanner;
  private final ExecutorService workers =
      Executors.newSingleThreadExecutor(Thread.ofVirtual().factory());
  private Cancellation active;
  private String activeSnapshot;
  private boolean closing;

  public GraphJobs(
      ObjectMapper json, AnalysisStore store, CapturedArtifacts artifacts, GraphScanner scanner) {
    this.json = json;
    this.store = store;
    this.artifacts = artifacts;
    this.scanner = scanner;
  }

  public ObjectNode view(String snapshot, String side, boolean statusOnly) throws IOException {
    ObjectNode saved = store.graph(snapshot, side);
    ObjectNode result = json.createObjectNode();
    result.set(
        "graph",
        statusOnly || saved.path("artifact").isNull()
            ? NullNode.instance
            : json.readTree(artifacts.read(saved.path("artifact").asText())));
    result.set("run", saved.path("run"));
    return result;
  }

  public ObjectNode source(String snapshot, String side, String node) throws IOException {
    ObjectNode saved = store.graph(snapshot, side);
    JsonNode graph = view(snapshot, side, false).path("graph"), selected = null;
    for (JsonNode n : graph.path("nodes")) if (n.path("id").asText().equals(node)) selected = n;
    if (selected == null || !selected.has("path"))
      throw new IllegalArgumentException("Select a captured source node.");
    String path = selected.path("path").asText(),
        hash = saved.path("sources").path(path).asText(null);
    if (hash == null)
      throw new IllegalArgumentException("Source was not scanned; raise limits and rerun.");
    return json.createObjectNode()
        .put("path", path)
        .put("text", artifacts.read(hash))
        .put("line", selected.path("line").asInt(1));
  }

  public synchronized ObjectNode start(JsonNode snapshot, ObjectNode options) throws IOException {
    if (active != null || closing)
      throw new IllegalArgumentException("A graph scan is already running. Cancel or wait for it.");
    String id = snapshot.path("id").asText(), side = options.path("side").asText();
    ObjectNode run =
        json.createObjectNode()
            .put("status", "running")
            .put("startedAt", dev.leanreview.git.LocalSnapshots.now());
    Cancellation cancel = new Cancellation();
    try (PinnedSources sources = new PinnedSources(snapshot, side, json, cancel)) {
      run.set("progress", scanner.initialProgress(sources, options));
    }
    store.graphRun(id, side, run, null, null);
    active = cancel;
    activeSnapshot = id;
    // A damaged prior graph may make the initial view fail. The owned rerun must still
    // settle and release its slot, and can rebuild that graph from pinned source artifacts.
    try {
      return view(id, side, false);
    } finally {
      workers.submit(() -> execute(snapshot, options, run, cancel));
    }
  }

  private void execute(JsonNode snapshot, ObjectNode options, ObjectNode run, Cancellation cancel) {
    String id = snapshot.path("id").asText(), side = options.path("side").asText();
    try (PinnedSources sources = new PinnedSources(snapshot, side, json, cancel)) {
      ObjectNode hashes = (ObjectNode) store.graph(id, side).path("sources");
      long[] last = {0};
      String[] phase = {""};
      ObjectNode graph =
          scanner.scan(
              snapshot,
              options,
              sources,
              name -> {
                cancel.check();
                if (hashes.has(name)) return artifacts.read(hashes.path(name).asText());
                String text = sources.read(name);
                hashes.put(name, artifacts.write(text));
                return text;
              },
              cancel,
              value -> {
                long now = System.nanoTime();
                String next = value.path("phase").asText();
                if (next.equals(phase[0]) && now - last[0] < 150_000_000) return;
                phase[0] = next;
                last[0] = now;
                run.set("progress", value);
                try {
                  store.graphRun(id, side, run, null, null);
                } catch (IOException error) {
                  throw new UncheckedIOException(error);
                }
              });
      cancel.check();
      String hash = artifacts.write(json.writeValueAsString(graph));
      synchronized (this) {
        cancel.check();
        run.put("status", "succeeded").put("finishedAt", dev.leanreview.git.LocalSnapshots.now());
        store.graphRun(id, side, run, hash, hashes);
      }
    } catch (Exception error) {
      run.put("status", cancel.canceled() ? "canceled" : "failed")
          .put("error", cancel.canceled() ? "Graph scan canceled." : safe(error))
          .put("finishedAt", dev.leanreview.git.LocalSnapshots.now());
      try {
        store.graphRun(id, side, run, null, null);
      } catch (IOException ignored) {
      }
    } finally {
      synchronized (this) {
        if (active == cancel) {
          active = null;
          activeSnapshot = null;
        }
      }
    }
  }

  private String safe(Exception error) {
    if (error instanceof IOException
        && error.getMessage() != null
        && error.getMessage().startsWith("Analysis helper")) return error.getMessage();
    return "Graph scan failed. Verify captured artifacts and the pinned helper.";
  }

  public synchronized void cancel(String snapshot) {
    if (snapshot.equals(activeSnapshot) && active != null) active.cancel();
  }

  @PreDestroy
  public void close() {
    synchronized (this) {
      closing = true;
      if (active != null) active.cancel();
    }
    workers.shutdown();
    try {
      if (!workers.awaitTermination(30, TimeUnit.SECONDS)) workers.shutdownNow();
    } catch (InterruptedException e) {
      workers.shutdownNow();
      Thread.currentThread().interrupt();
    }
  }
}
