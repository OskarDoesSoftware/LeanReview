import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Store } from "../backend/src/storage/store";
import { createApp } from "../backend/src/api/app";
import { captureSnapshot, hash } from "../backend/src/git/local";
import { GraphService } from "../backend/src/graph/service";

const script = fileURLToPath(import.meta.url);
const options = {
  side: "after" as const,
  maxFiles: 10000,
  maxBytes: 20 * 1024 * 1024,
};
const round = (value: number) => Math.round(value * 100) / 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values: number[], fraction: number) =>
  values.length
    ? round(
        [...values].sort((a, b) => a - b)[
          Math.max(0, Math.ceil(values.length * fraction) - 1)
        ],
      )
    : null;

async function worker(root: string) {
  const directory = await fs.mkdtemp(
    path.resolve(".leanreview-test/baseline-data-"),
  );
  const store = new Store(directory);
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No baseline port");
  const origin = `http://127.0.0.1:${address.port}`;
  const application = createApp(store, origin, "baseline-nonce");
  server.on("request", application.app);
  console.log(JSON.stringify({ event: "ready" }));
  const graphs = new GraphService(store);
  try {
    const bootstrap = await fetch(origin + "/api/session", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ nonce: "baseline-nonce" }),
    });
    if (!bootstrap.ok) throw new Error("Baseline bootstrap failed");
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
    const capturedAt = performance.now();
    const snapshot = await captureSnapshot(
      root,
      { mode: "branch", base: "main" },
      "baseline",
    );
    const captureMs = round(performance.now() - capturedAt);
    store.create(snapshot);
    const scans = [];
    for (const cache of ["cold-artifact-cache", "warm-artifact-cache"]) {
      const latencies: number[] = [];
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const started = performance.now();
          const response = await fetch(origin + "/api/provider", {
            headers: { cookie },
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error("Responsiveness request failed");
          await response.json();
          latencies.push(performance.now() - started);
          await sleep(10);
        }
      })();
      const started = performance.now();
      graphs.start(snapshot, options);
      let view;
      try {
        do {
          if (performance.now() - started > 120000)
            throw new Error("Baseline scan exceeded 120 seconds");
          await sleep(10);
          view = graphs.view(snapshot, "after", true);
        } while (view.run?.status === "running");
      } finally {
        sampling = false;
        await sampler;
      }
      const elapsedMs = round(performance.now() - started);
      if (view.run?.status !== "succeeded")
        throw new Error(JSON.stringify(view.run));
      const graph = graphs.view(snapshot, "after").graph!;
      if (!graph.coverage.complete || graph.coverage.parserFailures)
        throw new Error("Benchmark dataset did not scan completely");
      scans.push({
        cache,
        elapsedMs,
        coverage: graph.coverage,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        responsiveness: {
          endpoint: "GET /api/provider",
          samples: latencies.length,
          p50Ms: percentile(latencies, 0.5),
          p95Ms: percentile(latencies, 0.95),
          maxMs: percentile(latencies, 1),
        },
        peakBackendRssMiB: round(process.resourceUsage().maxRSS / 1024),
      });
    }
    console.log(
      JSON.stringify({
        event: "result",
        captureMs,
        scans,
        peakBackendRssMiB: round(process.resourceUsage().maxRSS / 1024),
      }),
    );
  } finally {
    await graphs.shutdown();
    await application.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
}

export async function dataset(kind: string, count: number) {
  const root = await fs.mkdtemp(
    path.resolve(`.leanreview-test/baseline-${kind}-`),
  );
  const manifest: { path: string; sha256: string; bytes: number }[] = [];
  const padding =
    "// deterministic source padding for repository scan baseline\n".repeat(20);
  for (let i = 0; i < count; i++) {
    const java = kind === "java" || (kind === "mixed" && i % 2 === 1);
    const next = (i + (kind === "mixed" ? 2 : 1)) % count;
    const name = java ? `Type${i}.java` : `module${i}.ts`;
    const text = java
      ? `package baseline;\nimport java.util.List;\npublic class Type${i} { Type${next} next; List<String> names;\n${Array.from({ length: 8 }, (_, j) => `public int choose${j}(int x) { if (x > ${j}) return x; return ${j}; }`).join("\n")}\n}\n${padding}`
      : `import { value as next } from './module${next}';\nexport const value = ${i};\n${Array.from({ length: 8 }, (_, j) => `export function choose${j}(x: number) { if (x > ${j}) return next; return ${j}; }`).join("\n")}\n${padding}`;
    await fs.writeFile(path.join(root, name), text);
    manifest.push({
      path: name,
      sha256: hash(text),
      bytes: Buffer.byteLength(text),
    });
  }
  const emptyConfig = path.resolve(".leanreview-test/baseline-empty-gitconfig");
  await fs.writeFile(emptyConfig, "");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_AUTHOR_DATE: "2026-10-15T10:00:00Z",
        GIT_COMMITTER_DATE: "2026-10-15T10:00:00Z",
      },
    })
      .toString()
      .trim();
  git("init", "-b", "main");
  git("config", "user.name", "Synthetic baseline");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git(
    "-c",
    "core.hooksPath=",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Deterministic baseline dataset",
  );
  return {
    root,
    identity: {
      kind,
      generatorVersion: 1,
      files: count,
      bytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
      manifestSha256: hash(JSON.stringify(manifest)),
      tree: git("rev-parse", "HEAD^{tree}"),
      revision: git("rev-parse", "HEAD"),
    },
  };
}

