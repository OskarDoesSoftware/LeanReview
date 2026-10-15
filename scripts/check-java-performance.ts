import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

type Budgets = {
  files: number;
  repetitions: number;
  limits: Record<string, number>;
};
type Scan = {
  cache: string;
  elapsedMs: number;
  coverage: { complete: boolean; parserFailures: number };
  responsiveness: { samples: number; p95Ms: number };
};
type Run = {
  repetition: number;
  startupMs: number;
  captureMs: number;
  scans: Scan[];
  processTreeMemory?: {
    peakRssMiB: number;
    samples: number;
    maxNodeProcesses: number;
  };
};
type Dataset = {
  kind: string;
  files: number;
  generatorVersion: number;
  manifestSha256: string;
  tree: string;
  revision: string;
  runs: Run[];
};
export function checkPerformance(
  report: { datasets: Dataset[] },
  baseline: { datasets: Dataset[] },
  budgets: Budgets,
) {
  const failures: string[] = [];
  const datasets = report.datasets ?? [];
  for (const kind of ["typescript", "java", "mixed"]) {
    const matches = datasets.filter((dataset) => dataset.kind === kind);
    const reference = baseline.datasets.find(
      (dataset) => dataset.kind === kind,
    );
    if (matches.length !== 1 || !reference) {
      failures.push(`${kind}: missing or duplicate dataset`);
      continue;
    }
    const dataset = matches[0];
    if (
      dataset.files !== budgets.files ||
      ["generatorVersion", "manifestSha256", "tree", "revision"].some(
        (key) =>
          dataset[key as keyof Dataset] !== reference[key as keyof Dataset],
      )
    )
      failures.push(`${kind}: dataset does not match the frozen baseline`);
    if (
      dataset.runs.length !== budgets.repetitions ||
      new Set(dataset.runs.map((run) => run.repetition)).size !==
        budgets.repetitions
    )
      failures.push(`${kind}: expected ${budgets.repetitions} distinct runs`);
    for (const run of dataset.runs) {
      const label = `${kind} run ${run.repetition}`;
      const values: Record<string, number | undefined> = {
        startupMs: run.startupMs,
        captureMs: run.captureMs,
        processTreeRssMiB: run.processTreeMemory?.peakRssMiB,
      };
      if (
        !run.processTreeMemory ||
        !(run.processTreeMemory.samples >= 1) ||
        !(run.processTreeMemory.maxNodeProcesses >= 1)
      )
        failures.push(`${label}: missing process-tree/parser memory evidence`);
      for (const [cache, key] of [
        ["cold-artifact-cache", "coldScanMs"],
        ["warm-artifact-cache", "warmScanMs"],
      ]) {
        const scans = run.scans.filter((scan) => scan.cache === cache);
        if (scans.length !== 1) {
          failures.push(`${label}: missing or duplicate ${cache} scan`);
          continue;
        }
        const scan = scans[0];
        values[key] = scan.elapsedMs;
        if (
          scan.coverage.complete !== true ||
          scan.coverage.parserFailures !== 0
        )
          failures.push(`${label}: incomplete ${cache} extraction`);
        if (
          !(scan.responsiveness.samples >= 1) ||
          !Number.isFinite(scan.responsiveness.p95Ms) ||
          scan.responsiveness.p95Ms < 0 ||
          scan.responsiveness.p95Ms > budgets.limits.apiP95Ms
        )
          failures.push(
            `${label}: ${cache} API p95 exceeds budget or is unavailable`,
          );
      }
      for (const [key, value] of Object.entries(values))
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > budgets.limits[key]
        )
          failures.push(
            `${label}: ${key} ${value ?? "unavailable"} exceeds ${budgets.limits[key]} or is invalid`,
          );
    }
  }
  if (datasets.length !== 3) failures.push("Expected exactly three datasets");
  return failures;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [report, baseline, budgets] = await Promise.all(
    [
      process.argv[2] || "docs/migration/java-process-tree-baseline.json",
      "docs/migration/backend-baseline.json",
      "docs/migration/java-performance-budgets.json",
    ].map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))),
  );
  const failures = checkPerformance(report, baseline, budgets);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "Java performance acceptance passed all agreed ceilings for every dataset and run.",
    );
}
