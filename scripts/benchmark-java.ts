import { dataset } from "./benchmark-backend";
import { monitorTree } from "./process-tree-memory";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createServer } from "node:net";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n: number) => Math.round(n * 100) / 100;
const count = Number(process.env.LEANREVIEW_BASELINE_FILES || 1000);
const repeats = Number(process.env.LEANREVIEW_BASELINE_REPEATS || 3);
if (
  !Number.isInteger(count) ||
  count < 2 ||
  count > 10000 ||
  count % 2 ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 10
)
  throw new Error("Use an even file count 2..10000 and 1..10 repeats.");
const java = process.env.JAVA_HOME
  ? path.join(
      process.env.JAVA_HOME,
      "bin",
      process.platform === "win32" ? "java.exe" : "java",
    )
  : "java";
const results: unknown[] = [];
const jarFile = path.resolve(
  process.env.LEANREVIEW_JAVA_BENCHMARK_JAR ||
    "backend-java/target/leanreview-backend-0.1.0-SNAPSHOT.jar",
);
const helperFile = path.resolve("backend-java/helper/dist/index.js");
const digestFile = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
const source = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  workingTree: execFileSync("git", ["status", "--short"], {
    encoding: "utf8",
  }).trim(),
  jarSha256: await digestFile(jarFile),
  helperSha256: await digestFile(helperFile),
  benchmarkSha256: await digestFile("scripts/benchmark-java.ts"),
  samplerSha256: await digestFile("scripts/process-tree-memory.ts"),
  platformSamplerSha256: await digestFile(
    process.platform === "win32"
      ? "scripts/process-tree-memory.ps1"
      : "scripts/process-tree-memory-unix.mjs",
  ),
};
await fs.mkdir(".leanreview-test", { recursive: true });
for (const kind of ["typescript", "java", "mixed"]) {
  const fixture = await dataset(kind, count),
    runs = [];
  for (let repetition = 1; repetition <= repeats; repetition++) {
    const data = await fs.mkdtemp(
      path.resolve(".leanreview-test/java-benchmark-"),
    );
    const socket = createServer();
    await new Promise<void>((resolve) =>
      socket.listen(0, "127.0.0.1", resolve),
    );
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const started = performance.now();
    const child = spawn(
      java,
      [
        "--enable-native-access=ALL-UNNAMED",
        "-jar",
        jarFile,
        "--spring.profiles.active=web",
        `--server.port=${port}`,
        `--leanreview.origin=${origin}`,
        `--leanreview.data-directory=${data}`,
        `--leanreview.analysis.node=${process.execPath}`,
        `--leanreview.analysis.helper=${helperFile}`,
        "--logging.level.root=ERROR",
        "--spring.main.banner-mode=off",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!child.pid) throw new Error("Java benchmark process did not start.");
    const memory = monitorTree(child.pid);
    let memoryStopped = false;
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.resume();
    try {
      while (!output.includes("Startup link:")) {
        if (child.exitCode !== null || performance.now() - started > 60000)
          throw new Error("Java benchmark startup failed.");
        await sleep(10);
      }
      const startupMs = round(performance.now() - started);
      const nonce = output.match(/#bootstrap=(\w+)/)![1];
      output = "";
      const bootstrap = await fetch(origin + "/api/session", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
      });
      if (!bootstrap.ok) throw new Error("Benchmark authorization failed.");
      const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
      const request = async (route: string, body?: object) => {
        const response = await fetch(origin + "/api" + route, {
          method: body ? "POST" : "GET",
          headers: { origin, cookie, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) {
          const failure = await response.json();
          throw new Error(
            "Java benchmark request failed: " + route + ": " + failure.error,
          );
        }
        return response.json();
      };
      const captureStart = performance.now();
      const review = await request("/sessions", {
        root: fixture.root,
        comparison: { mode: "branch", base: "main" },
      });
      const captureMs = round(performance.now() - captureStart),
        scans = [];
      for (const cache of ["cold-artifact-cache", "warm-artifact-cache"]) {
        const latencies: number[] = [];
        let sampling = true;
        const sampler = (async () => {
          while (sampling) {
            const t = performance.now();
            await request("/provider");
            latencies.push(performance.now() - t);
            await sleep(10);
          }
        })();
        const scanStarted = performance.now();
        let view;
        try {
          const cleanupDeadline = Date.now() + 10000;
          for (;;) {
            try {
              await request(`/sessions/${review.snapshot.sessionId}/graph`, {
                snapshotId: review.snapshot.id,
                options: {
                  side: "after",
                  maxFiles: 10000,
                  maxBytes: 20 * 1024 * 1024,
                },
              });
              break;
            } catch (failure) {
              if (
                !(failure instanceof Error) ||
                !failure.message.includes("A graph scan is already running") ||
                Date.now() >= cleanupDeadline
              )
                throw failure;
              await sleep(50);
            }
          }
          do {
            if (performance.now() - scanStarted > 120000)
              throw new Error("Java graph benchmark timeout.");
            await sleep(10);
            view = await request(
              `/sessions/${review.snapshot.sessionId}/graph?snapshot=${review.snapshot.id}&side=after&statusOnly=1`,
            );
          } while (view.run?.status === "running");
        } finally {
          sampling = false;
          await sampler;
        }
        const elapsedMs = round(performance.now() - scanStarted);
        if (view.run?.status !== "succeeded")
          throw new Error("Java graph benchmark did not succeed.");
        const graph = (
          await request(
            `/sessions/${review.snapshot.sessionId}/graph?snapshot=${review.snapshot.id}&side=after`,
          )
        ).graph;
        if (!graph.coverage.complete || graph.coverage.parserFailures)
          throw new Error("Java extraction coverage is incomplete.");
        latencies.sort((a, b) => a - b);
        scans.push({
          cache,
          elapsedMs,
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          coverage: graph.coverage,
          responsiveness: {
            samples: latencies.length,
            p95Ms: round(
              latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)],
            ),
            maxMs: round(latencies.at(-1)!),
          },
        });
      }
      let peakJavaRssMiB: number | null = null;
      if (process.platform === "win32") {
        const bytes = Number(
          execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `(Get-Process -Id ${child.pid}).PeakWorkingSet64`,
            ],
            { windowsHide: true, encoding: "utf8" },
          ).trim(),
        );
        peakJavaRssMiB = round(bytes / 1024 ** 2);
      }
      const processTreeMemory = await memory.stop();
      memoryStopped = true;
      runs.push({
        repetition,
        startupMs,
        captureMs,
        peakJavaRssMiB,
        processTreeMemory,
        scans,
      });
      console.log(`${kind} Java repetition ${repetition}/${repeats} complete`);
    } finally {
      if (!memoryStopped) await memory.stop().catch(() => {});
      if (process.platform === "win32" && child.pid)
        execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else child.kill("SIGTERM");
    }
  }
  results.push({ ...fixture.identity, runs });
}
if (
  source.jarSha256 !== (await digestFile(jarFile)) ||
  source.helperSha256 !== (await digestFile(helperFile))
)
  throw new Error(
    "Benchmark artifacts changed during measurement; discard this run.",
  );
await fs.writeFile(
  process.env.LEANREVIEW_JAVA_BASELINE_OUTPUT ||
    "docs/migration/java-process-tree-baseline.json",
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        cpu: os.cpus()[0]?.model,
        java: spawnSync(java, ["-version"], { encoding: "utf8" }).stderr.trim(),
      },
      source,
      methodology: {
        scope:
          "Same deterministic generator and scan options as Node baseline. Run without concurrent tests/builds. Startup includes Spring/JPA/Tomcat. Capture includes HTTP roundtrip. Process-tree RSS samples sum the Java root and visible descendants, including the parser helper and Git, every 200ms plus enumeration time. Shared resident pages can be counted more than once; short-lived peaks between samples can be missed. The sampler and browser are excluded. Windows peakJavaRssMiB remains the JVM-only lifetime high-water mark.",
      },
      datasets: results,
    },
    null,
    2,
  ) + "\n",
);
