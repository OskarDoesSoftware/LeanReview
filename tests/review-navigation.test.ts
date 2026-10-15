import { describe, it, expect, vi } from "vitest";
import { ReviewNavigation } from "../frontend/src/lib/review-navigation";
import type { api } from "../frontend/src/lib/api";
import {
  emptyState,
  type Review,
  type Snapshot,
  type Analysis,
} from "../packages/contracts/src/index";
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
