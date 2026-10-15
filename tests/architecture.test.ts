import { expect, it } from "vitest";
import fs from "node:fs";
import packageJson from "../package.json";

it("ships one Java backend and keeps Node limited to tooling and parsing", () => {
  expect(packageJson.scripts.start).toBe("node scripts/java-launch.mjs");
  expect(packageJson.scripts.build).toContain("java-launch.mjs");
  expect(packageJson.scripts.dev).toContain("java-launch.mjs");
  expect(packageJson.workspaces).not.toContain("backend");
  for (const name of [
    "express",
    "better-sqlite3",
    "@napi-rs/keyring",
    "fast-xml-parser",
    "open",
  ])
    expect(Object.keys(packageJson.dependencies)).not.toContain(name);
  expect(fs.existsSync("backend/src/index.ts")).toBe(false);
  expect(fs.existsSync("backend/src/api/app.ts")).toBe(false);
});
