import { expect, it } from "vitest";
import { checkPerformance } from "../scripts/check-java-performance";
const budgets = {
  files: 1000,
  repetitions: 3,
  limits: {
    startupMs: 10000,
    captureMs: 10000,
    coldScanMs: 10000,
    warmScanMs: 3000,
    apiP95Ms: 100,
    processTreeRssMiB: 1536,
  },
};
function report() {
  return {
    datasets: ["typescript", "java", "mixed"].map((kind) => ({
      kind,
      files: 1000,
      generatorVersion: 1,
      manifestSha256: kind,
      tree: kind,
      revision: kind,
      runs: [1, 2, 3].map((repetition) => ({
        repetition,
        startupMs: 7000,
        captureMs: 7000,
        processTreeMemory: {
          peakRssMiB: 900,
          samples: 100,
          maxNodeProcesses: 1,
        },
        scans: ["cold-artifact-cache", "warm-artifact-cache"].map((cache) => ({
          cache,
          elapsedMs: cache.startsWith("cold") ? 6000 : 2000,
          coverage: { complete: true, parserFailures: 0 },
          responsiveness: { samples: 100, p95Ms: 20 },
        })),
      })),
    })),
  };
}
it("requires every repetition, frozen dataset identity, complete scans, and parser-inclusive memory", () => {
  const data = report();
  expect(checkPerformance(data, report(), budgets)).toEqual([]);
  data.datasets[0].runs[2].scans[1].elapsedMs = 3001;
  data.datasets[1].runs[0].processTreeMemory.maxNodeProcesses = 0;
  data.datasets[2].manifestSha256 = "different";
  const failures = checkPerformance(data, report(), budgets);
  expect(failures).toHaveLength(3);
  expect(failures.join("\n")).toContain("warmScanMs");
  expect(failures.join("\n")).toContain("memory evidence");
  expect(failures.join("\n")).toContain("frozen baseline");
});
it("rejects a JVM-only historical report instead of calling memory accepted", () => {
  const data = report();
  delete (data.datasets[0].runs[0] as { processTreeMemory?: unknown })
    .processTreeMemory;
  expect(checkPerformance(data, report(), budgets).join("\n")).toContain(
    "memory evidence",
  );
});
