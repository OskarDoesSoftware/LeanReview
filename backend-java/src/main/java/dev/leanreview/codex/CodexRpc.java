package dev.leanreview.codex;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.analysis.AnalysisHelper;
import jakarta.annotation.PreDestroy;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.stereotype.Component;

/** Owned, restartable JSON-lines app-server transport. No shell, credential reads, or downloads. */
@Component
public class CodexRpc {
  public static final String PERMISSIONS = "leanreview_analysis";
  private static final int LIMIT = 4 * 1024 * 1024;
  private final Object gate = new Object(), writeGate = new Object();
  private final ObjectMapper json;
  private final Path home, workspace;
  private final Supplier<List<String>> launch;
  private final ExecutorService readers = Executors.newVirtualThreadPerTaskExecutor();
  private final ExecutorService writers =
      new ThreadPoolExecutor(
          1,
          1,
          0,
          TimeUnit.MILLISECONDS,
          new ArrayBlockingQueue<>(128),
          Thread.ofVirtual().factory(),
          new ThreadPoolExecutor.AbortPolicy());
  private final Map<Long, Pending> pending = new ConcurrentHashMap<>();
  private final AtomicLong ids = new AtomicLong();
  private final List<BiConsumer<String, JsonNode>> notifications = new CopyOnWriteArrayList<>();
  private final List<Consumer<CodexFailure>> disconnects = new CopyOnWriteArrayList<>();
  private volatile Process child;
  private CompletableFuture<Void> starting;
  private volatile boolean closed;

  private record Pending(Process child, String method, CompletableFuture<JsonNode> reply) {}

  @Autowired
  public CodexRpc(
      ObjectMapper json,
      @Value("${leanreview.data-directory}") String directory,
      @Value("${leanreview.codex.executable:${LEANREVIEW_CODEX_PATH:}}") String executable,
      @Value("${leanreview.codex.command:}") String command) {
    this(
        json,
        Path.of(directory).resolve("codex"),
        () -> {
          if (!command.isBlank()) {
            try {
              JsonNode value = json.readTree(command);
              if (!value.isArray() || value.isEmpty() || value.size() > 20) throw new IOException();
              List<String> result = new ArrayList<>();
              for (JsonNode part : value) {
                if (!part.isTextual()) throw new IOException();
                result.add(part.asText());
              }
              return result;
            } catch (IOException error) {
              throw new IllegalArgumentException("Invalid configured Codex command.");
            }
          }
          return discover(executable, System.getenv("PATH"));
        });
  }

  public CodexRpc(ObjectMapper json, Path home, Supplier<List<String>> launch) {
    this.json = json;
    this.home = home.toAbsolutePath().normalize();
    this.workspace = this.home.resolve("empty-workspace");
    this.launch = launch;
  }

  public Path workspace() {
    return workspace;
  }

  public Path home() {
    return home;
  }

  public AutoCloseable notifications(BiConsumer<String, JsonNode> listener) {
    notifications.add(listener);
    return () -> notifications.remove(listener);
  }

  public AutoCloseable disconnected(Consumer<CodexFailure> listener) {
    disconnects.add(listener);
    return () -> disconnects.remove(listener);
  }

  public static List<String> discover(String configured, String search) {
    if (configured != null && !configured.isBlank()) return List.of(configured);
    boolean windows = System.getProperty("os.name").startsWith("Windows");
    if (search != null)
      for (String folder : search.split(java.util.regex.Pattern.quote(File.pathSeparator))) {
        if (folder.isBlank()) continue;
        Path directory = Path.of(folder.replace("\"", ""));
        Path executable = directory.resolve(windows ? "codex.exe" : "codex");
        if (Files.isRegularFile(executable) && (windows || Files.isExecutable(executable)))
          return List.of(executable.toString());
        Path script = directory.resolve("node_modules/@openai/codex/bin/codex.js");
        if (windows && Files.isRegularFile(script))
          return List.of(AnalysisHelper.executable("node"), script.toString());
      }
    throw new IllegalArgumentException(
        "Codex CLI was not found. Install @openai/codex, restart LeanReview, or set"
            + " LEANREVIEW_CODEX_PATH to the Codex executable.");
  }

  public void ready() throws CodexFailure {
    CompletableFuture<Void> ready;
    boolean create = false;
    synchronized (gate) {
      if (closed) throw new CodexFailure("Codex connection is closed.");
      if (starting == null) {
        starting = new CompletableFuture<>();
        create = true;
      }
      ready = starting;
    }
    if (create)
      try {
        start(ready);
        ready.complete(null);
      } catch (Exception error) {
        String message = error.getMessage();
        CodexFailure failure =
            error instanceof CodexFailure value
                ? value
                : new CodexFailure(
                    message != null
                            && message.equals(
                                "Codex CLI was not found. Install @openai/codex, restart"
                                    + " LeanReview, or set LEANREVIEW_CODEX_PATH to the Codex"
                                    + " executable.")
                        ? message
                        : "Could not start Codex CLI. Check its installation and"
                            + " LEANREVIEW_CODEX_PATH.");
        stop(null, ready, failure);
        ready.completeExceptionally(failure);
      }
    try {
      ready.get(35, TimeUnit.SECONDS);
    } catch (ExecutionException error) {
      throw failure(error.getCause());
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new CodexFailure("Codex connection interrupted.");
    } catch (TimeoutException error) {
      throw new CodexFailure("Codex initialize timed out. Retry or reconnect.");
    }
  }

