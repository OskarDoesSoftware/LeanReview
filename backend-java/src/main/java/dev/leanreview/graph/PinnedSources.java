package dev.leanreview.graph;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.analysis.AnalysisHelper;
import dev.leanreview.llm.Cancellation;
import dev.leanreview.storage.CapturedArtifacts;
import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Immutable inventory and captured overlays; never reads the live working tree. */
public final class PinnedSources implements AutoCloseable {
  public final List<String> paths;
  public final String revision;
  public final boolean complete;
  private final Map<String, JsonNode> blobs = new HashMap<>(), overlay = new HashMap<>();
  private final Map<String, String> cache = new HashMap<>();
  private final JsonNode snapshot;
  private final Cancellation cancellation;
  private Process process;
  private InputStream output;
  private OutputStream input;
  private AutoCloseable registration;
  private final ScheduledExecutorService timer =
      Executors.newSingleThreadScheduledExecutor(Thread.ofVirtual().factory());

  public PinnedSources(JsonNode snapshot, String side, ObjectMapper json, Cancellation cancellation)
      throws IOException {
    this.snapshot = snapshot;
    this.cancellation = cancellation;
    JsonNode inventory = snapshot.path("graphContext").path(side);
    complete = inventory.path("complete").asBoolean(false);
    for (JsonNode entry : inventory.path("entries")) blobs.put(entry.path("path").asText(), entry);
    ArrayNode fingerprints = json.createArrayNode();
    for (JsonNode file : snapshot.path("files")) {
      String name = file.path(side.equals("before") ? "oldPath" : "path").asText();
      if (side.equals("after") && !file.path("oldPath").asText().equals(name))
        blobs.remove(file.path("oldPath").asText());
      overlay.put(name, file.path(side));
      if (file.path(side).path("kind").asText().equals("absent")) blobs.remove(name);
      fingerprints.add(json.createArrayNode().add(file.path("id")).add(file.path("fingerprint")));
    }
    TreeSet<String> listed = new TreeSet<>(blobs.keySet());
    listed.addAll(overlay.keySet());
    listed.removeIf(
        name ->
            overlay.containsKey(name) && overlay.get(name).path("kind").asText().equals("absent"));
    paths = List.copyOf(listed);
    ArrayNode identity = json.createArrayNode();
    identity.add(
        inventory.isMissingNode() || inventory.isNull()
            ? json.getNodeFactory().textNode("context-unavailable")
            : inventory);
    identity.add(fingerprints).add(side);
    revision = CapturedArtifacts.digest(json.writeValueAsString(identity));
  }

  public String read(String name) throws IOException {
    cancellation.check();
    if (name.startsWith("/")
        || Arrays.stream(name.split("[/\\\\]", -1))
            .anyMatch(p -> p.equals("..") || p.equals(".git")))
      throw new IOException("Invalid pinned source path.");
    JsonNode captured = overlay.get(name);
    if (captured != null) {
      if (!captured.path("kind").asText().equals("text"))
        throw new IOException(
            captured.path("reason").asText("Source " + captured.path("kind").asText()));
      return captured.path("text").asText();
    }
    JsonNode entry = blobs.get(name);
    if (entry == null
        || !entry.path("mode").asText().matches("100(644|755)")
        || !entry.path("oid").asText().matches("[a-f0-9]{40,64}"))
      throw new IOException("Pinned blob unavailable or non-regular file.");
    String oid = entry.path("oid").asText();
    if (cache.containsKey(oid)) return cache.get(oid);
    initialize();
    ScheduledFuture<?> timeout =
        timer.schedule(() -> AnalysisHelper.kill(process), 30, TimeUnit.SECONDS);
    try {
      input.write(("info " + oid + "\n").getBytes(StandardCharsets.US_ASCII));
      input.flush();
      int size = header(oid);
      if (size > 2 * 1024 * 1024) throw new IOException("Source exceeds 2 MiB file limit.");
      input.write(("contents " + oid + "\n").getBytes(StandardCharsets.US_ASCII));
      input.flush();
      if (header(oid) != size) throw new IOException("Git blob size changed unexpectedly.");
      byte[] bytes = output.readNBytes(size);
      if (bytes.length != size || output.read() != 10)
        throw new IOException("Invalid Git blob terminator.");
      for (byte value : bytes) if (value == 0) throw new IOException("Binary source unavailable.");
      String text;
      try {
        text =
            StandardCharsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString();
      } catch (CharacterCodingException error) {
        throw new IOException("Source is not valid UTF-8.");
      }
      cache.put(oid, text);
      return text;
    } finally {
      timeout.cancel(false);
    }
  }

  private void initialize() throws IOException {
    if (process != null) return;
    ProcessBuilder builder =
        new ProcessBuilder(
                "git",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.hooksPath=",
                "-c",
                "diff.external=",
                "cat-file",
                "--batch-command")
            .directory(Path.of(snapshot.path("root").asText()).toFile())
            .redirectError(ProcessBuilder.Redirect.DISCARD);
    builder
        .environment()
        .keySet()
        .removeIf(key -> key.startsWith("GIT_") && !key.equals("GIT_EXEC_PATH"));
    builder.environment().put("GIT_TERMINAL_PROMPT", "0");
    process = builder.start();
    output = new BufferedInputStream(process.getInputStream());
    input = process.getOutputStream();
    registration = cancellation.register(() -> AnalysisHelper.kill(process));
  }

  private int header(String oid) throws IOException {
    StringBuilder line = new StringBuilder();
    int next;
    while ((next = output.read()) != 10) {
      if (next == -1 || line.length() >= 256) throw new IOException("Invalid Git batch header.");
      line.append((char) next);
    }
    String[] parts = line.toString().split(" ");
    if (parts.length != 3 || !parts[0].equals(oid) || !parts[1].equals("blob"))
      throw new IOException("Pinned Git blob missing or invalid.");
    try {
      int size = Integer.parseInt(parts[2]);
      if (size < 0) throw new NumberFormatException();
      return size;
    } catch (NumberFormatException error) {
      throw new IOException("Invalid Git batch header.");
    }
  }

  public void close() {
    if (process != null) AnalysisHelper.kill(process);
    timer.shutdownNow();
    try {
      if (registration != null) registration.close();
    } catch (Exception ignored) {
    }
  }
}
