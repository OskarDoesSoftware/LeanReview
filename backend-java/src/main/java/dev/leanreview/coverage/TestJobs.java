package dev.leanreview.coverage;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.analysis.*;
import dev.leanreview.git.*;
import dev.leanreview.llm.Cancellation;
import dev.leanreview.storage.*;
import jakarta.annotation.PreDestroy;
import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.stereotype.Service;

/** Repository commands execute only after an expiring, checkout-bound, single-use preview. */
@Service
public class TestJobs {
  private final ObjectMapper json;
  private final CoreSnapshots snapshots;
  private final AnalysisStore store;
  private final CapturedArtifacts artifacts;
  private final CoverageMetrics metrics;
  private final Map<String, Prepared> previews = new HashMap<>();
  private final ExecutorService worker =
      Executors.newSingleThreadExecutor(Thread.ofVirtual().factory());
  private Cancellation active;
  private String activeId;
  private boolean closing;

  private record Prepared(
      ObjectNode preview,
      JsonNode snapshot,
      Map<String, String> hashes,
      String previous,
      Path report) {}

  private static final Set<String> ENV =
      Set.of(
          "PATH",
          "Path",
          "PATHEXT",
          "SystemRoot",
          "SYSTEMROOT",
          "WINDIR",
          "COMSPEC",
          "TEMP",
          "TMP",
          "HOME",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "JAVA_HOME",
          "LANG",
          "LC_ALL",
          "TERM",
          "NVM_HOME",
          "NVM_SYMLINK");

  public TestJobs(
      ObjectMapper json,
      CoreSnapshots snapshots,
      AnalysisStore store,
      CapturedArtifacts artifacts,
      CoverageMetrics metrics) {
    this.json = json;
    this.snapshots = snapshots;
    this.store = store;
    this.artifacts = artifacts;
    this.metrics = metrics;
  }

  private String key(String root, String format) {
    String identity = root;
    try {
      identity = Path.of(root).toRealPath().toString();
    } catch (IOException unavailable) {
      // Saved reviews remain readable when their original checkout is unavailable.
    }
    return "coverage-test:" + CapturedArtifacts.digest(identity) + ":" + format;
  }

  public JsonNode config(String root, String format) throws IOException {
    return snapshots.setting(key(root, format));
  }

  public void config(String root, JsonNode value) throws IOException {
    snapshots.setting(key(root, value.path("format").asText()), value);
  }

  public synchronized ObjectNode prepare(JsonNode snapshot, String format) throws IOException {
    JsonNode config = config(snapshot.path("root").asText(), format);
    if (config == null || config.isNull())
      throw new IllegalArgumentException("Save a test/coverage configuration first.");
    Path root = Path.of(snapshot.path("root").asText()),
        cwd = LocalSnapshots.contained(root, config.path("cwd").asText());
    if (!Files.isDirectory(cwd))
      throw new IllegalArgumentException("Test working directory must be a directory.");
    Path report = safeReport(root, config.path("reportPath").asText());
    Map<String, String> hashes = checkout(snapshot);
    ObjectNode preview =
        json.createObjectNode()
            .put("id", UUID.randomUUID().toString())
            .put("snapshotId", snapshot.path("id").asText());
    preview.set("config", config.deepCopy());
    preview
        .put("root", snapshot.path("root").asText())
        .put("workingDirectory", cwd.toString())
        .put("sourceCount", hashes.size())
        .put(
            "expiresAt",
            new java.time.format.DateTimeFormatterBuilder()
                .appendInstant(3)
                .toFormatter()
                .format(Instant.now().plusSeconds(300)));
    previews
        .values()
        .removeIf(p -> Instant.parse(p.preview.path("expiresAt").asText()).isBefore(Instant.now()));
    previews.put(
        preview.path("id").asText(),
        new Prepared(preview, snapshot, hashes, identity(report), report));
    return preview.deepCopy();
  }

