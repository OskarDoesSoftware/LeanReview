import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { z } from "zod";
import { Store } from "../../backend/src/storage/store";
import { CapturedArtifacts } from "../../backend/src/storage/artifacts";
import { createApp } from "../../backend/src/api/app";
import { hash } from "../../backend/src/git/local";
import * as contracts from "../../packages/contracts/src/index";
import * as coverage from "../../packages/contracts/src/coverage";
import * as graph from "../../packages/contracts/src/graph";
import { editorSchema } from "../../backend/src/api/editor";
import { measure } from "../../backend/src/coverage/metrics";
import {
  typescriptDependencies,
  typescriptResolver,
} from "../../backend/src/graph/typescript";
import { javaClasses } from "../../backend/src/graph/java";
import { functionUnits } from "../../backend/src/coverage/typescript";

export const fixtureDirectory = path.resolve(
  "tests/fixtures/backend-compatibility",
);
const time = "2026-10-15T10:00:00.000Z";
export const source =
  "export function choose(x: number) {\n  if (x > 0) return 1;\n  return 0;\n}\n";
export function snapshot(root = "/fixture/leanreview"): contracts.Snapshot {
  const files: contracts.FileChange[] = [
    {
      id: "file-ts",
      path: "src/choose.ts",
      oldPath: "src/choose.ts",
      status: "modified",
      fingerprint: hash(source),
      patch:
        "--- a/src/choose.ts\n+++ b/src/choose.ts\n@@ -1 +1,4 @@\n-export const choose = 0;\n+export function choose(x: number) {\n+  if (x > 0) return 1;\n+  return 0;\n+}\n",
      before: { kind: "text", text: "export const choose = 0;\n" },
      after: { kind: "text", text: source },
    },
    {
      id: "file-java",
      path: "src/Choose.java",
      oldPath: "src/Old.java",
      status: "renamed",
      fingerprint: "java-fingerprint",
      patch: "rename from src/Old.java\nrename to src/Choose.java\n",
      before: { kind: "text", text: "package fixture; class Choose {}\n" },
      after: { kind: "text", text: "package fixture; class Choose {}\n" },
    },
    ...(["binary", "oversized", "unavailable"] as const).map((kind) => ({
      id: `file-${kind}`,
      path: `${kind}.dat`,
      oldPath: `${kind}.dat`,
      status: "modified" as const,
      fingerprint: kind,
      patch: "",
      before: { kind, reason: `Synthetic ${kind}` },
      after: { kind, reason: `Synthetic ${kind}` },
    })),
    {
      id: "file-deleted",
      path: "deleted.ts",
      oldPath: "deleted.ts",
      status: "deleted",
      fingerprint: "deleted",
      patch: "-export {};\n",
      before: { kind: "text", text: "export {};\n" },
      after: { kind: "absent" },
    },
  ];
  return {
    id: "snapshot-current",
    sessionId: "session-fixture",
    capturedAt: time,
    root,
    comparison: { mode: "all", base: "main" },
    head: null,
    base: null,
    files,
    complete: true,
  };
}
export const provider: contracts.ProviderConfig = {
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  model: "fixture",
  contextWindow: 8192,
  maxOutput: 2048,
  localOnly: true,
};
export const testConfig: coverage.TestConfig = {
  format: "istanbul",
  cwd: ".",
  reportPath: "coverage/report.json",
  timeoutSeconds: 5,
  threshold: 8,
  steps: [{ executable: "fixture-do-not-execute", args: [], shell: false }],
};
export const report = JSON.stringify({
  "src/choose.ts": {
    path: "src/choose.ts",
    statementMap: {
      0: { start: { line: 2, column: 2 }, end: { line: 2, column: 22 } },
      1: { start: { line: 3, column: 2 }, end: { line: 3, column: 11 } },
    },
    s: { 0: 1, 1: 0 },
  },
});