  private void start(CompletableFuture<Void> owner) throws Exception {
    Files.createDirectories(workspace);
    try {
      Files.setPosixFilePermissions(
          home, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
      Files.setPosixFilePermissions(
          workspace, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
    } catch (UnsupportedOperationException ignored) {
    }
    List<String> command = new ArrayList<>(launch.get());
    if (command.isEmpty() || command.getFirst().toLowerCase(Locale.ROOT).matches(".*\\.(cmd|bat)$"))
      throw new CodexFailure(
          "Could not start Codex CLI. Check its installation and LEANREVIEW_CODEX_PATH.");
    command.set(0, AnalysisHelper.executable(command.getFirst()));
    command.addAll(List.of("app-server", "--listen", "stdio://"));
    List<String> settings =
        new ArrayList<>(
            List.of(
                "forced_login_method=\"chatgpt\"",
                "model_provider=\"openai\"",
                "cli_auth_credentials_store=\"auto\"",
                "approval_policy=\"never\"",
                "default_permissions=\"" + PERMISSIONS + "\"",
                "permissions."
                    + PERMISSIONS
                    + ".filesystem={"
                    + json.writeValueAsString(workspace.toString())
                    + "=\"read\"}",
                "permissions." + PERMISSIONS + ".network.enabled=false"));
    if (System.getProperty("os.name").startsWith("Windows"))
      settings.addAll(List.of("windows.sandbox=\"mxc\"", "features.prefer_mxc=true"));
    settings.addAll(
        List.of(
            "web_search=\"disabled\"",
            "history.persistence=\"none\"",
            "features.shell_tool=false",
            "features.shell_snapshot=false",
            "features.apps=false",
            "features.remote_plugin=false",
            "features.browser_use=false",
            "features.computer_use=false",
            "features.view_image=false",
            "features.multi_agent=false",
            "features.skip_host_skill_discovery=true"));
    for (String setting : settings) {
      command.add("-c");
      command.add(setting);
    }
    ProcessBuilder builder = new ProcessBuilder(command).directory(workspace.toFile());
    builder
        .environment()
        .keySet()
        .removeIf(
            key ->
                key.toUpperCase(Locale.ROOT)
                    .matches("^(OPENAI_|CODEX_|CHATGPT_|NODE_OPTIONS$|NODE_PATH$).*"));
    builder.environment().put("CODEX_HOME", home.toString());
    Process process = builder.start();
    synchronized (gate) {
      if (closed || starting != owner) {
        AnalysisHelper.kill(process);
        throw new CodexFailure("Codex connection is closed.");
      }
      child = process;
    }
    readers.submit(() -> read(process));
    readers.submit(
        () -> {
          try (InputStream stderr = process.getErrorStream()) {
            byte[] buffer = new byte[8192];
            while (stderr.read(buffer) != -1) {
              /* Drain only. Never retain CLI diagnostics. */
            }
          } catch (IOException ignored) {
          }
        });
    request(
        "initialize",
        json.createObjectNode()
            .set(
                "clientInfo",
                json.createObjectNode()
                    .put("name", "leanreview")
                    .put("title", "LeanReview")
                    .put("version", "0.1.0")),
        json.createObjectNode().put("experimentalApi", true));
    send(process, json.createObjectNode().put("method", "initialized"));
  }

  private void request(String method, ObjectNode params, JsonNode capabilities)
      throws CodexFailure {
    params.set("capabilities", capabilities);
    request(method, params);
  }

  public JsonNode request(String method) throws CodexFailure {
    return request(method, json.createObjectNode());
  }

  public JsonNode request(String method, JsonNode params) throws CodexFailure {
    return request(method, params, 30000);
  }

  public JsonNode request(String method, JsonNode params, long timeout) throws CodexFailure {
    Process process = child;
    if (process == null) throw new CodexFailure("Codex is not connected.");
    long id = ids.incrementAndGet();
    CompletableFuture<JsonNode> reply = new CompletableFuture<>();
    synchronized (gate) {
      if (child != process) throw new CodexFailure("Codex is not connected.");
      if (pending.size() >= 128)
        throw new CodexFailure("Too many pending Codex requests. Retry shortly.");
      pending.put(id, new Pending(process, method, reply));
    }
    try {
      ObjectNode message = json.createObjectNode().put("id", id).put("method", method);
      message.set("params", params);
      send(process, message);
      return reply.get(timeout, TimeUnit.MILLISECONDS);
    } catch (ExecutionException error) {
      throw failure(error.getCause());
    } catch (TimeoutException error) {
      CodexFailure failure =
          new CodexFailure("Codex " + method + " timed out. Retry or reconnect.");
      stop(process, failure);
      throw failure;
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new CodexFailure("Codex connection interrupted.");
    } finally {
      pending.remove(id);
    }
  }

  private void send(Process process, JsonNode message) throws CodexFailure {
    try {
      byte[] bytes = json.writeValueAsBytes(message);
      if (bytes.length > LIMIT)
        throw new CodexFailure("Codex returned an oversized protocol message.");
      writers.execute(
          () -> {
            try {
              synchronized (writeGate) {
                if (child != process || !process.isAlive()) throw new IOException();
                process.getOutputStream().write(bytes);
                process.getOutputStream().write(10);
                process.getOutputStream().flush();
              }
            } catch (IOException error) {
              stop(process, new CodexFailure("Codex connection closed."));
            }
          });
    } catch (CodexFailure failure) {
      throw failure;
    } catch (IOException | RejectedExecutionException error) {
      throw new CodexFailure("Codex connection closed.");
    }
  }

  private void read(Process process) {
    try (InputStream input = new BufferedInputStream(process.getInputStream());
        ByteArrayOutputStream line = new ByteArrayOutputStream()) {
      int next;
      while ((next = input.read()) != -1) {
        if (child != process) return;
        if (next == 10) {
          byte[] bytes = line.toByteArray();
          line.reset();
          if (bytes.length == 0 || new String(bytes, StandardCharsets.UTF_8).isBlank()) continue;
          JsonNode message =
              json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(bytes);
          if (!message.isObject()) throw new IOException();
          receive(process, message);
        } else {
          if (line.size() >= LIMIT)
            throw new CodexFailure("Codex returned an oversized protocol message.");
          line.write(next);
        }
      }
      stop(process, new CodexFailure("Codex app-server exited. Retry to reconnect."));
    } catch (Exception error) {
      stop(
          process,
          error instanceof CodexFailure value
              ? value
              : new CodexFailure("Codex returned an invalid protocol message."));
    }
  }

  private void receive(Process process, JsonNode message) throws CodexFailure {
    if (child != process) return;
    if (message.has("id") && message.path("method").isTextual()) {
      ObjectNode response = json.createObjectNode();
      response.set("id", message.path("id"));
      response
          .putObject("error")
          .put("code", -32601)
          .put("message", "LeanReview supports analysis only; tool requests are disabled.");
      send(process, response);
      return;
    }
    if (message.path("id").isIntegralNumber()) {
      Pending request = pending.remove(message.path("id").asLong());
      if (request == null || request.child != process) return;
      if (message.hasNonNull("error")) {
        JsonNode rawCode = message.path("error").path("code");
        String suffix = rawCode.isIntegralNumber() ? " (RPC " + rawCode.asLong() + ")" : "";
        request.reply.completeExceptionally(
            new CodexFailure(
                rawCode.asLong() == -32600 || rawCode.asLong() == -32602
                    ? "Codex "
                        + request.method
                        + " rejected incompatible request settings"
                        + suffix
                        + ". Update LeanReview or Codex. No API fallback was used."
                    : "Codex "
                        + request.method
                        + " failed"
                        + suffix
                        + ". Check sign-in, subscription allowance and the selected model. No API"
                        + " fallback was used."));
      } else request.reply.complete(message.path("result"));
    } else if (message.path("method").isTextual())
      for (var listener : notifications)
        listener.accept(message.path("method").asText(), message.path("params"));
  }

  private CodexFailure failure(Throwable error) {
    return error instanceof CodexFailure value
        ? value
        : new CodexFailure("Codex connection failed.");
  }

  public void stop(CodexFailure error) {
    stop(null, error);
  }

  private void stop(Process expected, CodexFailure error) {
    stop(expected, null, error);
  }

  private void stop(Process expected, CompletableFuture<Void> owner, CodexFailure error) {
    Process process;
    CompletableFuture<Void> ready;
    List<Pending> requests = new ArrayList<>();
    synchronized (gate) {
      if (expected != null && child != expected || owner != null && starting != owner) return;
      process = child;
      child = null;
      ready = starting;
      starting = null;
      pending.forEach(
          (id, request) -> {
            if (request.child == process && pending.remove(id, request)) requests.add(request);
          });
      for (var listener : disconnects) listener.accept(error);
    }
    if (process != null) AnalysisHelper.kill(process);
    for (Pending request : requests) request.reply.completeExceptionally(error);
    if (ready != null) ready.completeExceptionally(error);
  }

  @PreDestroy
  public void close() {
    synchronized (gate) {
      closed = true;
    }
    stop(new CodexFailure("Codex connection closed."));
    writers.shutdownNow();
    readers.shutdownNow();
    try {
      writers.awaitTermination(5, TimeUnit.SECONDS);
      readers.awaitTermination(5, TimeUnit.SECONDS);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
    }
  }
}