  public synchronized ObjectNode start(JsonNode snapshot, String previewId) throws IOException {
    if (active != null || closing)
      throw new IllegalArgumentException("A test run is already active. Cancel or wait for it.");
    Prepared p = previews.get(previewId);
    if (p == null
        || Instant.parse(p.preview.path("expiresAt").asText()).isBefore(Instant.now())
        || !p.snapshot.path("id").equals(snapshot.path("id"))
        || !Objects.equals(
            config(
                snapshot.path("root").asText(), p.preview.path("config").path("format").asText()),
            p.preview.path("config")))
      throw new IllegalArgumentException(
          "Test preview expired or configuration changed. Preview again.");
    if (!checkout(snapshot).equals(p.hashes) || !Objects.equals(identity(p.report), p.previous))
      throw new IllegalArgumentException("Source/report changed since preview. Preview again.");
    previews.remove(previewId);
    ObjectNode run =
        json.createObjectNode()
            .put("id", UUID.randomUUID().toString())
            .put("snapshotId", snapshot.path("id").asText());
    run.set("config", p.preview.path("config").deepCopy());
    run.put("startedAt", dev.leanreview.git.LocalSnapshots.now())
        .put("status", "running")
        .put("log", "");
    store.saveTest(run);
    Cancellation cancel = new Cancellation();
    active = cancel;
    activeId = run.path("id").asText();
    worker.submit(() -> execute(p, run, cancel));
    return run.deepCopy();
  }

  private void execute(Prepared p, ObjectNode run, Cancellation cancel) {
    ScheduledExecutorService timer =
        Executors.newSingleThreadScheduledExecutor(Thread.ofVirtual().factory());
    var timeout =
        timer.schedule(
            () -> {
              synchronized (run) {
                run.put("error", "Test run exceeded its configured timeout.");
              }
              cancel.cancel();
            },
            run.path("config").path("timeoutSeconds").asInt(),
            TimeUnit.SECONDS);
    try {
      JsonNode config = run.path("config");
      int index = 0;
      for (JsonNode step : config.path("steps")) {
        cancel.check();
        append(
            run,
            "\nStep "
                + (++index)
                + "/"
                + config.path("steps").size()
                + ": "
                + step.path("executable").asText()
                + "\n");
        Path root = Path.of(p.snapshot.path("root").asText());
        Path cwd = LocalSnapshots.contained(root, config.path("cwd").asText());
        if (!cwd.toString().equals(p.preview.path("workingDirectory").asText()))
          throw new IllegalArgumentException("Test working directory changed since preview.");
        runStep(step, cwd, index, run, cancel);
      }
      cancel.check();
      Map<String, String> after = checkout(p.snapshot);
      if (!after.equals(p.hashes))
        throw new IllegalArgumentException(
            "Source changed while tests ran; measurement discarded.");
      Path report =
          LocalSnapshots.contained(
              Path.of(p.snapshot.path("root").asText()), config.path("reportPath").asText());
      if (Objects.equals(identity(report), p.previous))
        throw new IllegalArgumentException(
            "Coverage report was not regenerated. Existing reports are not accepted as a new"
                + " measurement.");
      if (Files.size(report) > 20 * 1024 * 1024)
        throw new IllegalArgumentException("Coverage report exceeds 20 MiB.");
      String raw = utf8(readBounded(report, 20 * 1024 * 1024, "Coverage report exceeds 20 MiB."));
      ObjectNode provenance =
          json.createObjectNode()
              .put("version", 1)
              .put("reportHash", CapturedArtifacts.digest(raw));
      provenance.set("sourceHashes", json.valueToTree(after));
      provenance.set("head", p.snapshot.path("head"));
      provenance
          .put("capturedAt", dev.leanreview.git.LocalSnapshots.now())
          .put("tool", "LeanReview explicit " + config.path("format").asText() + " test run");
      ObjectNode measured =
          metrics.measure(
              p.snapshot,
              config.path("format").asText(),
              raw,
              provenance,
              config.path("threshold").asDouble(),
              cancel);
      cancel.check();
      String hash = artifacts.write(raw);
      store.saveCoverage(measured, hash, provenance);
      run.set("metrics", measured);
      run.set("provenance", provenance);
      Path sidecar = Path.of(report + ".leanreview.json"),
          temporary = Path.of(sidecar + "." + UUID.randomUUID() + ".tmp");
      try {
        Files.writeString(
            temporary,
            json.writerWithDefaultPrettyPrinter().writeValueAsString(provenance),
            StandardOpenOption.CREATE_NEW);
        Files.move(
            temporary,
            sidecar,
            StandardCopyOption.REPLACE_EXISTING,
            StandardCopyOption.ATOMIC_MOVE);
      } catch (IOException error) {
        append(
            run,
            "\nSidecar export failed. Download the saved provenance from LeanReview instead.\n");
        try {
          Files.deleteIfExists(temporary);
        } catch (IOException ignored) {
        }
      }
      run.put("status", "succeeded");
    } catch (Exception error) {
      synchronized (run) {
        run.put("status", cancel.canceled() && !run.has("error") ? "canceled" : "failed");
        if (!run.has("error"))
          run.put("error", cancel.canceled() ? "Test run canceled." : safe(error));
      }
    } finally {
      timeout.cancel(false);
      timer.shutdownNow();
      synchronized (run) {
        run.put("finishedAt", dev.leanreview.git.LocalSnapshots.now());
        try {
          store.saveTest(run);
        } catch (IOException ignored) {
        }
      }
      synchronized (this) {
        if (active == cancel) {
          active = null;
          activeId = null;
        }
      }
    }
  }

