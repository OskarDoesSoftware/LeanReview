package dev.leanreview.github;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import jakarta.annotation.PreDestroy;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/** Owns bounded CLI processes. Tokens and upstream diagnostics never reach application logs. */
@Service
public class GitHubCli {
  private final ObjectMapper json;
  private final Path config;
  private final List<String> command;
  private final Set<Process> owned = ConcurrentHashMap.newKeySet();
  private Process login;
  private boolean writing;

  public interface WriteLease extends AutoCloseable {
    @Override
    void close();
  }

  public synchronized WriteLease writeLease() throws IOException {
    if (writing || login != null && login.isAlive())
      throw new IOException("Wait for the active GitHub operation to finish.");
    writing = true;
    return () -> {
      synchronized (GitHubCli.this) {
        writing = false;
      }
    };
  }

  private ObjectNode cachedStatus;
  private long statusAt;
  private volatile String code = "", error = "";
  private volatile boolean enabled = true;

  public GitHubCli(
      ObjectMapper json,
      @Value("${leanreview.data-directory}") String data,
      @Value("${leanreview.github.command:}") String command)
      throws IOException {
    this.json = json;
    this.config = Path.of(data).resolve("github-cli").toAbsolutePath();
    this.command =
        command.isBlank()
            ? List.of("gh")
            : json.readValue(
                command, new com.fasterxml.jackson.core.type.TypeReference<List<String>>() {});
    if (this.command.isEmpty()) throw new IOException("GitHub CLI command is empty.");
    Files.createDirectories(config);
    enabled = !Files.exists(config.resolve("disconnected"));
  }

  private Process spawn(List<String> args) throws IOException {
    var argv = new ArrayList<>(command);
    argv.addAll(args);
    var builder = new ProcessBuilder(argv);
    builder
        .environment()
        .keySet()
        .removeIf(k -> k.startsWith("GH_") || k.startsWith("GITHUB_") || k.equals("GIT_ASKPASS"));
    builder.environment().put("GH_CONFIG_DIR", config.toString());
    builder.environment().put("GH_PROMPT_DISABLED", "1");
    builder.environment().put("GH_BROWSER", "true"); // UI opens the fixed verification URL.
    builder.environment().put("NO_COLOR", "1");
    Process process;
    try {
      process = builder.start();
    } catch (IOException unavailable) {
      throw new IOException("GitHub CLI is unavailable. Install gh and retry.");
    }
    owned.add(process);
    return process;
  }

  public static class RequestFailure extends IOException {
    public final boolean definite;

    RequestFailure(boolean definite) {
      super("GitHub request failed. Check sign-in, access permissions, and rate limits.");
      this.definite = definite;
    }
  }

  private byte[] read(InputStream stream, int limit) throws IOException {
    byte[] value = stream.readNBytes(limit + 1);
    if (value.length > limit) throw new IOException("GitHub response limit exceeded.");
    return value;
  }

  public byte[] execute(List<String> args, JsonNode input) throws IOException {
    Process process = spawn(args);
    var stdout =
        CompletableFuture.supplyAsync(
            () -> {
              try {
                return read(process.getInputStream(), 32 * 1024 * 1024);
              } catch (IOException e) {
                throw new CompletionException(e);
              }
            });
    var stderr =
        CompletableFuture.supplyAsync(
            () -> {
              try {
                return read(process.getErrorStream(), 64 * 1024);
              } catch (IOException ignored) {
                return new byte[0];
              }
            });
    try {
      var writer =
          CompletableFuture.runAsync(
              () -> {
                try (var stdin = process.getOutputStream()) {
                  if (input != null) stdin.write(json.writeValueAsBytes(input));
                } catch (IOException e) {
                  throw new CompletionException(e);
                }
              });
      writer.get(30, TimeUnit.SECONDS);
      if (!process.waitFor(60, TimeUnit.SECONDS))
        throw new IOException("GitHub request timed out. Check the connection and retry.");
      byte[] result = stdout.get(5, TimeUnit.SECONDS);
      if (process.exitValue() != 0) {
        var match =
            Pattern.compile("HTTP ([0-9]{3})")
                .matcher(new String(stderr.get(5, TimeUnit.SECONDS), StandardCharsets.UTF_8));
        int status = match.find() ? Integer.parseInt(match.group(1)) : 0;
        throw new RequestFailure(status >= 400 && status < 500 && status != 408);
      }
      return result;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IOException("GitHub request canceled.");
    } catch (ExecutionException | TimeoutException e) {
      throw new IOException("GitHub request failed or exceeded its limits.");
    } finally {
      terminate(process);
      stdout.cancel(true);
      stderr.cancel(true);
    }
  }

  public JsonNode api(String method, String endpoint, JsonNode input) throws IOException {
    requireConnection();
    if (!endpoint.matches("[A-Za-z0-9_/?&=.%:,+-]+")
        || endpoint.startsWith("/")
        || endpoint.contains("://")) throw new IOException("Invalid GitHub endpoint.");
    var args =
        new ArrayList<>(
            List.of(
                "api",
                "--hostname",
                "github.com",
                "--method",
                method,
                "-H",
                "Accept: application/vnd.github+json",
                endpoint));
    if (input != null) args.addAll(List.of("--input", "-"));
    return json.readTree(execute(args, input));
  }

