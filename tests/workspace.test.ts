import { afterEach, expect, it, vi } from "vitest";
import {
  restoreWorkspace,
  rememberWorkspace,
} from "../frontend/src/lib/workspace";
import { ReviewNavigation } from "../frontend/src/lib/review-navigation";
import { api } from "../frontend/src/lib/api";
import { changeTarget } from "../frontend/src/lib/change-navigation";
import type { Review, SessionSummary } from "../packages/contracts/src/index";
const review: Review = {
  snapshot: {
    id: "snapshot",
    sessionId: "session",
    root: "repo",
    head: null,
    base: null,
    comparison: { mode: "staged", base: "main" },
    complete: true,
    capturedAt: "2026-10-15",
    files: ["a", "b"].map((id) => ({
      id,
      path: id,
      oldPath: id,
      status: "modified",
      before: { kind: "absent" },
      after: { kind: "text", text: id },
      fingerprint: id,
      patch: "",
    })),
  },
  history: [{ id: "snapshot", capturedAt: "2026-10-15" }],
  state: {
    reviewed: [],
    drafts: [],
    accepted: null,
    proposal: null,
    analysisStatus: "idle",
  },
};
const sessions: SessionSummary[] = [
  { id: "session", name: "Repo", root: "repo", updatedAt: "2026-10-15" },
];
afterEach(() => vi.unstubAllGlobals());
it("restores the remembered snapshot and file through saved database review APIs", async () => {
  const getItem = vi.fn(() =>
    JSON.stringify({ sessionId: "session", snapshotId: "old", fileId: "b" }),
  );
  vi.stubGlobal("localStorage", { getItem });
  const request = vi.fn<typeof api>().mockResolvedValue(review);
  const nav = new ReviewNavigation(
    async <T>(...args: Parameters<typeof api>) => (await request(...args)) as T,
  );
  await restoreWorkspace(sessions, nav);
  expect(request).toHaveBeenCalledWith(
    "/sessions/session?snapshot=old",
    undefined,
  );
  expect(nav.getSnapshot().selected).toBe("b");
});
it("falls back to latest snapshot when the remembered snapshot is gone", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({ sessionId: "session", snapshotId: "gone", fileId: "b" }),
  });
  const request = vi
    .fn<typeof api>()
    .mockRejectedValueOnce(new Error("Snapshot not found"))
    .mockResolvedValue(review);
  const nav = new ReviewNavigation(
    async <T>(...args: Parameters<typeof api>) => (await request(...args)) as T,
  );
  await restoreWorkspace(sessions, nav);
  expect(request).toHaveBeenLastCalledWith("/sessions/session", undefined);
  expect(nav.getSnapshot().selected).toBe("b");
});
it("opens the latest database review when browser preferences are unavailable", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Denied");
    },
    setItem: () => {
      throw new Error("Denied");
    },
  });
  const request = vi.fn<typeof api>().mockResolvedValue(review);
  const nav = new ReviewNavigation(
    async <T>(...args: Parameters<typeof api>) => (await request(...args)) as T,
  );
  await restoreWorkspace(sessions, nav);
  expect(request).toHaveBeenCalledWith("/sessions/session", undefined);
  expect(() =>
    rememberWorkspace({
      sessionId: "session",
      snapshotId: "snapshot",
      fileId: "b",
    }),
  ).not.toThrow();
});
it("ignores missing sessions and malformed preferences", async () => {
  const request = vi.fn<typeof api>().mockResolvedValue(review);
  const nav = new ReviewNavigation(
    async <T>(...args: Parameters<typeof api>) => (await request(...args)) as T,
  );
  vi.stubGlobal("localStorage", { getItem: () => "{bad json" });
  await restoreWorkspace(sessions, nav);
  expect(request).toHaveBeenCalledWith("/sessions/session", undefined);
  request.mockClear();
  await restoreWorkspace([], nav);
  expect(request).not.toHaveBeenCalled();
});
it("crosses file boundaries without wrapping and honors cohort order", () => {
  expect(changeTarget(review, "a", [10, 90], 90, "next")).toEqual({
    fileId: "b",
    line: null,
  });
  expect(changeTarget(review, "a", [10, 90], 10, "previous")).toBeNull();
  expect(changeTarget(review, "b", [], 1, "next")).toBeNull();
  const grouped: Review = {
    ...review,
    state: {
      ...review.state,
      accepted: {
        cohorts: [
          {
            name: "Group",
            explanation: "",
            layers: [{ name: "Layer", explanation: "", fileIds: ["b", "a"] }],
          },
        ],
        findings: [],
      },
    },
  };
  expect(changeTarget(grouped, "a", [10], 10, "previous")).toEqual({
    fileId: "b",
    line: null,
  });
  expect(changeTarget(grouped, "a", [10, 90], 10, "next")).toEqual({
    fileId: "a",
    line: 90,
  });
});
