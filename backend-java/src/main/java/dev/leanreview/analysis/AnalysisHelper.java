package dev.leanreview.analysis;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.leanreview.llm.Cancellation;
import jakarta.annotation.PreDestroy;
import java.io.*;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Captured-input parser boundary; every request owns and reaps its process. */
@Component
public class AnalysisHelper {
  static {
    // Java's Windows legacy mode strips embedded quotes instead of preserving argv.
    System.setProperty("jdk.lang.Process.allowAmbiguousCommands", "false");
  }

  private static final int LIMIT = 256 * 1024 * 1024;
  private final ObjectMapper json;
  private final String node;
  private final Path script;
  private final Semaphore slots = new Semaphore(2, true);
  private final Set<Process> processes = ConcurrentHashMap.newKeySet();
  private volatile boolean closed;

  public AnalysisHelper(
      ObjectMapper json,
      @Value("${leanreview.analysis.node:node}") String node,
      @Value("${leanreview.analysis.helper:helper/dist/index.js}") String script) {
    this.json = json;
    this.node = node;
    this.script = Path.of(script).toAbsolutePath().normalize();
  }

  public JsonNode call(String operation, JsonNode input, Cancellation cancellation)
      throws IOException {
    long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(2);
    try {
      while (!slots.tryAcquire(50, TimeUnit.MILLISECONDS)) {
        if (closed) throw new IOException("Analysis helper is shutting down.");
        cancellation.check();
        if (System.nanoTime() > deadline)
          throw new IOException("Analysis helper is busy. Retry after active parsing finishes.");
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IOException("Analysis helper interrupted.");
    }
    try {
      return perform(operation, input, cancellation);
    } finally {
      slots.release();
    }
  }

  private JsonNode perform(String operation, JsonNode input, Cancellation cancellation)
      throws IOException {
    if (closed) throw new IOException("Analysis helper is shutting down.");
    cancellation.check();
    String id = UUID.randomUUID().toString();
    ObjectNode request =
        json.createObjectNode().put("version", 1).put("id", id).put("operation", operation);
    request.set("input", input);
    byte[] bytes = json.writeValueAsBytes(request);
    if (bytes.length > LIMIT) throw new IOException("Analysis helper input exceeds its limit.");
    ProcessBuilder builder = new ProcessBuilder(executable(node), script.toString());
    // Do not pass provider credentials, NODE_OPTIONS, preload hooks, or repository Git overrides.
    Map<String, String> inherited = new HashMap<>(builder.environment());
    builder.environment().clear();
    for (String key :
        List.of("PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"))
      if (inherited.containsKey(key)) builder.environment().put(key, inherited.get(key));
    Process process;
    try {
      process = builder.start();
    } catch (IOException error) {
      throw new IOException(
          "Analysis helper could not start. Build the pinned helper and check Node.");
    }
    processes.add(process);
    if (closed) kill(process);
    try (var readers = Executors.newVirtualThreadPerTaskExecutor();
        var registration = cancellation.register(() -> kill(process))) {
      Future<byte[]> output =
          readers.submit(() -> bounded(process.getInputStream(), LIMIT, process));
      Future<byte[]> errors =
          readers.submit(() -> bounded(process.getErrorStream(), 65536, process));
      Future<?> writer =
          readers.submit(
              () -> {
                try (OutputStream stream = process.getOutputStream()) {
                  stream.write(bytes);
                }
                return null;
              });
      try {
        if (!process.waitFor(120, TimeUnit.SECONDS))
          throw new IOException("Analysis helper timed out.");
        cancellation.check();
        writer.get(5, TimeUnit.SECONDS);
        byte[] reply = output.get(5, TimeUnit.SECONDS);
        errors.get(5, TimeUnit.SECONDS);
        JsonNode response =
            json.reader()
                .with(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                .readTree(reply);
        if (response == null
            || !response.path("version").isNumber()
            || response.path("version").asDouble() != 1
            || !id.equals(response.path("id").asText()))
          throw new IOException("Invalid analysis helper response.");
        if (process.exitValue() != 0 || response.has("error") || !response.has("result"))
          throw new IOException("Analysis helper could not process captured input.");
        return response.get("result");
      } finally {
        kill(process);
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IOException("Analysis helper interrupted.");
    } catch (ExecutionException | TimeoutException error) {
      throw new IOException("Analysis helper protocol failed.");
    } catch (IOException | RuntimeException error) {
      throw error;
    } catch (Exception error) {
      throw new IOException("Analysis helper failed.");
    } finally {
      kill(process);
      processes.remove(process);
    }
  }

  @PreDestroy
  public void close() {
    closed = true;
    processes.forEach(AnalysisHelper::kill);
  }

  private static byte[] bounded(InputStream stream, int limit, Process process) throws IOException {
    try (stream;
        ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int length;
      while ((length = stream.read(buffer)) != -1) {
        if (bytes.size() + length > limit) {
          kill(process);
          throw new IOException("Analysis helper output exceeds its limit.");
        }
        bytes.write(buffer, 0, length);
      }
      return bytes.toByteArray();
    }
  }

  public static void kill(Process process) {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    List<ProcessHandle> descendants = process.descendants().toList();
    descendants.forEach(ProcessHandle::destroyForcibly);
    process.destroyForcibly();
    try {
      process.waitFor(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
      for (ProcessHandle child : descendants) {
        try {
          child.onExit().get(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
        } catch (ExecutionException | TimeoutException ignored) {
          // Keep the total shutdown wait bounded even if an OS process cannot exit.
        }
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
    }
  }

  /** Resolve bare Windows executables before ProcessBuilder chooses its argument quoting rules. */
  public static String executable(String name) {
    if (!System.getProperty("os.name").startsWith("Windows")
        || name.contains("/")
        || name.contains("\\")) return name;
    String search = System.getenv("PATH");
    if (search == null) search = System.getenv("Path");
    if (search != null)
      for (String folder : search.split(";"))
        for (String suffix :
            name.matches("(?i).*\\.(exe|com)$") ? List.of("") : List.of(".exe", ".com")) {
          Path candidate = Path.of(folder.replace("\"", "")).resolve(name + suffix);
          if (java.nio.file.Files.isRegularFile(candidate))
            return candidate.toAbsolutePath().toString();
        }
    return name;
  }
}