async function run(root: string) {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", script, "--worker", root],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    errors = "",
    startupMs = 0;
  const deadline = setTimeout(() => child.kill(), 300000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!startupMs && output.includes('"event":"ready"'))
      startupMs = round(performance.now() - started);
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  try {
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error(`Baseline worker failed: ${errors}`);
    const result = output
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .find((item) => item.event === "result");
    if (!result) throw new Error("Missing baseline result");
    return { startupMs, ...result };
  } finally {
    clearTimeout(deadline);
  }
}

if (path.resolve(process.argv[1] ?? "") === script) {
  if (process.argv[2] === "--worker") await worker(process.argv[3]);
  else {
    if (Number(process.versions.node.split(".")[0]) !== 24)
      throw new Error(
        "Use npm run benchmark:backend with the pinned Node 24 runtime",
      );
    await fs.mkdir(".leanreview-test", { recursive: true });
    const count = Number(process.env.LEANREVIEW_BASELINE_FILES ?? 1000);
    const repeats = Number(process.env.LEANREVIEW_BASELINE_REPEATS ?? 3);
    if (
      !Number.isInteger(count) ||
      count < 2 ||
      count % 2 ||
      count > 10000 ||
      !Number.isInteger(repeats) ||
      repeats < 1 ||
      repeats > 10
    )
      throw new Error("Use an even file count 2..10000 and 1..10 repeats");
    const tracked = execFileSync("git", [
      "ls-files",
      "backend/src",
      "packages/contracts/src",
      "package-lock.json",
      "scripts/benchmark-backend.ts",
    ])
      .toString()
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (!tracked.includes("scripts/benchmark-backend.ts"))
      tracked.push("scripts/benchmark-backend.ts");
    const inputs = await Promise.all(
      tracked.map(async (name) => ({
        path: name,
        sha256: hash(await fs.readFile(name)),
      })),
    );
    const result = {
      measuredAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        osRelease: os.release(),
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        totalMemoryMiB: round(os.totalmem() / 1024 ** 2),
        git: execFileSync("git", ["--version"]).toString().trim(),
      },
      baseline: {
        commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
        backendInputSha256: hash(JSON.stringify(inputs)),
        inputs,
        workingTree: execFileSync("git", ["status", "--short"])
          .toString()
          .trim()
          .split(/\r?\n/),
        options,
      },
      methodology: {
        startup:
          "Fresh Node process to loopback HTTP listening, including tsx/imports/Store/createApp; excludes browser and production asset loading",
        cold: "Empty application artifact cache in a fresh process; OS page cache is not flushed",
        warm: "Second GraphService scan with persisted source cache in the same process",
        peakMemory:
          "Process lifetime high-water RSS of backend worker including Node/tsx, excluding Git child processes; warm is cumulative",
        responsiveness:
          "Sequential authenticated GET /api/provider requests with 10ms gaps during scan; elapsed includes polling and final sampler completion",
        scope:
          "Deterministic synthetic TS/Java/mixed repositories, not production repository or LLM/network benchmarks",
      },
      datasets: [] as unknown[],
    };
    for (const kind of ["typescript", "java", "mixed"]) {
      const data = await dataset(kind, count);
      const runs = [];
      for (let repetition = 1; repetition <= repeats; repetition++) {
        runs.push({ repetition, ...(await run(data.root)) });
        console.log(`${kind}: repetition ${repetition}/${repeats} complete`);
      }
      result.datasets.push({ ...data.identity, runs });
    }
    const output = path.resolve(
      process.env.LEANREVIEW_BASELINE_OUTPUT ??
        "docs/migration/backend-baseline.json",
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n");
    console.log(`Baseline saved to ${output}`);
  }
}
