import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

it.each([
  ["auth", "login"],
  ["auth", "status", "--show-token"],
  [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    "repos/example/repo/pulls/7/reviews",
    "--input",
    "-",
  ],
  [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    "-H",
    "Accept: application/vnd.github+json",
    "repos/example/repo",
    "-X",
    "DELETE",
  ],
  [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    "graphql",
    "--input",
    "-",
  ],
])("live acceptance rejects mutation or credential command %j", (...args) => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("tests/fixtures/github-readonly.mjs"), ...args],
    {
      input: JSON.stringify({
        query:
          'mutation { resolveReviewThread(input:{threadId:"fixture"}) { thread { id } } }',
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Live read-only");
});
