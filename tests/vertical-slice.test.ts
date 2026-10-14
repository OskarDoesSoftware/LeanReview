import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { captureSnapshot, containedFile } from "../backend/src/git/local";
import { Store } from "../backend/src/storage/store";
import { prepare, validateAnalysis } from "../backend/src/review/analysis";
import { infer } from "../backend/src/llm/providers";
import { createApp } from "../backend/src/api/app";
import type {
  ProviderConfig,
  Review,
  Snapshot,
} from "../packages/contracts/src/index";
const stores: Store[] = [],
  servers: Server[] = [];
afterEach(async () => {
  stores.splice(0).forEach((s) => s.close());
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});
async function temp() {
  await mkdir(".leanreview-test", { recursive: true });
  return mkdtemp(path.resolve(".leanreview-test", "case-"));
}
async function repo() {
  const root = await temp();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "b.ts"), "export const b = 1;\n");
  git("add", ".");
  git("commit", "-m", "base");
  return { root, git };
}
const config: ProviderConfig = {
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  model: "fixture",
  contextWindow: 8192,
  maxOutput: 2048,
  localOnly: true,
};
function result(ids: string[]) {
  return {
    cohorts: [
      {
        name: "Feature",
        explanation: "Related changes",
        layers: [
          {
            name: "Implementation",
            explanation: "Understand behavior",
            fileIds: ids,
          },
        ],
      },
    ],
    findings: [],
  };
}
describe("local immutable snapshots", () => {
  it("separates index, working tree, and untracked files without invoking textconv", async () => {
    const { root, git } = await repo();
    await writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
    git("add", "a.ts");
    await writeFile(path.join(root, "a.ts"), "export const a = 3;\n");
    await writeFile(path.join(root, "new.ts"), "export const added = true;\n");
    const staged = await captureSnapshot(
      root,
      { mode: "staged", base: "main" },
      "session",
    );
    expect(staged.files).toHaveLength(1);
    expect(staged.files[0].after).toEqual({
      kind: "text",
      text: "export const a = 2;\n",
    });
    const unstaged = await captureSnapshot(
      root,
      { mode: "unstaged", base: "main" },
      "session",
    );
    expect(unstaged.files[0].before).toEqual({
      kind: "text",
      text: "export const a = 2;\n",
    });
    expect(unstaged.files.map((f) => f.path)).toContain("new.ts");
    const all = await captureSnapshot(
      root,
      { mode: "all", base: "main" },
      "session",
    );
    expect(all.files[0].before).toEqual({
      kind: "text",
      text: "export const a = 1;\n",
    });
    await writeFile(path.join(root, "a.ts"), "later");
    expect(all.files[0].after).toEqual({
      kind: "text",
      text: "export const a = 3;\n",
    });
  });
  it("captures unborn HEAD, renames, binary changes and merge-base comparisons", async () => {
    const empty = await temp();
    execFileSync("git", ["init"], { cwd: empty, stdio: "pipe" });
    await writeFile(path.join(empty, "first.ts"), "first");
    expect(
      (await captureSnapshot(empty, { mode: "all", base: "main" }, "session"))
        .files[0].status,
    ).toBe("added");
    const { root, git } = await repo();
    await rename(path.join(root, "a.ts"), path.join(root, "renamed.ts"));
    git("add", "-A");
    await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2]));
    const snapshot = await captureSnapshot(
      root,
      { mode: "all", base: "main" },
      "session",
    );
    expect(snapshot.files.find((f) => f.path === "renamed.ts")?.status).toBe(
      "renamed",
    );
    expect(snapshot.files.find((f) => f.path === "image.bin")?.after.kind).toBe(
      "binary",
    );
    git("commit", "-m", "rename");
    git("checkout", "-b", "feature");
    await writeFile(path.join(root, "b.ts"), "feature\n");
    git("add", "b.ts");
    git("commit", "-m", "feature");
    expect(
      (
        await captureSnapshot(root, { mode: "branch", base: "main" }, "session")
      ).files.map((f) => f.path),
    ).toEqual(["b.ts"]);
    await expect(containedFile(root, "../outside")).rejects.toThrow();
  });
});
describe("SQLite persistence and refresh", () => {
  it("reopens cached snapshots and transfers only unchanged progress and comment anchors", async () => {
    const { root } = await repo();
    await writeFile(path.join(root, "a.ts"), "a2\n");
    await writeFile(path.join(root, "b.ts"), "b2\n");
    const directory = await temp();
    let store = new Store(directory);
    const first = await captureSnapshot(
      root,
      { mode: "all", base: "main" },
      "review",
    );
    store.create(first);
    const state = store.review("review").state;
    state.reviewed = first.files.map((f) => f.id);
    state.drafts = [
      {
        id: "draft",
        fileId: first.files[0].id,
        path: "a.ts",
        side: "after",
        line: 1,
        text: "Check this",
        needsReattachment: false,
      },
    ];
    store.saveState(first.id, state);
    store.close();
    store = new Store(directory);
    stores.push(store);
    expect(store.review("review").state.reviewed).toHaveLength(2);
    await writeFile(path.join(root, "a.ts"), "a3\n");
    const next = await captureSnapshot(root, first.comparison, "review");
    const refreshed = store.refresh(next);
    expect(refreshed.state.reviewed).toEqual([first.files[1].id]);
    expect(refreshed.state.drafts[0].needsReattachment).toBe(true);
    expect(store.review("review", first.id).snapshot.files[0].after).toEqual({
      kind: "text",
      text: "a2\n",
    });
    expect(
      (
        store.db
          .prepare("SELECT data FROM snapshots WHERE id = ?")
          .get(first.id) as { data: string }
      ).data,
    ).not.toContain("a2\\n");
  });
  it("recovers interrupted analysis without deleting accepted proposals", async () => {
    const { root } = await repo();
    await writeFile(path.join(root, "a.ts"), "edit");
    const directory = await temp();
    let store = new Store(directory);
    const snapshot = await captureSnapshot(
      root,
      { mode: "all", base: "main" },
      "review",
    );
    store.create(snapshot);
    const state = store.review("review").state;
    state.accepted = result(snapshot.files.map((f) => f.id));
    state.analysisStatus = "running";
    store.saveState(snapshot.id, state);
    store.close();
    store = new Store(directory);
    stores.push(store);
    expect(store.review("review").state.analysisStatus).toBe("interrupted");
    expect(store.review("review").state.accepted).toEqual(state.accepted);
  });
});
describe("analysis contracts and provider adapters", () => {
  it("rejects duplicated/invented IDs and invalid finding coordinates", async () => {
    const { root } = await repo();
    await writeFile(path.join(root, "a.ts"), "edit");
    const snapshot = await captureSnapshot(
      root,
      { mode: "all", base: "main" },
      "review",
    );
    expect(() => validateAnalysis(result(["invented"]), snapshot)).toThrow();
    expect(() =>
      validateAnalysis(
        result([snapshot.files[0].id, snapshot.files[0].id]),
        snapshot,
      ),
    ).toThrow();
    expect(() =>
      validateAnalysis(
        {
          ...result([snapshot.files[0].id]),
          findings: [
            {
              fileId: snapshot.files[0].id,
              line: 99,
              kind: "bug",
              message: "Wrong",
            },
          ],
        },
        snapshot,
      ),
    ).toThrow();
    const prepared = prepare(snapshot, config);
    expect(prepared.batches).toHaveLength(1);
    expect(prepared.manifest.files[0].included).toBe(true);
  });
  it.each(["ollama", "openai", "anthropic"] as const)(
    "parses %s structured responses without switching providers",
    async (provider) => {
      let received: any;
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        received = JSON.parse(body);
        const text = JSON.stringify(result(["file"]));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            provider === "ollama"
              ? { message: { content: text } }
              : provider === "openai"
                ? {
                    status: "completed",
                    output: [{ content: [{ type: "output_text", text }] }],
                  }
                : {
                    stop_reason: "end_turn",
                    content: [{ type: "text", text }],
                  },
          ),
        );
      });
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address() as { port: number };
      const value = await infer(
        { ...config, provider, endpoint: `http://127.0.0.1:${address.port}` },
        "dummy-key",
        {},
        new AbortController().signal,
      );
      expect(value.cohorts[0].layers[0].fileIds).toEqual(["file"]);
      if (provider === "openai") expect(received.store).toBe(false);
    },
  );
});
describe("protected end-to-end local API", () => {
  it("requires one-time session and same-origin writes; persists review workflow without plaintext keys", async () => {
    const directory = await temp();
    const store = new Store(directory);
    stores.push(store);
    let handler: ReturnType<typeof createApp>["app"];
    const server = createServer((req, res) => handler(req, res));
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;
    const origin = url;
    handler = createApp(store, origin, "fixture-nonce").app;
    const headers: Record<string, string> = {
      origin,
      "content-type": "application/json",
    };
    expect((await fetch(`${url}/api/sessions`, { headers })).status).toBe(401);
    const auth = await fetch(`${url}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ nonce: "fixture-nonce" }),
    });
    expect(auth.status).toBe(200);
    headers.cookie = auth.headers.get("set-cookie")!.split(";")[0];
    expect(
      (
        await fetch(`${url}/api/session`, {
          method: "POST",
          headers,
          body: JSON.stringify({ nonce: "fixture-nonce" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/api/sessions`, {
          method: "POST",
          headers: { ...headers, origin: "https://evil.invalid" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const { root } = await repo();
    await writeFile(path.join(root, "a.ts"), "updated\n");
    const created = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root, comparison: { mode: "all" } }),
    });
    expect(created.status).toBe(200);
    const review = (await created.json()) as Review;
    const progressed = await fetch(
      `${url}/api/sessions/${review.snapshot.sessionId}/progress`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          snapshotId: review.snapshot.id,
          fileIds: [review.snapshot.files[0].id],
          reviewed: true,
        }),
      },
    );
    expect(((await progressed.json()) as Review).state.reviewed).toHaveLength(
      1,
    );
    const configured = await fetch(`${url}/api/provider`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        config: {
          ...config,
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          localOnly: false,
        },
        token: "fixture-secret-do-not-persist",
        persist: false,
      }),
    });
    expect(configured.status).toBe(200);
    const publicConfig = await fetch(`${url}/api/provider`, { headers });
    expect(await publicConfig.text()).not.toContain("fixture-secret");
    expect(
      JSON.stringify(store.db.prepare("SELECT * FROM settings").all()),
    ).not.toContain("fixture-secret");
    const denied = await fetch(
      `${url}/api/sessions/${review.snapshot.sessionId}/analysis`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          snapshotId: review.snapshot.id,
          authorize: false,
        }),
      },
    );
    expect(denied.status).toBe(400);
    const staleManifest = await fetch(
      `${url}/api/sessions/${review.snapshot.sessionId}/analysis`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          snapshotId: review.snapshot.id,
          manifestId: "not-the-previewed-configuration",
          authorize: true,
        }),
      },
    );
    expect(staleManifest.status).toBe(400);
    expect(await staleManifest.text()).toContain("Preview and authorize again");
  });
});
