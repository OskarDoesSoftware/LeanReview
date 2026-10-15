import { expect, it, vi } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Store } from "../backend/src/storage/store";
import { ReviewAnalysis } from "../backend/src/review/runner";
import { snapshot, provider } from "./compatibility/capture";
import { analysisEstimate } from "../frontend/src/lib/analysis-progress";
import type { AnalysisProgress } from "../packages/contracts/src/index";

it("reports checked batches and estimates wait from actual completion times without resetting the run clock", async () => {
  await mkdir(".leanreview-test", { recursive: true });
  const store = new Store(
    await mkdtemp(path.resolve(".leanreview-test/progress-")),
  );
  let now = 100000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const fixture = snapshot();
  fixture.files = Array.from({ length: 49 }, (_, index) => ({
    ...fixture.files[0],
    id: `file-${index}`,
    path: `file-${index}.ts`,
    patch: "+export const value = 2;",
  }));
  store.create(fixture);
  store.setSetting("provider", provider);
  const releases: (() => void)[] = [];
  const analysis = new ReviewAnalysis(
    store,
    { get: async () => null },
    async (_config, _key, input, signal, progress) => {
      const batch = z
        .object({ files: z.array(z.object({ id: z.string() })) })
        .parse(input);
      progress?.("analyzing");
      await new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        signal.addEventListener("abort", () => reject(new Error("Canceled")), {
          once: true,
        });
      });
      return {
        cohorts: [
          {
            name: "Feature",
            explanation: "Related",
            layers: [
              {
                name: "Implementation",
                explanation: "Read",
                fileIds: batch.files.map((file) => file.id),
              },
            ],
          },
        ],
        findings: [],
      };
    },
  );
  try {
    const manifest = analysis.manifest(fixture.sessionId);
    await analysis.start(fixture.sessionId, {
      snapshotId: fixture.id,
      manifestId: manifest.id,
      authorize: true,
    });
    await vi.waitFor(() => expect(releases.length).toBe(1));
    const initial = store.review(fixture.sessionId).state.analysisProgress!;
    expect(initial).toMatchObject({
      phase: "analyzing",
      completedBatches: 0,
      completedFiles: 0,
      estimatedRemainingMs: null,
      startedAt: 100000,
    });
    expect(initial.totalBatches).toBeGreaterThan(1);
    now += 30000;
    releases[0]();
    await vi.waitFor(() => expect(releases.length).toBe(2));
    const next = store.review(fixture.sessionId).state.analysisProgress!;
    expect(next.completedBatches).toBe(1);
    expect(next.completedFiles).toBeGreaterThan(0);
    expect(next.currentFiles.length).toBeGreaterThan(0);
    expect(next.startedAt).toBe(100000);
    expect(next.estimatedRemainingMs).toBe(30000 * (next.totalBatches - 1));
    analysis.cancel(fixture.id);
    await analysis.shutdown();
    expect(store.review(fixture.sessionId).state.analysisStatus).toBe(
      "canceled",
    );
    expect(
      store.review(fixture.sessionId).state.analysisProgress?.completedBatches,
    ).toBe(1);
  } finally {
    await analysis.shutdown();
    clock.mockRestore();
    store.close();
  }
});

it("shows honest unknown and overdue estimates instead of a false zero countdown", () => {
  const progress: AnalysisProgress = {
    startedAt: 1000,
    updatedAt: 1000,
    phase: "analyzing",
    completedBatches: 0,
    totalBatches: 4,
    completedFiles: 0,
    totalFiles: 52,
    currentFiles: [],
    estimatedRemainingMs: null,
  };
  expect(analysisEstimate(progress, 2000)).toContain("first batch");
  progress.estimatedRemainingMs = 120000;
  expect(analysisEstimate(progress, 1000)).toBe("About 2–3 min remaining");
  expect(analysisEstimate(progress, 200000)).toContain(
    "Taking longer than estimated",
  );
  progress.phase = "combining";
  expect(analysisEstimate(progress, 200000)).toBe(
    "Finishing the combined proposal…",
  );
});
