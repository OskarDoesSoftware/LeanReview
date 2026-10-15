package dev.leanreview.analysis;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.leanreview.llm.Cancellation;
import java.nio.file.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class HelperProcessTest {
  @TempDir Path directory;
  final ObjectMapper json = new ObjectMapper();

  @Test
  void shutdownReapsAnOwnedHelperOutsideAGraphOrTestJob() throws Exception {
    Path marker = directory.resolve("shutdown.pid"), script = directory.resolve("shutdown.mjs");
    Files.writeString(
        script,
        "import fs from 'node:fs';process.stdin.resume();fs.writeFileSync("
            + json.writeValueAsString(marker.toString())
            + ",String(process.pid));setInterval(()=>{},1000);");
    AnalysisHelper helper = new AnalysisHelper(json, "node", script.toString());
    try (var workers = Executors.newVirtualThreadPerTaskExecutor()) {
      Future<?> request =
          workers.submit(
              () ->
                  assertThatThrownBy(
                          () ->
                              helper.call(
                                  "complexity", json.createObjectNode(), new Cancellation()))
                      .hasMessageContaining("helper"));
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      while (!Files.exists(marker) && System.nanoTime() < deadline) Thread.sleep(10);
      long pid = Long.parseLong(Files.readString(marker));
      helper.close();
      request.get(5, TimeUnit.SECONDS);
      assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
      assertThatThrownBy(
              () -> helper.call("complexity", json.createObjectNode(), new Cancellation()))
          .hasMessageContaining("shutting down");
    }
  }

  @Test
  void cancelReapsHelperAndRejectsWrongRequestIdentityAndProtocolNoise() throws Exception {
    Path marker = directory.resolve("helper.pid"), script = directory.resolve("helper.mjs");
    Files.writeString(
        script,
        "import fs from 'node:fs'; process.stdin.resume(); fs.writeFileSync("
            + json.writeValueAsString(marker.toString())
            + ",String(process.pid)); setInterval(()=>{},1000);");
    AnalysisHelper helper = new AnalysisHelper(json, "node", script.toString());
    Cancellation cancellation = new Cancellation();
    try (var workers = Executors.newVirtualThreadPerTaskExecutor()) {
      Future<?> request =
          workers.submit(
              () -> {
                assertThatThrownBy(
                        () -> helper.call("complexity", json.createObjectNode(), cancellation))
                    .hasMessageContaining("canceled");
              });
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      while (!Files.exists(marker) && System.nanoTime() < deadline) Thread.sleep(10);
      long pid = Long.parseLong(Files.readString(marker));
      cancellation.cancel();
      request.get(5, TimeUnit.SECONDS);
      assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
    }
    Files.writeString(
        script,
        "process.stdin.resume();"
            + " process.stdin.on('end',()=>{console.log(JSON.stringify({version:1,id:'wrong',result:{}}));});");
    assertThatThrownBy(() -> helper.call("complexity", json.createObjectNode(), new Cancellation()))
        .hasMessageContaining("Invalid analysis helper response");
    Files.writeString(
        script,
        "process.stdin.resume();"
            + " process.stdin.on('end',()=>{console.error('x'.repeat(100000));setInterval(()=>{},1000)});");
    assertThatThrownBy(() -> helper.call("complexity", json.createObjectNode(), new Cancellation()))
        .hasMessageContaining("helper");
  }
}