export function seed(store: Store, root?: string) {
  const current = snapshot(root);
  store.create({
    ...current,
    id: "snapshot-history",
    capturedAt: "2026-10-14T10:00:00.000Z",
  });
  store.refresh(current);
  const review = store.review(current.sessionId);
  review.state.reviewed = ["file-ts"];
  review.state.drafts = [
    {
      id: "draft-saved",
      fileId: "file-ts",
      path: "src/choose.ts",
      side: "after",
      line: 2,
      text: "Synthetic review comment: café",
      needsReattachment: false,
    },
  ];
  review.state.analysisStatus = "running";
  store.saveState(current.id, review.state);
  store.db.prepare("UPDATE sessions SET updated_at=?").run(time);
  store.setSetting("provider", provider);
  const provenance: coverage.CoverageProvenance = {
    version: 1,
    reportHash: hash(report),
    sourceHashes: { "src/choose.ts": hash(source) },
    tool: "synthetic fixture",
    capturedAt: time,
    head: null,
  };
  const metrics = {
    ...measure(current, "istanbul", report, provenance),
    capturedAt: time,
  };
  store.saveCoverage(metrics, report, provenance);
  store.saveTestRun({
    id: "test-running",
    snapshotId: current.id,
    config: testConfig,
    startedAt: time,
    status: "running",
    log: "synthetic output\n",
  });
  const artifacts = new CapturedArtifacts(store.cache);
  const graphValue = {
    version: 1,
    snapshotId: current.id,
    side: "before",
    revision: "synthetic",
    capturedAt: time,
    options: { side: "before", maxFiles: 1, maxBytes: 1024 },
    nodes: [],
    edges: [],
    cycles: [],
    coverage: {
      listed: 2,
      eligible: 2,
      scanned: 0,
      skipped: 2,
      bytes: 0,
      parserFailures: 0,
      unresolved: 0,
      incoming: "scanned sources only",
      complete: false,
      omissions: [],
      warnings: ["Synthetic partial graph"],
    },
    provenance: { typescript: "6.0.3", java: "fixture", configuration: [] },
  };
  store.db
    .prepare("INSERT INTO graphs VALUES (?,?,?,?,?)")
    .run(
      current.id,
      "before",
      artifacts.write(JSON.stringify(graphValue)),
      JSON.stringify({ "src/choose.ts": artifacts.write(source) }),
      JSON.stringify({ status: "running", startedAt: time }),
    );
  return current;
}

