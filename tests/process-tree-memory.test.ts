import { expect, it } from "vitest";
import { treeSample } from "../scripts/process-tree-memory";

it("counts the parser and Git descendants but excludes unrelated processes", () => {
  expect(
    treeSample(10, [
      { pid: 30, parent: 20, rss: 300, name: "git.exe" },
      { pid: 50, parent: 1, rss: 10000, name: "node.exe" },
      { pid: 20, parent: 10, rss: 200, name: "node.exe" },
      { pid: 10, parent: 1, rss: 100, name: "java.exe" },
    ]),
  ).toEqual({ rssBytes: 600, processes: 3, nodeProcesses: 1, gitProcesses: 1 });
});
