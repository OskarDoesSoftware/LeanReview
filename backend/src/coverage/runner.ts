import { spawn } from "node:child_process";
import { access, readFile, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Snapshot } from "../../../packages/contracts/src/index";
import type {
  TestConfig,
  TestPreview,
  TestRun,
  CoverageProvenance,
} from "../../../packages/contracts/src/coverage";
import { Store } from "../storage/store";
import { containedFile, git, hash } from "../git/local";
import { measure } from "./metrics";
const configKey = (root: string, format: string) =>
  `coverage-test:${hash(root)}:${format}`;
type Prepared = {
  preview: TestPreview;
  snapshot: Snapshot;
  sourceHashes: Record<string, string>;
  previousReport: string | null;
  reportPath: string;
};
const environments = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "JAVA_HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "NVM_HOME",
  "NVM_SYMLINK",
];
export const testEnvironment = () =>
  Object.fromEntries(
    environments
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]!]),
  ) as NodeJS.ProcessEnv;
const redact = (text: string) =>
  text
    .replace(/(Bearer\s+)\S+/gi, "$1<REDACTED>")
    .replace(
      /((?:api[_-]?key|token|password|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      "$1<REDACTED>",
    );
async function safeReportPath(root: string, relative: string) {
  if (
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((x) => x === ".." || x === ".git") ||
    !/\.(json|xml)$/i.test(relative)
  )
    throw new Error(
      "Coverage report must be a repository-contained JSON/XML path.",
    );
  const target = path.resolve(root, relative);
  let parent = path.dirname(target);
  while (true) {
    try {
      await access(parent);
      break;
    } catch {
      const next = path.dirname(parent);
      if (next === parent) throw new Error("Report parent not found.");
      parent = next;
    }
  }
  await containedFile(root, path.relative(root, parent) || ".");
  try {
    await containedFile(root, relative);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}
async function reportIdentity(file: string) {
  try {
    const info = await stat(file, { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function checkoutHashes(snapshot: Snapshot) {
  const hashes: Record<string, string> = {};
  for (const file of snapshot.files) {
    if (file.after.kind !== "text") continue;
    const target = await containedFile(snapshot.root, file.path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await readFile(target),
    );
    if (text !== file.after.text)
      throw new Error(
        `Working source differs from snapshot: ${file.path}. Refresh or use a matching checkout.`,
      );
    hashes[file.path] = hash(text);
  }
  let head: string | null = null;
  try {
    head = (await git(snapshot.root, ["rev-parse", "--verify", "HEAD"]))
      .toString()
      .trim();
  } catch {
    /* Unborn HEAD. */
  }
  if (head !== snapshot.head)
    throw new Error(
      "Checkout HEAD differs from the captured snapshot. Refresh first.",
    );
  return hashes;
}
function killTree(pid: number) {
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    return new Promise<void>((resolve) => {
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
      resolve();
    }, 500);
    timer.unref();
  });
}
export class CoverageRunner {
  private previews = new Map<string, Prepared>();
  private jobs = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  constructor(private store: Store) {}
  config(root: string, format: string) {
    return this.store.setting<TestConfig>(configKey(root, format));
  }
  saveConfig(root: string, config: TestConfig) {
    this.store.setSetting(configKey(root, config.format), config);
  }
  async preview(snapshot: Snapshot): Promise<TestPreview> {
    // Kept for callers that choose the repository's explicit format.
    return this.prepare(
      snapshot,
      this.config(snapshot.root, "istanbul") ??
        this.config(snapshot.root, "jacoco"),
    );
  }
  async prepare(
    snapshot: Snapshot,
    config: TestConfig | null,
  ): Promise<TestPreview> {
    if (!config) throw new Error("Save a test/coverage configuration first.");
    const workingDirectory = await containedFile(snapshot.root, config.cwd);
    if (!(await stat(workingDirectory)).isDirectory())
      throw new Error("Test working directory must be a directory.");
    const reportPath = await safeReportPath(snapshot.root, config.reportPath);
    const sourceHashes = await checkoutHashes(snapshot);
    const preview: TestPreview = {
      id: randomUUID(),
      snapshotId: snapshot.id,
      config,
      root: snapshot.root,
      workingDirectory,
      sourceCount: Object.keys(sourceHashes).length,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
    for (const [id, p] of this.previews)
      if (Date.parse(p.preview.expiresAt) < Date.now())
        this.previews.delete(id);
    this.previews.set(preview.id, {
      preview,
      snapshot,
      sourceHashes,
      previousReport: await reportIdentity(reportPath),
      reportPath,
    });
    return preview;
  }
  async start(snapshot: Snapshot, previewId: string) {
    if (this.jobs.size)
      throw new Error("A test run is already active. Cancel or wait for it.");
    const prepared = this.previews.get(previewId);
    if (
      !prepared ||
      Date.parse(prepared.preview.expiresAt) < Date.now() ||
      prepared.snapshot.id !== snapshot.id ||
      JSON.stringify(
        this.config(snapshot.root, prepared.preview.config.format),
      ) !== JSON.stringify(prepared.preview.config)
    )
      throw new Error(
        "Test preview expired or configuration changed. Preview again.",
      );
    const hashes = await checkoutHashes(snapshot);
    if (
      JSON.stringify(hashes) !== JSON.stringify(prepared.sourceHashes) ||
      (await reportIdentity(prepared.reportPath)) !== prepared.previousReport
    )
      throw new Error("Source/report changed since preview. Preview again.");
    if (this.jobs.size)
      throw new Error("A test run is already active. Cancel or wait for it.");
    this.previews.delete(previewId);
    const run: TestRun = {
      id: randomUUID(),
      snapshotId: snapshot.id,
      config: prepared.preview.config,
      startedAt: new Date().toISOString(),
      status: "running",
      log: "",
    };
    this.store.saveTestRun(run);
    const controller = new AbortController();
    const done = this.execute(prepared, run, controller.signal);
    this.jobs.set(run.id, { controller, done });
    void done.finally(() => this.jobs.delete(run.id));
    return run;
  }
  private async execute(prepared: Prepared, run: TestRun, signal: AbortSignal) {
    const timeout = setTimeout(() => {
      const job = this.jobs.get(run.id);
      run.error = "Test run exceeded its configured timeout.";
      job?.controller.abort();
    }, run.config.timeoutSeconds * 1000);
    try {
      for (const [index, step] of run.config.steps.entries()) {
        if (signal.aborted) throw new Error("Test run canceled.");
        run.log =
          `${run.log}\nStep ${index + 1}/${run.config.steps.length}: ${step.executable}\n`.slice(
            -65536,
          );
        this.store.saveTestRun(run);
        await new Promise<void>((resolve, reject) => {
          const child = spawn(step.executable, step.args, {
            cwd: prepared.preview.workingDirectory,
            shell: step.shell,
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
            env: testEnvironment(),
          });
          let rawLog = run.log;
          let kill: Promise<void> | undefined;
          const append = (chunk: Buffer) => {
            rawLog = (rawLog + chunk.toString()).slice(-65536);
            run.log = redact(rawLog);
            this.store.saveTestRun(run);
          };
          child.stdout.on("data", append);
          child.stderr.on("data", append);
          const abort = () => {
            if (child.pid) kill = killTree(child.pid);
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          child.once("error", () => {
            signal.removeEventListener("abort", abort);
            reject(
              new Error(
                "Test executable could not start. Check prerequisites and executable path.",
              ),
            );
          });
          child.once("close", async (code) => {
            signal.removeEventListener("abort", abort);
            await kill;
            if (signal.aborted)
              reject(new Error(run.error ?? "Test run canceled."));
            else if (code !== 0)
              reject(
                new Error(
                  `Test step ${index + 1} exited with code ${code}. Previous measurements were preserved.`,
                ),
              );
            else resolve();
          });
        });
      }
      if (signal.aborted) throw new Error("Test run canceled.");
      const after = await checkoutHashes(prepared.snapshot);
      if (JSON.stringify(after) !== JSON.stringify(prepared.sourceHashes))
        throw new Error(
          "Source changed while tests ran; measurement discarded.",
        );
      const report = await containedFile(
        prepared.snapshot.root,
        run.config.reportPath,
      );
      if ((await reportIdentity(report)) === prepared.previousReport)
        throw new Error(
          "Coverage report was not regenerated. Existing reports are not accepted as a new measurement.",
        );
      const info = await stat(report);
      if (info.size > 20 * 1024 * 1024)
        throw new Error("Coverage report exceeds 20 MiB.");
      const raw = await readFile(report, "utf8");
      const provenance: CoverageProvenance = {
        version: 1,
        reportHash: hash(raw),
        sourceHashes: after,
        head: prepared.snapshot.head,
        capturedAt: new Date().toISOString(),
        tool: `LeanReview explicit ${run.config.format} test run`,
      };
      const metrics = measure(
        prepared.snapshot,
        run.config.format,
        raw,
        provenance,
        run.config.threshold,
      );
      // Store results first; sidecar export failure must not lose the measurement.
      this.store.saveCoverage(metrics, raw, provenance);
      run.metrics = metrics;
      run.provenance = provenance;
      const sidecar = report + ".leanreview.json",
        temporary = sidecar + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(provenance, null, 2), {
          mode: 0o600,
        });
        await rename(temporary, sidecar);
      } catch {
        run.log +=
          "\nSidecar export failed. Download the saved provenance from LeanReview instead.\n";
      }
      run.status = "succeeded";
    } catch (error) {
      run.status = signal.aborted && !run.error ? "canceled" : "failed";
      run.error =
        run.error ??
        (error instanceof Error ? error.message : "Test run failed.");
    } finally {
      clearTimeout(timeout);
      run.finishedAt = new Date().toISOString();
      this.store.saveTestRun(run);
    }
  }
  cancel(id: string) {
    this.jobs.get(id)?.controller.abort();
  }
  async shutdown() {
    const jobs = [...this.jobs.values()];
    jobs.forEach((job) => job.controller.abort());
    await Promise.all(jobs.map((job) => job.done));
  }
}
