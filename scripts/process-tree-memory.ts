import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type ProcessSample = {
  pid: number;
  parent: number;
  rss: number;
  name: string;
};

/** Sum resident memory for the root and its currently visible descendants. */
export function treeSample(root: number, rows: ProcessSample[]) {
  const owned = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }
  const processes = rows.filter((row) => owned.has(row.pid));
  return {
    rssBytes: processes.reduce((sum, row) => sum + row.rss, 0),
    processes: processes.length,
    nodeProcesses: processes.filter((row) => /^node(?:\.exe)?$/i.test(row.name))
      .length,
    gitProcesses: processes.filter((row) => /^git(?:\.exe)?$/i.test(row.name))
      .length,
  };
}

export function monitorTree(root: number) {
  let samples = 0,
    peakRssBytes = 0,
    maxProcesses = 0,
    maxNodeProcesses = 0,
    maxGitProcesses = 0;
  let error: Error | undefined;
  let stopping = false;
  let pending = "";
  const windows = process.platform === "win32";
  const child = windows
    ? spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          fileURLToPath(new URL("./process-tree-memory.ps1", import.meta.url)),
          String(root),
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      )
    : spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./process-tree-memory-unix.mjs", import.meta.url),
          ),
          String(root),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
  child.stderr.resume();
  child.on("error", (failure) => {
    error = failure;
  });
  child.once("exit", () => {
    if (!stopping)
      error = new Error("Process-tree memory sampler exited unexpectedly.");
  });
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      try {
        const rows: ProcessSample[] = JSON.parse(line);
        if (
          !Array.isArray(rows) ||
          rows.some(
            (row) =>
              !Number.isSafeInteger(row.pid) ||
              !Number.isSafeInteger(row.parent) ||
              !Number.isFinite(row.rss) ||
              row.rss < 0 ||
              typeof row.name !== "string",
          )
        )
          throw Error();
        if (!rows.some((row) => row.pid === root)) continue;
        const sample = treeSample(root, rows);
        samples++;
        peakRssBytes = Math.max(peakRssBytes, sample.rssBytes);
        maxProcesses = Math.max(maxProcesses, sample.processes);
        maxNodeProcesses = Math.max(maxNodeProcesses, sample.nodeProcesses);
        maxGitProcesses = Math.max(maxGitProcesses, sample.gitProcesses);
      } catch {
        error = new Error("Invalid process-tree memory sample.");
      }
    }
  });
  return {
    async stop() {
      stopping = true;
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) =>
          child.once("close", () => resolve()),
        );
        if (windows) child.kill();
        else child.stdin.end();
        const timer = setTimeout(() => child.kill(), 5000);
        await exited;
        clearTimeout(timer);
      }
      if (error)
        throw new Error("Process-tree memory measurement failed.", {
          cause: error,
        });
      if (!samples)
        throw new Error("No process-tree memory samples were collected.");
      return {
        peakRssMiB: Math.round((peakRssBytes / 1024 ** 2) * 100) / 100,
        samples,
        maxProcesses,
        maxNodeProcesses,
        maxGitProcesses,
        intervalMs: 200,
        method: windows
          ? "Toolhelp32 descendants / WorkingSet64 sum"
          : "ps resident-set sum",
      };
    },
  };
}
