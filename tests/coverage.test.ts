import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  stat,
  readdir,
} from "node:fs/promises";
import Database from "better-sqlite3";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Store } from "../backend/src/storage/store";
import { captureSnapshot, hash } from "../backend/src/git/local";
import { crapScore, measure } from "../backend/src/coverage/metrics";
import { functionUnits } from "../backend/src/coverage/typescript";
import {
  CoverageRunner,
  testEnvironment,
} from "../backend/src/coverage/runner";
import type { Snapshot } from "../packages/contracts/src/index";
import type {
  CoverageProvenance,
  TestConfig,
  TestRun,
} from "../packages/contracts/src/coverage";
const stores: Store[] = [];
const runners: CoverageRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.shutdown()));
  stores.splice(0).forEach((s) => s.close());
});
async function temp() {
  await mkdir(".leanreview-test", { recursive: true });
  return mkdtemp(path.resolve(".leanreview-test/crap-"));
}
function snapshot(file: string, text: string): Snapshot {
  return {
    id: "snapshot",
    sessionId: "session",
    root: "C:/fixture",
    head: "commit",
    base: "base",
    capturedAt: "",
    comparison: { mode: "all", base: "main" },
    complete: true,
    files: [
      {
        id: "file",
        path: file,
        oldPath: file,
        status: "modified",
        fingerprint: "fp",
        patch: "",
        before: { kind: "text", text: "" },
        after: { kind: "text", text },
      },
    ],
  };
}
function provenance(s: Snapshot, report: string): CoverageProvenance {
  return {
    version: 1,
    reportHash: hash(report),
    head: s.head,
    capturedAt: new Date().toISOString(),
    tool: "Fixture",
    sourceHashes: Object.fromEntries(
      s.files
        .filter((f) => f.after.kind === "text")
        .map((f) => [f.path, hash((f.after as { text: string }).text)]),
    ),
  };
}
const source =
  "export function choose(x: number) {\n  if (x > 0) return 1;\n  return 0;\n}\n";
