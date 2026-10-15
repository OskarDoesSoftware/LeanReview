import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureSnapshot } from "../backend/src/git/local.ts";
import { scanGraph } from "../backend/src/graph/scan.ts";
await mkdir(".leanreview-test", { recursive: true });
const root = path.resolve(".leanreview-test/scan-speed-fixture");
try {
  await access(path.join(root, ".git"));
} catch {
  await mkdir(root, { recursive: true });
  for (let i = 0; i < 20; i++)
    await writeFile(
      path.join(root, `file${i}.ts`),
      `import './file${(i + 1) % 20}';export const value${i}=${i};`,
    );
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe", windowsHide: true });
  git("init", "-b", "main");
  git("config", "user.name", "Performance fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-m", "fixture");
}
const snapshot = await captureSnapshot(
  root,
  { mode: "branch", base: "main" },
  "benchmark",
);
const started = performance.now();
const result = await scanGraph(snapshot, {
  side: "after",
  maxFiles: 10000,
  maxBytes: 20 * 1024 * 1024,
});
const elapsed = Math.round(performance.now() - started);
console.log(
  JSON.stringify({
    files: result.coverage.scanned,
    bytes: result.coverage.bytes,
    elapsedMs: elapsed,
    targetMs: 2000,
  }),
);
if (elapsed > 2000) process.exitCode = 1;