  private void runStep(JsonNode step, Path cwd, int index, ObjectNode run, Cancellation cancel)
      throws Exception {
    List<String> command = new ArrayList<>();
    command.add(
        step.path("shell").asBoolean()
            ? step.path("executable").asText()
            : AnalysisHelper.executable(step.path("executable").asText()));
    for (JsonNode arg : step.path("args")) command.add(arg.asText());
    Path shellScript = null;
    if (step.path("shell").asBoolean()) {
      // Shell interpretation is explicitly displayed and approved in the preview.
      String line = String.join(" ", command);
      if (System.getProperty("os.name").startsWith("Windows")) {
        // cmd.exe does not use CRT quote escaping. Keep the explicitly approved shell text
        // in an owned command file rather than passing it through CRT argument quoting.
        shellScript = Files.createTempFile("leanreview-step-", ".cmd");
        Files.writeString(shellScript, "@echo off\r\n" + line + "\r\nexit /b %errorlevel%\r\n");
        command = List.of(AnalysisHelper.executable("cmd.exe"), "/d", "/c", shellScript.toString());
      } else command = List.of("/bin/sh", "-c", line);
    }
    ProcessBuilder builder =
        new ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true);
    builder.environment().keySet().removeIf(key -> !ENV.contains(key));
    Process process;
    try {
      process = builder.start();
      process.getOutputStream().close();
    } catch (IOException | IllegalArgumentException error) {
      if (shellScript != null) Files.deleteIfExists(shellScript);
      throw new IllegalArgumentException(
          "Test executable could not start. Check prerequisites and executable path.");
    }
    try (var readers = Executors.newVirtualThreadPerTaskExecutor();
        var registration = cancel.register(() -> AnalysisHelper.kill(process))) {
      Future<?> output =
          readers.submit(
              () -> {
                try (InputStream input = process.getInputStream()) {
                  byte[] buffer = new byte[4096];
                  int count;
                  while ((count = input.read(buffer)) != -1)
                    append(run, new String(buffer, 0, count, StandardCharsets.UTF_8));
                } catch (IOException error) {
                  if (!cancel.canceled()) throw new UncheckedIOException(error);
                }
              });
      try {
        process.waitFor();
        output.get(5, TimeUnit.SECONDS);
        cancel.check();
        if (process.exitValue() != 0)
          throw new IllegalArgumentException(
              "Test step "
                  + index
                  + " exited with code "
                  + process.exitValue()
                  + ". Previous measurements were preserved.");
      } finally {
        AnalysisHelper.kill(process);
      }
    } finally {
      AnalysisHelper.kill(process);
      if (shellScript != null) Files.deleteIfExists(shellScript);
    }
  }

  private void append(ObjectNode run, String text) {
    synchronized (run) {
      String log = run.path("log").asText() + text;
      if (log.length() > 65536) log = log.substring(log.length() - 65536);
      log =
          log.replaceAll("(?i)(Bearer\\s+)\\S+", "$1<REDACTED>")
              .replaceAll(
                  "(?i)((?:api[_-]?key|token|password|authorization)\\s*[=:]\\s*)[^\\s,;]+",
                  "$1<REDACTED>");
      run.put("log", log);
      try {
        store.saveTest(run);
      } catch (IOException error) {
        throw new UncheckedIOException(error);
      }
    }
  }

  private static String safe(Exception error) {
    String message = error.getMessage();
    if (error instanceof IllegalArgumentException
        && message != null
        && !message.startsWith("Analysis canceled")) return message;
    return "Test run failed. Verify the checkout, report, and pinned analysis helper.";
  }

  private static Map<String, String> checkout(JsonNode snapshot) throws IOException {
    Map<String, String> hashes = new LinkedHashMap<>();
    Path root = Path.of(snapshot.path("root").asText());
    for (JsonNode file : snapshot.path("files"))
      if (file.path("after").path("kind").asText().equals("text")) {
        String name = file.path("path").asText();
        Path path = LocalSnapshots.contained(root, name);
        if (Files.size(path) > 2 * 1024 * 1024)
          throw new IllegalArgumentException(
              "Working source differs from snapshot: "
                  + name
                  + ". Refresh or use a matching checkout.");
        String text =
            utf8(readBounded(path, 2 * 1024 * 1024, "Working source exceeds its captured limit."));
        if (!text.equals(file.path("after").path("text").asText()))
          throw new IllegalArgumentException(
              "Working source differs from snapshot: "
                  + name
                  + ". Refresh or use a matching checkout.");
        hashes.put(name, CapturedArtifacts.digest(text));
      }
    String head = null;
    try {
      head =
          new String(GitProcess.run(root, "rev-parse", "--verify", "HEAD"), StandardCharsets.UTF_8)
              .strip();
    } catch (IOException ignored) {
    }
    if (!Objects.equals(
        head, snapshot.path("head").isNull() ? null : snapshot.path("head").asText()))
      throw new IllegalArgumentException(
          "Checkout HEAD differs from the captured snapshot. Refresh first.");
    return hashes;
  }

  private static String utf8(byte[] bytes) throws IOException {
    try {
      return StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes))
          .toString();
    } catch (CharacterCodingException e) {
      throw new IOException("Source/report is not valid UTF-8.");
    }
  }

  private static byte[] readBounded(Path path, int limit, String message) throws IOException {
    try (InputStream input = Files.newInputStream(path)) {
      byte[] bytes = input.readNBytes(limit + 1);
      if (bytes.length > limit) throw new IllegalArgumentException(message);
      return bytes;
    }
  }

  private static Path safeReport(Path root, String name) throws IOException {
    Path path = Path.of(name);
    if (path.isAbsolute()
        || Arrays.stream(name.split("[/\\\\]", -1))
            .anyMatch(p -> p.equals("..") || p.equalsIgnoreCase(".git"))
        || !name.matches("(?i).*\\.(json|xml)$"))
      throw new IllegalArgumentException(
          "Coverage report must be a repository-contained JSON/XML path.");
    Path target = root.resolve(path).normalize(), parent = target.getParent();
    while (!Files.exists(parent, LinkOption.NOFOLLOW_LINKS)) parent = parent.getParent();
    LocalSnapshots.contained(
        root,
        root.relativize(parent).toString().isEmpty() ? "." : root.relativize(parent).toString());
    if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) LocalSnapshots.contained(root, name);
    return target;
  }

  private static String identity(Path path) throws IOException {
    try {
      BasicFileAttributes attrs = Files.readAttributes(path, BasicFileAttributes.class);
      return attrs.fileKey()
          + ":"
          + attrs.size()
          + ":"
          + attrs.lastModifiedTime()
          + ":"
          + attrs.creationTime();
    } catch (NoSuchFileException error) {
      return null;
    }
  }

  public synchronized void cancel(String id) {
    if (id.equals(activeId) && active != null) active.cancel();
  }

  @PreDestroy
  public void close() {
    synchronized (this) {
      closing = true;
      if (active != null) active.cancel();
      previews.clear();
    }
    worker.shutdown();
    try {
      if (!worker.awaitTermination(30, TimeUnit.SECONDS)) worker.shutdownNow();
    } catch (InterruptedException e) {
      worker.shutdownNow();
      Thread.currentThread().interrupt();
    }
  }
}