function istanbul(file = "src/choose.ts", hits = [1, 1, 0]) {
  return JSON.stringify({
    [file]: {
      path: file,
      statementMap: {
        0: { start: { line: 2, column: 2 }, end: { line: 2, column: 22 } },
        1: { start: { line: 2, column: 13 }, end: { line: 2, column: 22 } },
        2: { start: { line: 3, column: 2 }, end: { line: 3, column: 11 } },
      },
      s: { 0: hits[0], 1: hits[1], 2: hits[2] },
    },
  });
}
describe("measured CRAP semantics", () => {
  it("uses fractional coverage and remains unbounded", () => {
    expect(crapScore(10, 0)).toBe(110);
    expect(crapScore(10, 0.5)).toBe(22.5);
    expect(crapScore(10, 1)).toBe(10);
    expect(() => crapScore(3, 50)).toThrow();
  });
  it("requires matching report, source and revision fingerprints", () => {
    const s = snapshot("src/choose.ts", source),
      raw = istanbul(),
      p = provenance(s, raw);
    expect(
      measure(s, "istanbul", raw, p).files[0].functions[0].crap,
    ).toBeCloseTo(crapScore(2, 2 / 3));
    for (const bad of [
      undefined,
      { ...p, reportHash: "a".repeat(64) },
      { ...p, head: "other" },
      { ...p, sourceHashes: { "src/choose.ts": "b".repeat(64) } },
    ])
      expect(measure(s, "istanbul", raw, bad).highest).toBeNull();
    expect(measure(s, "istanbul").files[0].functions[0].complexity).toBe(2);
  });
  it("distinguishes observed zero from missing and empty denominators", () => {
    const s = snapshot("src/choose.ts", source),
      zero = istanbul("src/choose.ts", [0, 0, 0]);
    expect(measure(s, "istanbul", zero, provenance(s, zero)).highest).toBe(6);
    const empty = JSON.stringify({
      "src/choose.ts": { statementMap: {}, s: {} },
    });
    expect(
      measure(s, "istanbul", empty, provenance(s, empty)).highest,
    ).toBeNull();
  });
  it("keeps nested-function statements out of parent coverage", () => {
    const text =
      "function outer(x: boolean) {\n  function inner() {\n    return 2;\n  }\n  if (x) return 1;\n  return 0;\n}\n";
    const s = snapshot("nested.ts", text);
    const raw = JSON.stringify({
      "nested.ts": {
        statementMap: {
          0: { start: { line: 3, column: 4 }, end: { line: 3, column: 13 } },
          1: { start: { line: 5, column: 2 }, end: { line: 5, column: 18 } },
          2: { start: { line: 6, column: 2 }, end: { line: 6, column: 11 } },
        },
        s: { 0: 0, 1: 1, 2: 1 },
      },
    });
    const functions = measure(s, "istanbul", raw, provenance(s, raw)).files[0]
      .functions;
    expect(functions.find((f) => f.name === "outer")?.coverage).toBe(1);
    expect(functions.find((f) => f.name === "inner")?.coverage).toBe(0);
  });
  it("supports TSX, optional chaining and defaults without loading project configuration", () => {
    const result = functionUnits(
      "example.tsx",
      "const Component = ({ value = 1 }: {value?: number}) => value > 0 ? <div>{value}</div> : null;\nfunction access(x: any = {}) { return x?.a?.b || 1; }",
    );
    expect(result.units.find((f) => f.name === "Component")?.complexity).toBe(
      3,
    );
    expect(result.units.find((f) => f.name === "access")?.complexity).toBe(5);
  });
  it("rejects malformed/negative Istanbul counters and invalid source spans", () => {
    const s = snapshot("src/choose.ts", source),
      raw = istanbul("src/choose.ts", [-1, 0, 0]);
    expect(() => measure(s, "istanbul", raw, provenance(s, raw))).toThrow();
    const wrong = istanbul().replace('"line":3', '"line":99');
    expect(
      measure(s, "istanbul", wrong, provenance(s, wrong)).highest,
    ).toBeNull();
  });
  it("uses JaCoCo method descriptors, complexity and instruction counters", () => {
    const s = snapshot(
      "src/main/java/example/Choice.java",
      "package example;\nclass Choice {\n int choose(int x) { return x; }\n int choose(String x) { return x.length(); }\n}\n",
    );
    const raw =
      '<report name="fixture"><package name="example"><class name="example/Choice" sourcefilename="Choice.java"><method name="choose" desc="(I)I" line="3"><counter type="INSTRUCTION" missed="4" covered="4"/><counter type="COMPLEXITY" missed="1" covered="1"/></method><method name="choose" desc="(Ljava/lang/String;)I" line="4"><counter type="INSTRUCTION" missed="0" covered="4"/><counter type="COMPLEXITY" missed="0" covered="1"/></method></class></package></report>';
    const metrics = measure(s, "jacoco", raw, provenance(s, raw));
    expect(metrics.measured).toBe(2);
    expect(metrics.files[0].functions.map((f) => f.crap)).toEqual([2.5, 1]);
    const empty = raw.replace(
      'missed="4" covered="4"',
      'missed="0" covered="0"',
    );
    expect(measure(s, "jacoco", empty, provenance(s, empty)).missing).toBe(1);
    expect(() =>
      measure(s, "jacoco", '<!DOCTYPE report [<!ENTITY bomb "x">]><report/>'),
    ).toThrow();
  });
});
async function fixture(file: string, text: string) {
  const root = await temp();
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(
    path.join(root, ".gitignore"),
    "coverage/\ntarget/\n*.class\n",
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Coverage fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-m", "initial");
  await writeFile(path.join(root, file), text);
  const s = await captureSnapshot(
    root,
    { mode: "all", base: "main" },
    "coverage-session",
  );
  const store = new Store(await temp());
  stores.push(store);
  store.create(s);
  const runner = new CoverageRunner(store);
  runners.push(runner);
  return { root, s, store, runner };
}
async function waitRun(store: Store, id: string) {
  for (let i = 0; i < 600; i++) {
    const run = store.testRun(id)!;
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fixture run timed out.");
}
describe("explicit coverage execution and persistence", () => {
  it("backs up a v1 database before migration and recovers interrupted runs", async () => {
    const directory = await temp(),
      db = new Database(path.join(directory, "leanreview.sqlite"));
    db.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL, active_snapshot TEXT, updated_at TEXT NOT NULL); CREATE TABLE snapshots (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;",
    );
    db.prepare("INSERT INTO settings VALUES (?,?)").run(
      "preserved",
      JSON.stringify("value"),
    );
    db.close();
    const store = new Store(directory);
    expect(store.setting("preserved")).toBe("value");
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith("leanreview.pre-v2."),
      ),
    ).toBe(true);
    const s = snapshot("src/choose.ts", source);
    store.create(s);
    const config: TestConfig = {
      format: "istanbul",
      cwd: ".",
      reportPath: "coverage/coverage-final.json",
      timeoutSeconds: 10,
      threshold: 8,
      steps: [{ executable: process.execPath, args: [], shell: false }],
    };
    store.saveTestRun({
      id: "interrupted-fixture",
      snapshotId: s.id,
      config,
      status: "running",
      startedAt: new Date().toISOString(),
      log: "",
    });
    store.close();
    const reopened = new Store(directory);
    stores.push(reopened);
    expect(reopened.testRun("interrupted-fixture")?.status).toBe("interrupted");
    expect(reopened.setting("preserved")).toBe("value");
  });
  it("rejects escaping paths and times out without accepting a report", async () => {
    const { s, store, runner } = await fixture("src/choose.ts", source);
    const config: TestConfig = {
      format: "istanbul",
      cwd: ".",
      reportPath: "../escape.json",
      timeoutSeconds: 1,
      threshold: 8,
      steps: [
        {
          executable: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          shell: false,
        },
      ],
    };
    await expect(runner.prepare(s, config)).rejects.toThrow(
      "repository-contained",
    );
    config.reportPath = "coverage/coverage-final.json";
    runner.saveConfig(s.root, config);
    const completed = await waitRun(
      store,
      (await runner.start(s, (await runner.prepare(s, config)).id)).id,
    );
    expect(completed.status).toBe("failed");
    expect(completed.error).toMatch(/timed out|timeout/i);
    expect(store.coverage(s.id, "istanbul")).toBeNull();
  });
  it("runs real Vitest/V8 tests, exports provenance, and reimports measured TS source", async () => {
    const { root, s, store, runner } = await fixture("src/choose.ts", source);
    await writeFile(
      path.join(root, "choose.test.ts"),
      'import {it,expect} from "vitest"; import {choose} from "./src/choose"; it("exercises both branches",()=>{expect(choose(2)).toBe(1);expect(choose(0)).toBe(0);});',
    );
    await writeFile(
      path.join(root, "vitest.config.mjs"),
      'export default {test:{include:["choose.test.ts"],coverage:{provider:"v8",enabled:true,reporter:["json"],include:["src/*.ts"]}}};',
    );
    const config: TestConfig = {
      format: "istanbul",
      cwd: ".",
      reportPath: "coverage/coverage-final.json",
      timeoutSeconds: 30,
      threshold: 8,
      steps: [
        {
          executable: process.execPath,
          args: [
            path.resolve("node_modules/vitest/vitest.mjs"),
            "run",
            "--root",
            root,
            "--config",
            path.join(root, "vitest.config.mjs"),
          ],
          shell: false,
        },
      ],
    };
    runner.saveConfig(root, config);
    const preview = await runner.prepare(s, config);
    const started = await runner.start(s, preview.id);
    const completed = await waitRun(store, started.id);
    expect(completed.status, completed.error + "\n" + completed.log).toBe(
      "succeeded",
    );
    expect(completed.metrics?.measured).toBe(1);
    expect(completed.metrics?.files[0].functions[0].coverage).toBe(1);
    expect(completed.metrics?.highest).toBe(2);
    const raw = await readFile(path.join(root, config.reportPath), "utf8"),
      sidecar = JSON.parse(
        await readFile(
          path.join(root, config.reportPath + ".leanreview.json"),
          "utf8",
        ),
      );
    expect(measure(s, "istanbul", raw, sidecar).highest).toBe(2);
    expect(store.coverage(s.id, "istanbul")?.highest).toBe(2);
  }, 40000);
  it.skipIf(
    !existsSync(".leanreview-test/jacoco-tools/agent.jar") ||
      !existsSync(".leanreview-test/jacoco-tools/cli.jar"),
  )(
    "runs real Java assertions under JaCoCo and imports the generated XML",
    async () => {
      const agent = path.resolve(".leanreview-test/jacoco-tools/agent.jar"),
        cli = path.resolve(".leanreview-test/jacoco-tools/cli.jar");
      await access(agent);
      await access(cli);
      const javaSource =
        'public class Choice {\n public static int choose(int x) {\n  if (x > 0) return 1;\n  return 0;\n }\n public static void main(String[] args) {\n  if (choose(2) != 1 || choose(0) != 0) throw new AssertionError("branches");\n }\n}\n';
      const { root, s, store, runner } = await fixture(
        "Choice.java",
        javaSource,
      );
      await mkdir(path.join(root, "target"));
      const config: TestConfig = {
        format: "jacoco",
        cwd: ".",
        reportPath: "target/jacoco.xml",
        timeoutSeconds: 30,
        threshold: 8,
        steps: [
          {
            executable: "javac",
            args: ["-g", "-d", "target", "Choice.java"],
            shell: false,
          },
          {
            executable: "java",
            args: [
              `-javaagent:${agent}=destfile=target/jacoco.exec`,
              "-cp",
              "target",
              "Choice",
            ],
            shell: false,
          },
          {
            executable: "java",
            args: [
              "-jar",
              cli,
              "report",
              "target/jacoco.exec",
              "--classfiles",
              "target",
              "--sourcefiles",
              ".",
              "--xml",
              "target/jacoco.xml",
            ],
            shell: false,
          },
        ],
      };
      runner.saveConfig(root, config);
      const run = await runner.start(s, (await runner.prepare(s, config)).id);
      const completed = await waitRun(store, run.id);
      expect(completed.status, completed.error + "\n" + completed.log).toBe(
        "succeeded",
      );
      expect(
        completed.metrics?.files[0].functions.find((f) =>
          f.name.includes("#choose(I)I"),
        )?.coverage,
      ).toBe(1);
    },
    40000,
  );
  it("rejects stale reports, failed commands, changed sources and expired previews", async () => {
    const { root, s, store, runner } = await fixture("src/choose.ts", source);
    await mkdir(path.join(root, "coverage"));
    await writeFile(
      path.join(root, "coverage/coverage-final.json"),
      istanbul(),
    );
    const config: TestConfig = {
      format: "istanbul",
      cwd: ".",
      reportPath: "coverage/coverage-final.json",
      timeoutSeconds: 10,
      threshold: 8,
      steps: [
        {
          executable: process.execPath,
          args: ["-e", 'console.log("no report generated")'],
          shell: false,
        },
      ],
    };
    runner.saveConfig(root, config);
    const stale = await waitRun(
      store,
      (await runner.start(s, (await runner.prepare(s, config)).id)).id,
    );
    expect(stale.status).toBe("failed");
    expect(stale.error).toContain("not regenerated");
    const raw = istanbul();
    store.saveCoverage(
      measure(s, "istanbul", raw, provenance(s, raw)),
      raw,
      provenance(s, raw),
    );
    config.steps[0].args = ["-e", "process.exit(3)"];
    runner.saveConfig(root, config);
    const failed = await waitRun(
      store,
      (await runner.start(s, (await runner.prepare(s, config)).id)).id,
    );
    expect(failed.status).toBe("failed");
    expect(store.coverage(s.id, "istanbul")?.highest).not.toBeNull();
    const preview = await runner.prepare(s, config);
    await writeFile(path.join(root, "src/choose.ts"), "changed");
    await expect(runner.start(s, preview.id)).rejects.toThrow(
      "Working source differs",
    );
    await expect(runner.start(s, "expired-or-invented")).rejects.toThrow(
      "expired",
    );
  });
  it("cancels a process tree, excludes provider environment secrets, and redacts logs", async () => {
    process.env.OPENAI_API_KEY = "fixture-secret";
    expect(testEnvironment()).not.toHaveProperty("OPENAI_API_KEY");
    delete process.env.OPENAI_API_KEY;
    const { root, s, store, runner } = await fixture("src/choose.ts", source);
    const config: TestConfig = {
      format: "istanbul",
      cwd: ".",
      reportPath: "coverage/coverage-final.json",
      timeoutSeconds: 10,
      threshold: 8,
      steps: [
        {
          executable: process.execPath,
          args: [
            "-e",
            'console.log("token=fixture-secret"); setInterval(()=>{},1000)',
          ],
          shell: false,
        },
      ],
    };
    runner.saveConfig(root, config);
    const run = await runner.start(s, (await runner.prepare(s, config)).id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    runner.cancel(run.id);
    const completed = await waitRun(store, run.id);
    expect(completed.status).toBe("canceled");
    expect(completed.log).not.toContain("fixture-secret");
  });
});
