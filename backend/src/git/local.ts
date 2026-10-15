import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type {
  Comparison,
  Content,
  FileChange,
  Snapshot,
} from "../../../packages/contracts/src/index";
const exec = promisify(execFile);
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export async function git(root: string, args: string[]) {
  return (
    await exec(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=",
        "-c",
        "diff.external=",
        ...args,
      ],
      {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    )
  ).stdout;
}
export async function selectRepository(input: string) {
  const root = await realpath(input);
  const top = (await git(root, ["rev-parse", "--show-toplevel"]))
    .toString()
    .trim();
  if ((await realpath(top)) !== root)
    throw new Error("Select the repository root, not a subdirectory.");
  return root;
}
export async function containedFile(root: string, relative: string) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes(".git")
  )
    throw new Error("Invalid repository path.");
  const target = await realpath(path.resolve(root, relative));
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("File resolves outside the selected repository.");
  return target;
}
function content(bytes: Buffer): Content {
  if (bytes.length > 2 * 1024 * 1024)
    return { kind: "oversized", reason: "Text display limit is 2 MiB." };
  if (bytes.includes(0)) return { kind: "binary" };
  try {
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { kind: "binary", reason: "Not UTF-8 text." };
  }
}
async function blob(
  root: string,
  spec: string | null,
): Promise<{ value: Content; digest: string }> {
  if (!spec) return { value: { kind: "absent" }, digest: "absent" };
  try {
    const bytes = await git(root, ["cat-file", "blob", spec]);
    return { value: content(bytes), digest: hash(bytes) };
  } catch {
    throw new Error(
      "Cannot read a captured Git blob. The repository may have changed.",
    );
  }
}
async function working(root: string, file: string) {
  try {
    const metadata = await lstat(path.join(root, file));
    if (metadata.isSymbolicLink() || !metadata.isFile())
      return {
        value: {
          kind: "unavailable",
          reason: "Symlink or non-regular file; not followed.",
        } as Content,
        digest: hash(String(metadata.size) + String(metadata.mtimeMs)),
      };
    const safe = await containedFile(root, file);
    if (metadata.size > 2 * 1024 * 1024)
      return {
        value: {
          kind: "oversized",
          reason: "Text display limit is 2 MiB.",
        } as Content,
        digest: hash(String(metadata.size) + String(metadata.mtimeMs)),
      };
    const bytes = await readFile(safe);
    return { value: content(bytes), digest: hash(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { value: { kind: "absent" } as Content, digest: "absent" };
    throw error;
  }
}
async function head(root: string) {
  try {
    return (await git(root, ["rev-parse", "--verify", "HEAD"]))
      .toString()
      .trim();
  } catch {
    return null;
  }
}
async function captureFiles(root: string, comparison: Comparison) {
  const headId = await head(root);
  let base: string | null = headId;
  let target: string | null = null;
  let args: string[] = [];
  if (comparison.mode === "branch") {
    if (!headId) throw new Error("Branch comparison requires a commit.");
    const baseCommit = (
      await git(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${comparison.base}^{commit}`,
      ])
    )
      .toString()
      .trim();
    base = (await git(root, ["merge-base", baseCommit, headId]))
      .toString()
      .trim();
    target = headId;
    args = [base, headId];
  } else if (comparison.mode === "staged")
    args = ["--cached", ...(headId ? [headId] : [])];
  else if (comparison.mode === "all") {
    if (headId) args = [headId];
    else base = null;
  }
  const raw = (
    await git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "-z",
      "--find-renames",
      ...args,
      "--",
    ])
  ).toString();
  const tokens = raw.split("\0");
  const entries: { code: string; oldPath: string; path: string }[] = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const code = tokens[i++];
    const oldPath = tokens[i++];
    entries.push({
      code,
      oldPath,
      path:
        code.startsWith("R") || code.startsWith("C") ? tokens[i++] : oldPath,
    });
  }
  if (comparison.mode === "all" && !headId) {
    for (const file of (await git(root, ["ls-files", "-z"]))
      .toString()
      .split("\0")
      .filter(Boolean)) {
      if (!entries.some((e) => e.path === file))
        entries.push({ code: "A", oldPath: file, path: file });
    }
    entries.forEach((e) => {
      e.code = "A";
    });
  }
  if (comparison.mode === "unstaged" || comparison.mode === "all") {
    for (const file of (
      await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    )
      .toString()
      .split("\0")
      .filter(Boolean)) {
      if (!entries.some((e) => e.path === file))
        entries.push({ code: "A", oldPath: file, path: file });
    }
  }
  const files: FileChange[] = [];
  for (const entry of entries) {
    if (!/^[AMDR]/.test(entry.code))
      throw new Error(
        `Unsupported Git change ${entry.code}; resolve conflicts or submodule changes first.`,
      );
    const status =
      entry.code[0] === "A"
        ? "added"
        : entry.code[0] === "D"
          ? "deleted"
          : entry.code[0] === "R"
            ? "renamed"
            : "modified";
    const oldSpec =
      status === "added"
        ? null
        : comparison.mode === "unstaged"
          ? `:${entry.oldPath}`
          : base
            ? `${base}:${entry.oldPath}`
            : null;
    const before = await blob(root, oldSpec);
    const after =
      status === "deleted"
        ? { value: { kind: "absent" } as Content, digest: "absent" }
        : comparison.mode === "staged"
          ? await blob(root, `:${entry.path}`)
          : target
            ? await blob(root, `${target}:${entry.path}`)
            : await working(root, entry.path);
    const fingerprint = hash(
      JSON.stringify([
        status,
        entry.oldPath,
        entry.path,
        before.digest,
        after.digest,
      ]),
    );
    const beforeText = before.value.kind === "text" ? before.value.text : "";
    const afterText = after.value.kind === "text" ? after.value.text : "";
    const textual =
      ["text", "absent"].includes(before.value.kind) &&
      ["text", "absent"].includes(after.value.kind);
    files.push({
      id: hash(`${entry.oldPath}\0${entry.path}`).slice(0, 24),
      oldPath: entry.oldPath,
      path: entry.path,
      status,
      fingerprint,
      before: before.value,
      after: after.value,
      patch: textual
        ? createTwoFilesPatch(entry.oldPath, entry.path, beforeText, afterText)
        : "",
    });
  }
  const inventory = async (revision: string | null, index = false) => {
    const raw = index
      ? await git(root, ["ls-files", "--stage", "-z"])
      : revision
        ? await git(root, ["ls-tree", "-r", "-z", revision])
        : Buffer.from("");
    const entries = raw
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const tab = record.indexOf("\t"),
          meta = record.slice(0, tab).split(" ");
        if (index && meta[2] !== "0")
          throw new Error("Resolve index conflicts before graph capture.");
        return {
          path: record.slice(tab + 1),
          mode: meta[0],
          oid: meta[index ? 1 : 2],
        };
      });
    return {
      revision: index ? "captured-index" : (revision ?? "empty"),
      complete: entries.length <= 100000,
      entries: entries.slice(0, 100000),
    };
  };
  const before = await inventory(base, comparison.mode === "unstaged");
  const after =
    comparison.mode === "staged" || comparison.mode === "unstaged"
      ? await inventory(null, true)
      : await inventory(target ?? headId);
  return { files, head: headId, base, graphContext: { before, after } };
}
export async function captureSnapshot(
  root: string,
  comparison: Comparison,
  sessionId: string,
): Promise<Snapshot> {
  const first = await captureFiles(root, comparison);
  const second = await captureFiles(root, comparison);
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error(
      "Repository changed during capture. Retry when changes settle.",
    );
  return {
    ...first,
    root,
    comparison,
    sessionId,
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    complete: true,
  };
}
