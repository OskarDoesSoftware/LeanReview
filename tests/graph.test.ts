import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { scanGraph, graphCycles } from "../backend/src/graph/scan";
import {
  localGraphSource,
  type GraphSource,
} from "../backend/src/graph/source";
import { GraphService } from "../backend/src/graph/service";
import { captureSnapshot } from "../backend/src/git/local";
import { Store } from "../backend/src/storage/store";
import Database from "better-sqlite3";
import { graphView } from "../frontend/src/lib/graph-view";
import type { Snapshot } from "../packages/contracts/src/index";
import type { GraphOptions } from "../packages/contracts/src/graph";
const options: GraphOptions = {
  side: "after",
  maxFiles: 10000,
  maxBytes: 20 * 1024 * 1024,
};
const resources: { store: Store; service?: GraphService }[] = [];
afterEach(async () => {
  for (const { store, service } of resources.splice(0)) {
    await service?.shutdown();
    store.close();
  }
});
function snapshot(): Snapshot {
  return {
    id: "graph-snapshot",
    sessionId: "graph-session",
    root: process.cwd(),
    head: null,
    base: null,
    capturedAt: new Date().toISOString(),
    comparison: { mode: "all", base: "main" },
    files: [],
    complete: true,
  };
}
function memory(files: Record<string, string>, complete = true): GraphSource {
  return {
    revision: "fixture-revision",
    complete,
    paths: Object.keys(files),
    read: async (name) => {
      if (!(name in files)) throw new Error("Missing fixture");
      return files[name];
    },
  };
}
describe("source dependency adapters", () => {
  it("resolves captured workspace exports and arbitrary relative config inheritance without evaluating config", async () => {
    const graph = await scanGraph(
      snapshot(),
      options,
      undefined,
      memory({
        "base.json":
          '{"compilerOptions":{"baseUrl":".","paths":{"@local/*":["src/*"]}}}',
        "tsconfig.json": '{"extends":"./base.json"}',
        "src/component.tsx":
          'import type {T} from "@local/types";import {shared} from "@workspace/shared";export const Component=()=> <div>{shared}</div>;',
        "src/types.ts": "export type T=number;",
        "packages/shared/package.json":
          '{"name":"@workspace/shared","exports":{".":{"types":"./src/index.ts"}},"scripts":{"prepare":"DO NOT EXECUTE"}}',
        "packages/shared/src/index.ts": "export const shared=1;",
      }),
    );
    expect(graph.coverage.parserFailures).toBe(0);
    expect(graph.edges.filter((e) => e.status === "resolved")).toHaveLength(2);
    expect(graph.provenance.configuration).toContain("base.json");
  });
  it("does not resolve a Java generic parameter to an unrelated source class", async () => {
    const graph = await scanGraph(
      snapshot(),
      options,
      undefined,
      memory({
        "p/A.java":
          "package p; class A<T> { T field; <T> T method(T value) { return value; } }",
        "p/T.java": "package p; class T {}",
      }),
    );
    expect(graph.coverage.parserFailures).toBe(0);
    expect(
      graph.edges.filter(
        (e) => e.specifier === "T" && e.kind === "type-reference",
      ),
    ).toHaveLength(0);
  });
  it("resolves aliases, inherited config, re-exports, type-only and literal dynamic imports", async () => {
    const files = {
      "tsconfig.base.json":
        '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}',
      "tsconfig.json": '{"extends":"./tsconfig.base.json"}',
      "src/a.ts":
        'import type {B} from "@app/b";export {b} from "./b.js";export {type B} from "./b";const literal=import("./b");const unknown=import(getPath());const lib=require("node:fs");',
      "src/b.ts": "export type B=number;export const b=1;",
    };
    const graph = await scanGraph(
      snapshot(),
      options,
      undefined,
      memory(files),
    );
    expect(graph.coverage.scanned).toBe(2);
    expect(graph.edges.filter((e) => e.status === "resolved")).toHaveLength(4);
    expect(graph.edges.some((e) => e.kind === "re-export" && e.typeOnly)).toBe(
      true,
    );
    expect(
      graph.edges.some(
        (e) => e.kind === "re-export" && e.status === "resolved",
      ),
    ).toBe(true);
    expect(graph.edges.some((e) => e.typeOnly && e.status === "resolved")).toBe(
      true,
    );
    expect(
      graph.edges.some(
        (e) => e.kind === "dynamic" && e.status === "unresolved",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) => e.status === "external" && e.specifier === "node:fs",
      ),
    ).toBe(true);
  });
  it("finds source cycles without recursively traversing a large graph", () => {
    expect(
      graphCycles(
        ["a", "b", "c"],
        [
          { source: "a", target: "b" },
          { source: "b", target: "a" },
          { source: "b", target: "c" },
        ],
      ),
    ).toEqual([["a", "b"]]);
    const nodes = Array.from({ length: 15000 }, (_, i) => String(i));
    expect(
      graphCycles(
        nodes,
        nodes.slice(1).map((n, i) => ({ source: String(i), target: n })),
      ),
    ).toEqual([]);
  });
  it("resolves Java same-package, cross-package, wildcard and fully qualified type references", async () => {
    const files = {
      "src/main/java/a/A.java":
        "package a; import b.C; import c.*; class A extends B { C c; D d; b.C full; }",
      "src/main/java/a/B.java": "package a; class B { A a; }",
      "src/main/java/b/C.java": "package b; public class C {}",
      "src/main/java/c/D.java": "package c; public class D {}",
    };
    const graph = await scanGraph(
      snapshot(),
      options,
      undefined,
      memory(files),
    );
    expect(graph.coverage.parserFailures).toBe(0);
    expect(graph.nodes.filter((n) => n.kind === "package")).toHaveLength(3);
    const a = graph.nodes.find((n) => n.label === "a.A")!;
    const targets = graph.edges
      .filter((e) => e.source === a.id && e.status === "resolved")
      .map((e) => graph.nodes.find((n) => n.id === e.target)?.label);
    expect(targets).toEqual(expect.arrayContaining(["a.B", "b.C", "c.D"]));
    expect(graph.cycles).toHaveLength(1);
    expect(
      graph.edges.some(
        (e) => e.status === "unresolved" && e.specifier === "c.*",
      ),
    ).toBe(true);
  });
  it("does not invent targets for duplicate Java declarations or parser failures", async () => {
    const graph = await scanGraph(
      snapshot(),
      options,
      undefined,
      memory({
        "one/A.java": "package p; class A { B b; }",
        "one/B.java": "package p; class B {}",
        "two/B.java": "package p; class B {}",
        "bad.java": "class !@#",
      }),
    );
    expect(graph.coverage.parserFailures).toBe(1);
    expect(graph.edges.find((e) => e.specifier === "B")?.status).toBe(
      "unresolved",
    );
    expect(graph.coverage.complete).toBe(false);
  });
  it("reports file/byte caps, incomplete inventories, and cancellation", async () => {
    const files = {
      "a.ts": 'import "./b"',
      "b.ts": "export const b=1",
      "c.ts": "export const c=1",
    };
    const graph = await scanGraph(
      snapshot(),
      { ...options, maxFiles: 1 },
      undefined,
      memory(files),
    );
    expect(graph.coverage.scanned).toBe(1);
    expect(graph.coverage.skipped).toBe(2);
    expect(graph.coverage.complete).toBe(false);
    const byteCapped = await scanGraph(
      snapshot(),
      { ...options, maxBytes: 5 },
      undefined,
      memory(files),
    );
    expect(byteCapped.coverage.scanned).toBe(0);
    expect(
      byteCapped.coverage.omissions.every((o) => o.reason.includes("byte")),
    ).toBe(true);
    expect(
      (await scanGraph(snapshot(), options, undefined, memory(files, false)))
        .coverage.complete,
    ).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanGraph(snapshot(), options, controller.signal, memory(files)),
    ).rejects.toThrow("canceled");
  });
  it("bounds visible graphs, exposes dependencies and scanned incoming neighbors, and groups Java classes", async () => {
    const s = snapshot();
    s.files = [
      {
        id: "changed-a",
        path: "a.ts",
        oldPath: "a.ts",
        status: "modified",
        fingerprint: "x",
        patch: "",
        before: { kind: "text", text: "" },
        after: { kind: "text", text: "" },
      },
    ];
    const files: Record<string, string> = {
      "a.ts": 'import "./b"',
      "b.ts": "export const b=1",
      "caller.ts": 'import "./a"',
    };
    for (let i = 0; i < 210; i++) files[`other${i}.ts`] = "export const n=1";
    const graph = await scanGraph(s, options, undefined, memory(files));
    const opts = {
      scope: "review" as const,
      query: "",
      showExternal: true,
      showTypeOnly: true,
      expanded: [],
      javaPackage: null,
      collapseCycles: false,
      limit: 200,
    };
    expect(graphView(graph, opts).nodes.map((n) => n.path)).toEqual([
      "a.ts",
      "b.ts",
    ]);
    const a = graph.nodes.find((n) => n.path === "a.ts")!;
    expect(
      graphView(graph, { ...opts, expanded: [a.id] }).nodes.some(
        (n) => n.path === "caller.ts",
      ),
    ).toBe(true);
    expect(
      graphView(graph, { ...opts, scope: "repository" }).nodes,
    ).toHaveLength(200);
    expect(
      graphView(graph, { ...opts, scope: "repository", query: "other209" })
        .nodes[0].path,
    ).toBe("other209.ts");
    const members = graph.nodes.filter((n) => n.kind === "module").slice(0, 70);
    graph.edges = members.flatMap((source) =>
      members
        .filter((target) => target.id !== source.id)
        .map((target) => ({
          id: `${source.id}:${target.id}`,
          source: source.id,
          target: target.id,
          kind: "import" as const,
          typeOnly: false,
          status: "resolved" as const,
          path: source.path!,
          line: 1,
          specifier: target.label,
          resolver: "fixture",
        })),
    );
    const dense = graphView(graph, { ...opts, scope: "repository" });
    expect(dense.edges).toHaveLength(2000);
    expect(dense.totalEdges).toBeGreaterThan(2000);
    expect(graph.edges.length).toBeGreaterThan(2000);
  });
});
async function temp() {
  await mkdir(".leanreview-test", { recursive: true });
  return mkdtemp(path.resolve(".leanreview-test/graph-"));
}
async function repository() {
  const root = await temp(),
    git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        stdio: "pipe",
        windowsHide: true,
      });
  git("init", "-b", "main");
  git("config", "user.name", "Graph fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(root, "a.ts"), 'import "./b";');
  await writeFile(path.join(root, "b.ts"), "export const b=1;");
  git("add", ".");
  git("commit", "-m", "initial");
  return { root, git };
}
async function wait(service: GraphService, s: Snapshot) {
  for (let i = 0; i < 200; i++) {
    const view = service.view(s, "after");
    if (view.run?.status !== "running") return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Graph fixture timed out");
}
describe("pinned graph capture and persistence", () => {
  it("backs up a v2 database and preserves snapshots and settings during graph migration", async () => {
    const directory = await temp(),
      store = new Store(directory),
      s = snapshot();
    store.create(s);
    store.setSetting("fixture-setting", { keep: true });
    store.db.exec("DROP TABLE graphs; PRAGMA user_version=2;");
    store.close();
    const reopened = new Store(directory);
    resources.push({ store: reopened });
    expect(reopened.review(s.sessionId).snapshot.id).toBe(s.id);
    expect(reopened.setting("fixture-setting")).toEqual({ keep: true });
    const { readdir } = await import("node:fs/promises");
    const backup = (await readdir(directory)).find((name) =>
      name.startsWith("leanreview.pre-v3."),
    )!;
    expect(backup).toBeTruthy();
    const prior = new Database(path.join(directory, backup), {
      readonly: true,
    });
    expect(prior.pragma("user_version", { simple: true })).toBe(2);
    expect(
      prior.prepare("SELECT COUNT(*) AS count FROM snapshots").get(),
    ).toEqual({ count: 1 });
    prior.close();
  });
  it("uses captured index/working overlays for both sides after the checkout changes", async () => {
    const { root, git } = await repository();
    await writeFile(path.join(root, "a.ts"), 'import "./c";');
    await writeFile(path.join(root, "c.ts"), "export const c=1;");
    git("add", ".");
    await writeFile(path.join(root, "a.ts"), 'import "./b";');
    const staged = await captureSnapshot(
      root,
      { mode: "staged", base: "main" },
      "staged",
    );
    const unstaged = await captureSnapshot(
      root,
      { mode: "unstaged", base: "main" },
      "unstaged",
    );
    await writeFile(path.join(root, "a.ts"), "malicious later source");
    await writeFile(path.join(root, "b.ts"), "later");
    git("add", ".");
    expect(await localGraphSource(staged, "after").read("a.ts")).toBe(
      'import "./c";',
    );
    expect(await localGraphSource(unstaged, "before").read("a.ts")).toBe(
      'import "./c";',
    );
    expect(await localGraphSource(unstaged, "after").read("b.ts")).toBe(
      "export const b=1;",
    );
    const before = await scanGraph(staged, { ...options, side: "before" }),
      after = await scanGraph(staged, options);
    expect(before.edges[0].specifier).toBe("./b");
    expect(after.edges[0].specifier).toBe("./c");
  });
  it("preserves verified rename navigation and captured sources across restart", async () => {
    const { root, git } = await repository();
    git("mv", "a.ts", "renamed.ts");
    const s = await captureSnapshot(
      root,
      { mode: "staged", base: "main" },
      "rename",
    );
    expect(s.files[0].status).toBe("renamed");
    const directory = await temp(),
      store = new Store(directory);
    store.create(s);
    const service = new GraphService(store);
    resources.push({ store, service });
    service.start(s, options);
    const result = await wait(service, s);
    expect(result.run?.status).toBe("succeeded");
    const node = result.graph!.nodes.find((n) => n.path === "renamed.ts")!;
    expect(node.fileId).toBe(s.files[0].id);
    await writeFile(path.join(root, "b.ts"), "new working contents");
    expect(
      service.source(
        s,
        "after",
        result.graph!.nodes.find((n) => n.path === "b.ts")!.id,
      ).text,
    ).toBe("export const b=1;");
    await service.shutdown();
    store.close();
    resources.pop();
    const reopened = new Store(directory);
    resources.push({ store: reopened });
    expect(new GraphService(reopened).view(s, "after").graph?.revision).toBe(
      result.graph?.revision,
    );
  });
  it("recovers an interrupted graph run and keeps the previous cached result on cancellation", async () => {
    const { root } = await repository();
    const s = await captureSnapshot(
      root,
      { mode: "all", base: "main" },
      "recover",
    );
    const directory = await temp(),
      store = new Store(directory);
    store.create(s);
    const service = new GraphService(store);
    resources.push({ store, service });
    service.start(s, options);
    expect((await wait(service, s)).run?.status).toBe("succeeded");
    const revision = service.view(s, "after").graph!.revision;
    service.start(s, options);
    service.cancel(s.id);
    expect((await wait(service, s)).run?.status).toBe("canceled");
    expect(service.view(s, "after").graph?.revision).toBe(revision);
    store.db.prepare("UPDATE graphs SET run=?").run(
      JSON.stringify({
        status: "running",
        startedAt: new Date().toISOString(),
      }),
    );
    store.close();
    resources.pop();
    const reopened = new Store(directory);
    resources.push({ store: reopened });
    expect(new GraphService(reopened).view(s, "after").run?.status).toBe(
      "interrupted",
    );
  });
});