/** Export actual SQLite files and a language-neutral ordered row/schema dump. */
export async function exportDatabases(destination: string) {
  await fs.mkdir(destination, { recursive: true });
  const scratch = await fs.mkdtemp(path.resolve(".leanreview-test/export-"));
  const store = new Store(scratch);
  seed(store);
  store.db.pragma("wal_checkpoint(TRUNCATE)");
  store.close();
  const dumps: Record<string, unknown> = {};
  for (const version of [1, 2, 3]) {
    const directory = path.join(destination, `v${version}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.cp(path.join(scratch, "cache"), path.join(directory, "cache"), {
      recursive: true,
    });
    const file = path.join(directory, "leanreview.sqlite");
    await fs.copyFile(path.join(scratch, "leanreview.sqlite"), file);
    const db = new Database(file);
    if (version < 3) db.exec("DROP TABLE graphs");
    if (version < 2)
      db.exec("DROP TABLE coverage_reports; DROP TABLE test_runs");
    db.pragma(`user_version=${version}`);
    db.pragma("journal_mode=DELETE");
    const tables = db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string; sql: string }[];
    dumps[`v${version}`] = {
      userVersion: version,
      tables: tables.map((table) => ({
        ...table,
        rows: db
          .prepare(
            `SELECT rowid AS _rowid_, * FROM ${table.name} ORDER BY rowid`,
          )
          .all(),
      })),
    };
    db.close();
  }
  return dumps;
}

export function jsonSchemas() {
  return Object.fromEntries(
    Object.entries({ ...contracts, ...coverage, ...graph, editorSchema })
      .filter(([, value]) => value instanceof z.ZodType)
      .map(([key, value]) => [
        key,
        z.toJSONSchema(value as z.ZodType, { io: "input" }),
      ]),
  );
}

export async function parserFixtures() {
  const imports =
    "import type { Value } from '@app/value';\nexport { value } from './value';\nconst load = import('./lazy');\nconst computed = import(name);\n";
  const files = new Map([
    ["src/main.ts", imports],
    ["src/value.ts", "export const value = 1; export type Value = number;"],
    ["src/lazy.ts", "export {};"],
    [
      "tsconfig.json",
      '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}',
    ],
  ]);
  const warnings: string[] = [];
  const resolve = typescriptResolver(files, new Set(files.keys()), warnings);
  return {
    typescript: {
      file: "src/main.ts",
      text: imports,
      dependencies: typescriptDependencies("src/main.ts", imports),
      resolved: ["@app/value", "./value", "./lazy", "missing"].map(
        (specifier) => ({
          specifier,
          target: resolve("src/main.ts", specifier) ?? null,
        }),
      ),
      warnings,
    },
    java: {
      text: "package fixture; import java.util.List; class Outer<T> { List<T> values; class Inner { Outer<String> parent; } }",
      classes: await javaClasses(
        "package fixture; import java.util.List; class Outer<T> { List<T> values; class Inner { Outer<String> parent; } }",
      ),
    },
    complexity: {
      file: "src/choose.ts",
      text: source,
      units: functionUnits("src/choose.ts", source).units,
    },
  };
}

export async function routeInventory() {
  const routes: { method: string; path: string; source: string }[] = [];
  for (const name of ["app.ts", "coverage.ts", "graph.ts"]) {
    const text = await fs.readFile(`backend/src/api/${name}`, "utf8");
    for (const match of text.matchAll(
      /app\.(get|post|delete|put|patch)\(\s*"([^"]+)"/g,
    ))
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        source: `backend/src/api/${name}`,
      });
  }
  return routes;
}

export async function captureHttp() {
  await fs.mkdir(".leanreview-test", { recursive: true });
  const directory = await fs.mkdtemp(
    path.resolve(".leanreview-test/http-compat-"),
  );
  const root = path.join(directory, "repository");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/choose.ts"), source);
  let store = new Store(path.join(directory, "data"));
  seed(store, root);
  store.close();
  store = new Store(path.join(directory, "data"));
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No HTTP fixture port");
  const base = `http://127.0.0.1:${address.port}`;
  const origin = base;
  const application = createApp(store, origin, "fixture-nonce");
  server.on("request", application.app);
  const records: unknown[] = [];
  let cookie = "";
  const uuidNames = new Map<string, string>();
  function normalize(value: unknown, key = ""): unknown {
    if (typeof value === "string") {
      if (/At$/.test(key) && /^\d{4}-\d\d-\d\dT/.test(value)) {
        if (!Number.isFinite(Date.parse(value)))
          throw new Error(`Invalid fixture timestamp: ${key}`);
        return "<timestamp>";
      }
      return value
        .replaceAll(root, "<repository>")
        .replaceAll(root.replaceAll("\\", "/"), "<repository>")
        .replace(
          /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
          (id) => {
            if (!uuidNames.has(id))
              uuidNames.set(id, `<uuid-${uuidNames.size + 1}>`);
            return uuidNames.get(id)!;
          },
        );
    }
    if (Array.isArray(value)) return value.map((v) => normalize(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
      );
    return value;
  }
  async function request(
    name: string,
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
    record = true,
  ) {
    const response = await new Promise<{
      status: number;
      headers: Headers;
      data: unknown;
    }>((resolve, reject) => {
      const outgoing = httpRequest(
        base + "/api" + url,
        {
          method,
          agent: false,
          headers: {
            origin,
            ...(cookie ? { cookie } : {}),
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...headers,
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => {
            try {
              const responseHeaders = new Headers();
              for (const [key, value] of Object.entries(incoming.headers))
                if (value !== undefined)
                  responseHeaders.set(
                    key,
                    Array.isArray(value) ? value.join(", ") : value,
                  );
              resolve({
                status: incoming.statusCode!,
                headers: responseHeaders,
                data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.on("error", (error) =>
        reject(
          new Error(`Fixture ${name}: ${error.message}`, { cause: error }),
        ),
      );
      outgoing.setTimeout(10000, () =>
        outgoing.destroy(new Error("Fixture HTTP timeout")),
      );
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const data: any = response.data;
    if (name === "bootstrap")
      cookie = response.headers.get("set-cookie")!.split(";")[0];
    const setCookie = response.headers.get("set-cookie") ?? "";
    if (record)
      records.push(
        normalize({
          name,
          request: {
            method,
            path: "/api" + url,
            ...(body === undefined ? {} : { body }),
            ...(Object.keys(headers).length ? { headers } : {}),
          },
          response: {
            status: response.status,
            cacheControl: response.headers.get("cache-control"),
            contentType: response.headers.get("content-type"),
            ...(name === "bootstrap"
              ? {
                  cookie: {
                    name: setCookie.split("=")[0],
                    httpOnly: /HttpOnly/i.test(setCookie),
                    sameSite: setCookie.match(/SameSite=([^;]+)/i)?.[1] ?? null,
                    path: setCookie.match(/Path=([^;]+)/i)?.[1] ?? null,
                    maxAgeSeconds: Number(
                      setCookie.match(/Max-Age=(\d+)/i)?.[1] ?? 0,
                    ),
                  },
                }
              : {}),
            body: data,
          },
        }),
      );
    return data;
  }
  const current = { snapshotId: "snapshot-current" };
  try {
    for (const route of await routeInventory())
      await request(
        `unauthorized ${route.method} ${route.path}`,
        route.method,
        route.path
          .replace(":id", "session-fixture")
          .replace(":draft", "draft-saved"),
        route.method === "GET" ? undefined : {},
      );
    await request("bad host", "GET", "/sessions", undefined, {
      host: "untrusted.invalid",
    });
    await request(
      "bad origin",
      "POST",
      "/session",
      { nonce: "fixture-nonce" },
      { origin: "https://untrusted.invalid" },
    );
    await request(
      "missing origin",
      "POST",
      "/session",
      { nonce: "fixture-nonce" },
      { origin: "" },
    );
    await request("bad nonce", "POST", "/session", { nonce: "wrong" });
    await request("bootstrap", "POST", "/session", { nonce: "fixture-nonce" });
    await request("reused nonce", "POST", "/session", {
      nonce: "fixture-nonce",
    });
    await request("unknown route", "GET", "/unknown");
    await request("saved sessions", "GET", "/sessions");
    await request("recovered review", "GET", "/sessions/session-fixture");
    await request(
      "historical review",
      "GET",
      "/sessions/session-fixture?snapshot=snapshot-history",
    );
    await request("missing session", "GET", "/sessions/missing");
    await request(
      "missing snapshot",
      "GET",
      "/sessions/session-fixture?snapshot=missing",
    );
    await request("invalid create", "POST", "/sessions", {});
    await request("provider", "GET", "/provider");
    await request("set provider", "POST", "/provider", {
      config: provider,
      persist: false,
    });
    await request("invalid provider budget", "POST", "/provider", {
      config: { ...provider, maxOutput: 8192 },
      persist: false,
    });
    await request("invalid local provider", "POST", "/provider", {
      config: { ...provider, endpoint: "https://example.invalid" },
      persist: false,
    });
    await request("set editor", "POST", "/editor", {
      name: "Fixture",
      executable: "fixture-do-not-execute",
      args: ["{file}"],
    });
    await request(
      "reject editor missing file",
      "POST",
      "/sessions/session-fixture/open-editor",
      { ...current, fileId: "missing", side: "after", line: 1 },
    );
    await request("manifest", "GET", "/sessions/session-fixture/manifest");
    await request(
      "unauthorized analysis",
      "POST",
      "/sessions/session-fixture/analysis",
      { ...current, manifestId: "wrong", authorize: false },
    );
    await request(
      "stale manifest",
      "POST",
      "/sessions/session-fixture/analysis",
      { ...current, manifestId: "wrong", authorize: true },
    );
    await request(
      "cancel idle analysis",
      "POST",
      "/sessions/session-fixture/cancel",
      current,
    );
    await request(
      "stale progress",
      "POST",
      "/sessions/session-fixture/progress",
      { snapshotId: "snapshot-history", fileIds: [], reviewed: true },
    );
    await request(
      "unknown progress file",
      "POST",
      "/sessions/session-fixture/progress",
      { ...current, fileIds: ["missing"], reviewed: true },
    );
    await request(
      "mark progress",
      "POST",
      "/sessions/session-fixture/progress",
      { ...current, fileIds: ["file-java"], reviewed: true },
    );
    const analysis = {
      cohorts: [
        {
          name: "Fixture",
          explanation: "Synthetic cohort",
          layers: [
            {
              name: "Read",
              explanation: "Synthetic layer",
              fileIds: snapshot().files.map((f) => f.id),
            },
          ],
        },
      ],
      findings: [
        {
          fileId: "file-ts",
          line: 2,
          kind: "improvement",
          message: "Synthetic finding",
        },
      ],
    };
    await request(
      "accept grouping",
      "POST",
      "/sessions/session-fixture/grouping",
      { ...current, analysis, acceptProposal: true },
    );
    await request(
      "invalid grouping",
      "POST",
      "/sessions/session-fixture/grouping",
      { ...current, analysis: { cohorts: [], findings: [] } },
    );
    const drafted = await request(
      "create draft",
      "POST",
      "/sessions/session-fixture/drafts",
      {
        ...current,
        fileId: "file-ts",
        side: "after",
        line: 2,
        text: "  Check café  ",
      },
    );
    await request(
      "invalid draft coordinates",
      "POST",
      "/sessions/session-fixture/drafts",
      {
        ...current,
        fileId: "file-ts",
        side: "after",
        line: 999,
        text: "Invalid",
      },
    );
    await request(
      "delete draft",
      "DELETE",
      `/sessions/session-fixture/drafts/${drafted.state.drafts.at(-1).id}`,
      current,
    );
    await request(
      "coverage",
      "GET",
      "/sessions/session-fixture/coverage?format=istanbul",
    );
    await request(
      "coverage artifact",
      "GET",
      "/sessions/session-fixture/coverage/artifact?format=istanbul",
    );
    await request(
      "missing coverage artifact",
      "GET",
      "/sessions/session-fixture/coverage/artifact?format=jacoco",
    );
    await request(
      "import unaligned coverage",
      "POST",
      "/sessions/session-fixture/coverage/import",
      { ...current, format: "istanbul", report, provenance: null },
    );
    await request(
      "set test config",
      "POST",
      "/sessions/session-fixture/coverage/config",
      { ...current, config: testConfig },
    );
    await fs.writeFile(
      path.join(root, "src/choose.ts"),
      "// deliberately changed checkout\n",
    );
    await request(
      "reject changed checkout preview",
      "POST",
      "/sessions/session-fixture/coverage/preview",
      { ...current, format: "istanbul" },
    );
    await fs.writeFile(path.join(root, "src/choose.ts"), source);
    await request(
      "reject unconfirmed tests",
      "POST",
      "/sessions/session-fixture/coverage/run",
      { ...current, previewId: "missing", confirmed: false },
    );
    await request(
      "cancel interrupted tests",
      "POST",
      "/sessions/session-fixture/coverage/cancel",
      { ...current, runId: "test-running" },
    );
    await request(
      "recovered partial graph",
      "GET",
      "/sessions/session-fixture/graph?snapshot=snapshot-current&side=before",
    );
    await request(
      "graph status only",
      "GET",
      "/sessions/session-fixture/graph?snapshot=snapshot-current&side=before&statusOnly=1",
    );
    await request(
      "missing graph source",
      "GET",
      "/sessions/session-fixture/graph/source?snapshot=snapshot-current&node=missing",
    );
    await request(
      "invalid graph options",
      "POST",
      "/sessions/session-fixture/graph",
      { ...current, options: { maxFiles: 0 } },
    );
    await request(
      "cancel idle graph",
      "POST",
      "/sessions/session-fixture/graph/cancel",
      current,
    );
    await request(
      "stale refresh",
      "POST",
      "/sessions/session-fixture/refresh",
      { snapshotId: "snapshot-history" },
    );
    await request(
      "start capped graph",
      "POST",
      "/sessions/session-fixture/graph",
      { ...current, options: { side: "after", maxFiles: 1, maxBytes: 1024 } },
    );
    let scanned: any;
    for (let attempt = 0; attempt < 500; attempt++) {
      scanned = await request(
        "poll",
        "GET",
        "/sessions/session-fixture/graph?snapshot=snapshot-current&side=after",
        undefined,
        {},
        false,
      );
      if (scanned.run?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (scanned?.run?.status !== "succeeded")
      throw new Error("Fixture graph did not finish");
    await request(
      "completed capped graph",
      "GET",
      "/sessions/session-fixture/graph?snapshot=snapshot-current&side=after",
    );
    const node = scanned.graph.nodes.find((node: graph.GraphNode) => node.path);
    await request(
      "captured graph source",
      "GET",
      `/sessions/session-fixture/graph/source?snapshot=snapshot-current&side=after&node=${node.id}`,
    );
    const emptyConfig = path.join(directory, "empty-gitconfig");
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
          GIT_AUTHOR_DATE: time,
          GIT_COMMITTER_DATE: time,
        },
      });
    git("init", "-b", "main");
    git("config", "user.name", "Compatibility fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "core.autocrlf", "false");
    await fs.writeFile(
      path.join(root, "src/choose.ts"),
      "export const choose = 0;\n",
    );
    git("add", ".");
    git(
      "-c",
      "core.hooksPath=",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Synthetic base",
    );
    await fs.writeFile(path.join(root, "src/choose.ts"), source);
    git("add", ".");
    await fs.writeFile(
      path.join(root, "src/choose.ts"),
      source + "// working change\n",
    );
    let created: any;
    for (const mode of ["branch", "staged", "unstaged", "all"]) {
      created = await request(`capture ${mode}`, "POST", "/sessions", {
        root,
        comparison: { mode, base: "main" },
      });
      if (!created.snapshot) throw new Error(`Capture ${mode} failed`);
    }
    await request(
      "refresh current snapshot",
      "POST",
      `/sessions/${created.snapshot.sessionId}/refresh`,
      { snapshotId: created.snapshot.id },
    );
    return records;
  } finally {
    await application.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
}
