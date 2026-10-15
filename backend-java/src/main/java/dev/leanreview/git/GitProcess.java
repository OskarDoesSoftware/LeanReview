package dev.leanreview.git;

import java.io.*;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;

/** Bounded, argument-only Git execution. Never return subprocess diagnostics to the API. */
public final class GitProcess {
  private GitProcess() {}

  public static byte[] run(Path root, String... args) throws IOException {
    var command =
        new ArrayList<>(
            List.of(
                "git",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.hooksPath=",
                "-c",
                "diff.external="));
    command.addAll(List.of(args));
    ProcessBuilder builder = new ProcessBuilder(command).directory(root.toFile());
    builder.environment().put("GIT_TERMINAL_PROMPT", "0");
    // An inherited Git worktree/index override must not redirect the selected repository.
    builder
        .environment()
        .keySet()
        .removeIf(
            key ->
                key.startsWith("GIT_")
                    && !Set.of("GIT_TERMINAL_PROMPT", "GIT_EXEC_PATH").contains(key));
    Process process = builder.start();
    process.getOutputStream().close();
    try (var tasks = Executors.newVirtualThreadPerTaskExecutor()) {
      var stdout = tasks.submit(() -> read(process.getInputStream(), 32 * 1024 * 1024, process));
      var stderr = tasks.submit(() -> read(process.getErrorStream(), 1024 * 1024, process));
      try {
        if (!process.waitFor(30, TimeUnit.SECONDS))
          throw new IOException("Git command exceeded its time limit.");
        byte[] output = stdout.get(2, TimeUnit.SECONDS);
        stderr.get(2, TimeUnit.SECONDS);
        if (process.exitValue() != 0)
          throw new IOException("Git operation failed. Verify the repository and comparison.");
        return output;
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IOException("Git operation canceled.");
      } catch (ExecutionException | TimeoutException error) {
        throw new IOException("Git output could not be captured within limits.");
      } finally {
        process.descendants().forEach(ProcessHandle::destroyForcibly);
        process.destroyForcibly();
      }
    }
  }

  private static byte[] read(InputStream stream, int limit, Process process) throws IOException {
    byte[] bytes = stream.readNBytes(limit + 1);
    if (bytes.length > limit) {
      process.destroyForcibly();
      throw new IOException("Git output limit exceeded.");
    }
    return bytes;
  }
}