  public ArrayNode pages(String endpoint) throws IOException {
    ArrayNode all = json.createArrayNode();
    for (int page = 1; page <= 100; page++) {
      JsonNode part =
          api(
              "GET",
              endpoint + (endpoint.contains("?") ? "&" : "?") + "per_page=100&page=" + page,
              null);
      if (!part.isArray()) throw new IOException("GitHub returned an unexpected page.");
      all.addAll((ArrayNode) part);
      if (part.size() < 100) return all;
    }
    throw new IOException(
        "GitHub listing exceeds the supported page limit; the result is incomplete.");
  }

  private synchronized void secureStorage() throws IOException {
    Path hosts = config.resolve("hosts.yml");
    if (Files.exists(hosts)
        && Pattern.compile("(?m)^\\s*oauth_token\\s*:").matcher(Files.readString(hosts)).find()) {
      // This is only the owned profile. Never inspect or modify the user's general gh
      // configuration.
      Files.delete(hosts);
      throw new IOException(
          "GitHub CLI could not use the OS credential store. Unlock or configure it and sign in"
              + " again. Plaintext credentials were rejected.");
    }
  }

  public synchronized ObjectNode status() throws IOException {
    ObjectNode result =
        json.createObjectNode()
            .put("connected", false)
            .put("signingIn", login != null && login.isAlive())
            .put("userCode", code)
            .put("verificationUrl", "https://github.com/login/device");
    if (!error.isEmpty()) result.put("error", error);
    secureStorage();
    if (!enabled || result.path("signingIn").asBoolean()) return result;
    if (cachedStatus != null && System.nanoTime() - statusAt < TimeUnit.SECONDS.toNanos(30))
      return cachedStatus.deepCopy();
    try {
      JsonNode status =
          json.readTree(
              execute(
                  List.of(
                      "auth", "status", "--hostname", "github.com", "--active", "--json", "hosts"),
                  null));
      for (JsonNode account : status.path("hosts").path("github.com"))
        if (account.path("state").asText().equals("success")
            && account.path("tokenSource").asText().equals("keyring"))
          result.put("connected", true).put("login", account.path("login").asText());
    } catch (IOException unavailable) {
      result.put("error", "GitHub is not connected. Sign in with GitHub CLI.");
    }
    if (result.path("connected").asBoolean()) {
      cachedStatus = result.deepCopy();
      statusAt = System.nanoTime();
    }
    return result;
  }

  private void requireConnection() throws IOException {
    if (!status().path("connected").asBoolean())
      throw new IOException("Connect GitHub through browser sign-in before continuing.");
  }

  public synchronized ObjectNode login() throws IOException {
    if (writing) throw new IOException("Wait for the active GitHub submission to finish.");
    if (login != null && login.isAlive()) return status();
    Files.deleteIfExists(config.resolve("disconnected"));
    enabled = true;
    code = "";
    error = "";
    cachedStatus = null;
    login =
        spawn(
            List.of(
                "auth",
                "login",
                "--hostname",
                "github.com",
                "--git-protocol",
                "https",
                "--web",
                "--skip-ssh-key"));
    Process process = login;
    // gh waits for Enter after displaying its device code, even with redirected streams.
    process.getOutputStream().write('\n');
    process.getOutputStream().flush();
    Thread.ofVirtual()
        .start(
            () -> {
              try {
                var pattern = Pattern.compile("\\b[A-Z0-9]{4}-[A-Z0-9]{4}\\b");
                try (var reader =
                    new BufferedReader(
                        new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                  int total = 0;
                  String line;
                  while ((line = reader.readLine()) != null) {
                    if ((total += line.length()) > 64 * 1024) throw new IOException();
                    var matcher = pattern.matcher(line);
                    if (matcher.find()) code = matcher.group();
                  }
                }
                if (process.waitFor() != 0)
                  error = "GitHub sign-in did not complete. Retry when ready.";
                secureStorage();
              } catch (Exception failed) {
                error = "GitHub sign-in failed. Check the OS credential store and retry.";
              } finally {
                terminate(process);
              }
            });
    Thread.ofVirtual()
        .start(
            () -> {
              try {
                read(process.getInputStream(), 64 * 1024);
              } catch (IOException ignored) {
              }
            });
    CompletableFuture.delayedExecutor(10, TimeUnit.MINUTES)
        .execute(
            () -> {
              if (process.isAlive()) terminate(process);
            });
    return status();
  }

  public synchronized void cancel() throws IOException {
    if (writing) throw new IOException("Wait for the active GitHub submission to finish.");
    if (login != null) terminate(login);
    login = null;
    code = "";
  }

  public synchronized void disconnect() throws IOException {
    cancel();
    enabled = false;
    Files.writeString(config.resolve("disconnected"), "disconnected");
  }

  private void terminate(Process process) {
    process.descendants().forEach(ProcessHandle::destroyForcibly);
    process.destroyForcibly();
    owned.remove(process);
  }

  @PreDestroy
  public void close() {
    for (Process process : owned) terminate(process);
  }
}
