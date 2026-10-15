import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function dataset(kind: string, count: number) {
  const root = await fs.mkdtemp(
    path.resolve(`.leanreview-test/baseline-${kind}-`),
  );
  const manifest: { path: string; sha256: string; bytes: number }[] = [];
  const padding =
    "// deterministic source padding for repository scan baseline\n".repeat(20);
  for (let i = 0; i < count; i++) {
    const java = kind === "java" || (kind === "mixed" && i % 2 === 1);
    const next = (i + (kind === "mixed" ? 2 : 1)) % count;
    const name = java ? `Type${i}.java` : `module${i}.ts`;
    const text = java
      ? `package baseline;\nimport java.util.List;\npublic class Type${i} { Type${next} next; List<String> names;\n${Array.from({ length: 8 }, (_, j) => `public int choose${j}(int x) { if (x > ${j}) return x; return ${j}; }`).join("\n")}\n}\n${padding}`
      : `import { value as next } from './module${next}';\nexport const value = ${i};\n${Array.from({ length: 8 }, (_, j) => `export function choose${j}(x: number) { if (x > ${j}) return next; return ${j}; }`).join("\n")}\n${padding}`;
    await fs.writeFile(path.join(root, name), text);
    manifest.push({
      path: name,
      sha256: hash(text),
      bytes: Buffer.byteLength(text),
    });
  }
  const emptyConfig = path.resolve(".leanreview-test/baseline-empty-gitconfig");
  await fs.writeFile(emptyConfig, "");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_AUTHOR_DATE: "2026-10-15T10:00:00Z",
        GIT_COMMITTER_DATE: "2026-10-15T10:00:00Z",
      },
    })
      .toString()
      .trim();
  git("init", "-b", "main");
  git("config", "user.name", "Synthetic baseline");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git(
    "-c",
    "core.hooksPath=",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Deterministic baseline dataset",
  );
  return {
    root,
    identity: {
      kind,
      generatorVersion: 1,
      files: count,
      bytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
      manifestSha256: hash(JSON.stringify(manifest)),
      tree: git("rev-parse", "HEAD^{tree}"),
      revision: git("rev-parse", "HEAD"),
    },
  };
}
