import { it, expect } from "vitest";
import { analysisEstimate } from "../frontend/src/lib/analysis-progress";
import type { AnalysisProgress } from "../packages/contracts/src/index";
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
