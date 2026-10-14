import { it, expect } from "vitest";
import {
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { openEditor } from "../backend/src/api/editor";
import { nextUnreviewed } from "../frontend/src/lib/navigation";
import {
  emptyState,
  type Snapshot,
  type Review,
} from "../packages/contracts/src/index";
it("opens the selected working file with literal arguments and rejects changed snapshot content", async () => {
  await mkdir(".leanreview-test", { recursive: true });
  const root = await realpath(
    await mkdtemp(path.resolve(".leanreview-test/editor-")),
  );
  const file = path.join(root, "file with spaces & symbols.ts");
  const output = path.join(root, "arguments.json");
  await writeFile(file, "first\nsecond\n");
  const snapshot: Snapshot = {
    id: "snapshot",
    sessionId: "review",
    root,
    capturedAt: "",
    comparison: { mode: "all", base: "main" },
    head: null,
    base: null,
    complete: true,
    files: [
      {
        id: "file",
        path: path.basename(file),
        oldPath: path.basename(file),
        status: "modified",
        before: { kind: "text", text: "old\n" },
        after: { kind: "text", text: "first\nsecond\n" },
        fingerprint: "",
        patch: "",
      },
    ],
  };
  const config = {
    name: "Fixture editor",
    executable: process.execPath,
    args: [
      "-e",
      'require("fs").writeFileSync(process.argv[4],JSON.stringify(process.argv.slice(1,4)))',
      "{file}",
      "{line}",
      "{column}",
      output,
    ],
  };
  await openEditor(config, snapshot, {
    fileId: "file",
    side: "after",
    line: 2,
    column: 3,
  });
  let argumentsRead: string[] | undefined;
  for (let i = 0; i < 40; i++) {
    try {
      argumentsRead = JSON.parse(await readFile(output, "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  expect(argumentsRead).toEqual([file, "2", "3"]);
  await writeFile(file, "changed externally");
  await expect(
    openEditor(config, snapshot, {
      fileId: "file",
      side: "after",
      line: 2,
      column: 1,
    }),
  ).rejects.toThrow("Working file differs");
});
it("advances in accepted reading order, skipping reviewed files, and stops when complete", () => {
  const review: Review = {
    snapshot: {
      id: "snapshot",
      sessionId: "review",
      root: "",
      capturedAt: "",
      comparison: { mode: "all", base: "main" },
      head: null,
      base: null,
      files: [],
      complete: true,
    },
    history: [],
    state: {
      ...emptyState(),
      reviewed: ["c", "a"],
      accepted: {
        cohorts: [
          {
            name: "Concern",
            explanation: "",
            layers: [
              { name: "First", explanation: "", fileIds: ["c", "a"] },
              { name: "Next", explanation: "", fileIds: ["b"] },
            ],
          },
        ],
        findings: [],
      },
    },
  };
  expect(nextUnreviewed(review, "c")).toBe("b");
  review.state.reviewed.push("b");
  expect(nextUnreviewed(review, "b")).toBeUndefined();
});
