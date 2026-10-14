import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../backend/src/storage/store";
import { CapturedArtifacts } from "../backend/src/storage/artifacts";
import { ReviewAnalysis } from "../backend/src/review/runner";
import { ReviewNavigation } from "../frontend/src/lib/review-navigation";
import type { api } from "../frontend/src/lib/api";
import {
  emptyState,
  type Analysis,
  type ProviderConfig,
  type Review,
  type Snapshot,
} from "../packages/contracts/src/index";
import { measure } from "../backend/src/coverage/metrics";

const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.useRealTimers();
});
function directory() {
  fs.mkdirSync(".leanreview-test", { recursive: true });
  return fs.mkdtempSync(path.resolve(".leanreview-test/architecture-"));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function snapshot(id = "snapshot", sessionId = "session"): Snapshot {
  return {
    id,
    sessionId,
    root: "fixture",
    capturedAt: "2026-10-14T12:00:00Z",
    comparison: { mode: "all", base: "main" },
    head: null,
    base: null,
    complete: true,
    files: ["a", "b"].map((id) => ({
      id,
      path: `${id}.ts`,
      oldPath: `${id}.ts`,
      status: "modified",
      before: { kind: "text", text: "before" },
      after: { kind: "text", text: `after ${id}` },
      fingerprint: id,
      patch: `diff ${id}`,
    })),
  };
}
function review(id = "snapshot", sessionId = "session"): Review {
  return {
    snapshot: snapshot(id, sessionId),
    state: emptyState(),
    history: [{ id, capturedAt: "" }],
  };
}
const proposal: Analysis = {
  cohorts: [
    {
      name: "Changes",
      explanation: "",
      layers: [{ name: "Read", explanation: "", fileIds: ["a", "b"] }],
    },
  ],
  findings: [],
};
const config: ProviderConfig = {
  provider: "ollama",
  endpoint: "http://localhost:11434",
  model: "fixture",
  contextWindow: 8192,
  maxOutput: 2048,
  localOnly: true,
};
function analysisFixture(
  get = async (): Promise<string | null> => null,
  provider = vi.fn(async () => proposal),
) {
  const store = new Store(directory());
  stores.push(store);
  store.create(snapshot());
  store.create(snapshot("other-snapshot", "other-session"));
  store.setSetting("provider", config);
  const analysis = new ReviewAnalysis(store, { get }, provider);
  const input = (sessionId = "session") => ({
    snapshotId: store.review(sessionId).snapshot.id,
    manifestId: analysis.manifest(sessionId).id,
    authorize: true,
  });
  return { store, analysis, provider, input };
}

describe("review analysis lifecycle", () => {
  it("reserves the app-wide slot during credentials and keeps it until canceled work settles", async () => {
    const token = deferred<string | null>();
    const { store, analysis, provider, input } = analysisFixture(
      () => token.promise,
    );
    const state = store.review("session").state;
    state.accepted = proposal;
    state.proposal = proposal;
    store.saveState("snapshot", state);
    const first = analysis.start("session", input());
    const canceled = expect(first).rejects.toThrow("canceled");
    await expect(
      analysis.start("other-session", input("other-session")),
    ).rejects.toThrow("One analysis");
    analysis.cancel("snapshot");
    expect(store.review("session").state.analysisStatus).toBe("canceled");
    await expect(
      analysis.start("other-session", input("other-session")),
    ).rejects.toThrow("One analysis");
    token.resolve(null);
    await canceled;
    expect(provider).not.toHaveBeenCalled();
    expect(store.review("session").state.accepted).toEqual(proposal);
    expect(store.review("session").state.proposal).toEqual(proposal);
    await analysis.start("other-session", input("other-session"));
    await vi.waitFor(() =>
      expect(store.review("other-session").state.analysisStatus).toBe("ready"),
    );
    await analysis.shutdown();
  });

  it("cancels on refresh and discards a late provider result while retaining accepted grouping", async () => {
    const result = deferred<Analysis>();
    const { store, analysis, input } = analysisFixture(
      undefined,
      vi.fn(() => result.promise),
    );
    const state = store.review("session").state;
    state.accepted = proposal;
    store.saveState("snapshot", state);
    await analysis.start("session", input());
    analysis.cancel("snapshot");
    store.refresh(snapshot("refreshed"));
    await expect(analysis.start("session", input())).rejects.toThrow(
      "One analysis",
    );
    result.resolve(proposal);
    await analysis.shutdown();
    expect(store.review("session", "snapshot").state).toMatchObject({
      accepted: proposal,
      proposal: null,
      analysisStatus: "canceled",
    });
    expect(store.review("session").state).toMatchObject({
      proposal: null,
      analysisStatus: "idle",
    });
  });

  it("rechecks snapshot and provider configuration after credentials, before sending data", async () => {
    for (const change of ["snapshot", "provider"]) {
      const token = deferred<string | null>();
      const { store, analysis, provider, input } = analysisFixture(
        () => token.promise,
      );
      const started = analysis.start("session", input());
      const rejected = expect(started).rejects.toThrow(
        change === "snapshot" ? "Snapshot changed" : "configuration",
      );
      if (change === "snapshot") store.refresh(snapshot("refreshed"));
      else store.setSetting("provider", { ...config, model: "new model" });
      token.resolve(null);
      await rejected;
      expect(provider).not.toHaveBeenCalled();
      expect(store.review("session", "snapshot").state.analysisStatus).toBe(
        change === "snapshot" ? "canceled" : "failed",
      );
      await analysis.shutdown();
    }
  });

  it("preserves intervening human edits when invalid provider output fails", async () => {
    const result = deferred<Analysis>();
    const { store, analysis, input } = analysisFixture(
      undefined,
      vi.fn(() => result.promise),
    );
    await analysis.start("session", input());
    const state = store.review("session").state;
    state.accepted = proposal;
    state.reviewed = ["a"];
    store.saveState("snapshot", state);
    result.resolve({ ...proposal, cohorts: [] });
    await vi.waitFor(() =>
      expect(store.review("session").state.analysisStatus).toBe("failed"),
    );
    expect(store.review("session").state).toMatchObject({
      accepted: proposal,
      reviewed: ["a"],
      proposal: null,
    });
    await analysis.shutdown();
  });

  it("shutdown waits for outstanding credentials and rejects new admission", async () => {
    const token = deferred<string | null>();
    const { analysis, provider, input } = analysisFixture(() => token.promise);
    const started = analysis.start("session", input());
    const rejected = expect(started).rejects.toThrow("canceled");
    let settled = false;
    const shutdown = analysis.shutdown().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(
      analysis.start("other-session", input("other-session")),
    ).rejects.toThrow("shutting down");
    token.resolve(null);
    await rejected;
    await shutdown;
    expect(provider).not.toHaveBeenCalled();
  });
});

function navigationFixture() {
  const requests: {
    route: string;
    body: unknown;
    method?: string;
    response: ReturnType<typeof deferred<unknown>>;
  }[] = [];
  const request: typeof api = <T>(
    route: string,
    body?: unknown,
    method?: string,
  ) => {
    const response = deferred<unknown>();
    requests.push({ route, body, method, response });
    return response.promise as Promise<T>;
  };
  const navigation = new ReviewNavigation(request);
  async function load(value = review()) {
    const loading = navigation.navigate(
      value.snapshot.sessionId,
      value.snapshot.id,
    );
    requests.at(-1)!.response.resolve(value);
    await loading;
  }
  return { navigation, requests, load };
}

describe("snapshot navigation", () => {
  it("rejects a late poll as soon as historical navigation begins, even if navigation fails", async () => {
    const { navigation, requests, load } = navigationFixture();
    await load();
    navigation.setAnchor({ fileId: "a", side: "after", line: 1 });
    navigation.setComment("unsaved");
    const polling = navigation.poll();
    const latePoll = requests.at(-1)!;
    const loading = navigation.navigate("session", "history");
    const failed = expect(loading).rejects.toThrow("missing");
    expect(navigation.getSnapshot()).toMatchObject({
      anchor: null,
      comment: "",
      navigating: true,
    });
    latePoll.response.resolve({
      ...review(),
      state: { ...emptyState(), reviewed: ["a"] },
    });
    await polling;
    expect(navigation.getSnapshot().review?.state.reviewed).toEqual([]);
    requests.at(-1)!.response.reject(new Error("missing"));
    await failed;
    expect(navigation.getSnapshot().navigating).toBe(false);
  });

  it("keeps the latest selection when rapid session navigation returns out of order", async () => {
    const { navigation, requests } = navigationFixture();
    const first = navigation.navigate("first");
    const second = navigation.navigate("second");
    requests[1].response.resolve(review("two", "second"));
    expect(await second).toBe(true);
    requests[0].response.resolve(review("one", "first"));
    expect(await first).toBe(false);
    expect(navigation.getSnapshot().review?.snapshot.sessionId).toBe("second");
  });

  it("discards mutation completion and errors after switching snapshots", async () => {
    for (const fail of [false, true]) {
      const { navigation, requests, load } = navigationFixture();
      await load();
      const mutation = navigation.mutate(
        "progress",
        { fileIds: ["a"], reviewed: true },
        { advance: true },
      );
      const pending = requests.at(-1)!;
      await load(review("history"));
      navigation.setComment("new draft");
      if (fail) pending.response.reject(new Error("stale error"));
      else
        pending.response.resolve({
          ...review(),
          state: { ...emptyState(), reviewed: ["a"] },
        });
      expect(await mutation).toBe(false);
      expect(navigation.getSnapshot()).toMatchObject({
        selected: "a",
        comment: "new draft",
        review: { snapshot: { id: "history" } },
      });
    }
  });

  it("prevents a pre-mutation poll from reverting progress and advances only unchanged selection", async () => {
    const { navigation, requests, load } = navigationFixture();
    await load();
    const polling = navigation.poll(),
      oldPoll = requests.at(-1)!;
    const mutation = navigation.mutate(
      "progress",
      { fileIds: ["a"], reviewed: true },
      { advance: true },
    );
    requests.at(-1)!.response.resolve({
      ...review(),
      state: { ...emptyState(), reviewed: ["a"] },
    });
    await mutation;
    oldPoll.response.resolve(review());
    await polling;
    expect(navigation.getSnapshot()).toMatchObject({
      selected: "b",
      review: { state: { reviewed: ["a"] } },
    });
  });

  it("clears unsaved anchors on file selection and refresh, and binds writes to the selected snapshot", async () => {
    const { navigation, requests, load } = navigationFixture();
    await load();
    navigation.setAnchor({ fileId: "a", side: "after", line: 1 });
    navigation.setComment("unsaved");
    navigation.selectFile("b");
    expect(navigation.getSnapshot()).toMatchObject({
      selected: "b",
      anchor: null,
      comment: "",
    });
    navigation.setComment("another draft");
    const refreshing = navigation.mutate("refresh", { snapshotId: "injected" });
    expect(requests.at(-1)!.body).toEqual({ snapshotId: "snapshot" });
    requests.at(-1)!.response.resolve(review("refreshed"));
    await refreshing;
    expect(navigation.getSnapshot()).toMatchObject({
      anchor: null,
      comment: "",
      selected: "b",
      review: { snapshot: { id: "refreshed" } },
    });
  });

  it("preserves a newly edited comment when saving an earlier draft finishes", async () => {
    const { navigation, requests, load } = navigationFixture();
    await load();
    navigation.setAnchor({ fileId: "a", side: "after", line: 1 });
    navigation.setComment("first comment");
    const saving = navigation.mutate(
      "drafts",
      { text: "first comment" },
      { clearComment: true },
    );
    navigation.selectFile("b");
    navigation.setAnchor({ fileId: "b", side: "after", line: 1 });
    navigation.setComment("second comment");
    requests.at(-1)!.response.resolve(review());
    await saving;
    expect(navigation.getSnapshot()).toMatchObject({
      selected: "b",
      comment: "second comment",
      anchor: { fileId: "b" },
    });
  });

  it("discards a manifest preview after navigation", async () => {
    const { navigation, requests, load } = navigationFixture();
    await load();
    const preview = navigation.previewAnalysis(),
      pending = requests.at(-1)!;
    await load(review("history"));
    pending.response.resolve({ snapshotId: "snapshot" });
    await preview;
    expect(navigation.getSnapshot().manifest).toBeNull();
  });

  it("owns polling lifetime and stops after analysis completes", async () => {
    vi.useFakeTimers();
    const { navigation, requests, load } = navigationFixture();
    const onError = vi.fn();
    const disconnect = navigation.connect(onError);
    await load({
      ...review(),
      state: { ...emptyState(), analysisStatus: "running" },
    });
    await vi.advanceTimersByTimeAsync(500);
    navigation.setComment("typing must not postpone polling");
    await vi.advanceTimersByTimeAsync(500);
    expect(requests.at(-1)!.route).toBe("/sessions/session?snapshot=snapshot");
    requests.at(-1)!.response.resolve({
      ...review(),
      state: { ...emptyState(), analysisStatus: "ready" },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
    disconnect();
  });

  it("discards a manifest preview that returns after refresh", async () => {
    const { navigation, requests, load } = navigationFixture();
    await load();
    const preview = navigation.previewAnalysis(),
      pending = requests.at(-1)!;
    const refreshing = navigation.mutate("refresh", {});
    requests.at(-1)!.response.resolve(review("refreshed"));
    await refreshing;
    pending.response.resolve({ snapshotId: "snapshot" });
    await preview;
    expect(navigation.getSnapshot().manifest).toBeNull();
  });
});

describe("captured artifact integrity", () => {
  it("reuses verified content and preserves corrupt content rather than repairing it", () => {
    const root = directory(),
      artifacts = new CapturedArtifacts(root);
    const digest = artifacts.write("captured text");
    expect(artifacts.write("captured text")).toBe(digest);
    expect(fs.readdirSync(root)).toEqual([digest]);
    expect(artifacts.read(digest)).toBe("captured text");
    fs.writeFileSync(path.join(root, digest), "tampered");
    expect(() => artifacts.read(digest)).toThrow("corrupt");
    expect(() => artifacts.write("captured text")).toThrow("corrupt");
    expect(fs.readFileSync(path.join(root, digest), "utf8")).toBe("tampered");
  });

  it("rejects invalid identities and reports missing content explicitly", () => {
    const artifacts = new CapturedArtifacts(directory());
    for (const digest of ["../outside", "", "A".repeat(64)])
      expect(() => artifacts.read(digest)).toThrow(
        "Invalid captured artifact identity",
      );
    expect(() => artifacts.read("0".repeat(64))).toThrow("missing");
  });

  it("cleans an incomplete atomic write without publishing the artifact", () => {
    const root = directory(),
      artifacts = new CapturedArtifacts(root);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });
    try {
      expect(() => artifacts.write("captured text")).toThrow("rename failed");
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });

  it("applies the same verified reads to snapshots and coverage without modifying persisted data", () => {
    const store = new Store(directory());
    stores.push(store);
    store.create(snapshot());
    const raw = "{}",
      metrics = measure(snapshot(), "istanbul", raw);
    store.saveCoverage(metrics, raw);
    const saved = store.db
      .prepare("SELECT data FROM snapshots WHERE id=?")
      .get("snapshot") as { data: string };
    const encoded = JSON.parse(saved.data);
    fs.writeFileSync(
      path.join(store.cache, encoded.files[0].after.hash),
      "tampered source",
    );
    expect(() => store.review("session")).toThrow("corrupt");
    const report = store.db
      .prepare("SELECT raw_hash FROM coverage_reports")
      .get() as { raw_hash: string };
    fs.rmSync(path.join(store.cache, report.raw_hash));
    expect(() => store.coverageArtifact("snapshot", "istanbul")).toThrow(
      "missing",
    );
    store.db
      .prepare("UPDATE coverage_reports SET raw_hash=?")
      .run("../outside");
    expect(() => store.coverageArtifact("snapshot", "istanbul")).toThrow(
      "Invalid captured artifact identity",
    );
    expect(
      store.db.prepare("SELECT data FROM snapshots WHERE id=?").get("snapshot"),
    ).toEqual(saved);
    expect(store.coverage("snapshot", "istanbul")).toEqual(metrics);
  });
});
