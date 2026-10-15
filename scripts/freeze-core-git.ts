import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureSnapshot } from "../backend/src/git/local";
import { Store } from "../backend/src/storage/store";

if (!process.argv.includes("--write")) throw new Error("Use --write to deliberately freeze the Node Git contract.");
await fs.mkdir(".leanreview-test", { recursive: true });
const scratch = await fs.mkdtemp(path.resolve(".leanreview-test/core-git-"));
const store = new Store(path.join(scratch, "data"));
const emptyConfig = path.join(scratch, "empty-gitconfig");
await fs.writeFile(emptyConfig, "");
const environment = { GIT_AUTHOR_DATE: "2026-10-15T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-15T10:00:00Z", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig };
type Operation = { op: "write"; path: string; text?: string; base64?: string; repeat?: number; mtimeMillis?: number } | { op: "git"; args: string[] } | { op: "capture"; name: string; mode: "all" | "staged" | "unstaged" | "branch"; expected?: unknown };
const git = (...args: string[]): Operation => ({ op: "git", args });
const write = (name: string, text: string): Operation => ({ op: "write", path: name, text });
const capture = (name: string, mode: "all" | "staged" | "unstaged" | "branch"): Operation => ({ op: "capture", name, mode });
const initial = [git("init", "--object-format=sha1", "-b", "main"), git("config", "user.name", "Core fixture"), git("config", "user.email", "fixture@example.invalid")];
const scenarios: { name: string; operations: Operation[] }[] = [
  { name: "index-working-branch", operations: [
    ...initial,
    write("src/choose.ts", "export function choose(x: number) {\n  return x;\n}\n"),
    write("old name.ts", "export const renamed = 1;\n"),
    write("deleted.ts", "export const removed = 1;\n"),
    write("endings.ts", "export const ending = 1;\n"),
    write("large.dat", "small\n"),
    { op: "write", path: "binary.dat", base64: "AAEC" },
    git("add", "."), git("commit", "-m", "base"), git("checkout", "-b", "feature"),
    write("src/choose.ts", "export function choose(x: number) {\n  if (x > 0) return x;\n  return 0;\n}\n"),
    git("mv", "old name.ts", "new name.ts"), git("rm", "deleted.ts"),
    write("added.ts", "export const added = true;"),
    write("endings.ts", "export const ending = 1;"),
    { op: "write", path: "large.dat", repeat: 2097153, mtimeMillis: 1792058400123 },
    { op: "write", path: "binary.dat", base64: "AAED" },
    git("add", "."),
    write("src/choose.ts", "export function choose(x: number) {\n  if (x > 0) return x;\n  return 0;\n}\n// working change\n"),
    write("café.ts", "export const café = '😀';\r\n"),
    capture("all changes", "all"), capture("index only", "staged"), capture("working versus index", "unstaged"),
    git("commit", "-m", "feature"), capture("merge-base branch", "branch"),
  ] },
  { name: "unborn", operations: [...initial, write("staged.ts", "export const staged = 1;\n"), git("add", "."), write("staged.ts", "export const staged = 2;\n"), write("new.ts", "export const fresh = true;\n"), capture("unborn all", "all"), capture("unborn index", "staged"), capture("unborn working", "unstaged")] },
];

function normalize(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (key === "root") return "<repository>";
    if (key.endsWith("At")) return "<timestamp>";
    if (key === "sessionId") return "<session>";
    if (key === "id" && /^[a-f0-9-]{36}$/.test(value)) return "<snapshot>";
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
  return value;
}
try {
  for (const scenario of scenarios) {
    const root = path.join(scratch, scenario.name);
    await fs.mkdir(root, { recursive: true });
    for (const operation of scenario.operations) {
      if (operation.op === "git") execFileSync("git", ["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...operation.args], { cwd: root, windowsHide: true, stdio: "pipe", env: { ...process.env, ...environment } });
      if (operation.op === "write") {
        const file = path.join(root, operation.path);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, operation.repeat ? "x".repeat(operation.repeat) : operation.base64 ? Buffer.from(operation.base64, "base64") : operation.text!);
        if (operation.mtimeMillis) await fs.utimes(file, operation.mtimeMillis / 1000, operation.mtimeMillis / 1000);
      }
      if (operation.op === "capture") {
        const snapshot = await captureSnapshot(root, { mode: operation.mode, base: "main" }, crypto.randomUUID());
        operation.expected = normalize(store.create(snapshot));
      }
    }
  }
  await fs.mkdir("tests/fixtures", { recursive: true });
  await fs.writeFile("tests/fixtures/core-git.json", JSON.stringify({ version: 1, date: "2026-10-15", gitEnvironment: { GIT_AUTHOR_DATE: environment.GIT_AUTHOR_DATE, GIT_COMMITTER_DATE: environment.GIT_COMMITTER_DATE }, scenarios }, null, 2) + "\n");
  console.log("Frozen seven Node Git/API captures in tests/fixtures/core-git.json");
} finally { store.close(); }
