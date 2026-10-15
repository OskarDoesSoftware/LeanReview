import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hash } from "../backend/src/git/local";
import {
  captureHttp,
  exportDatabases,
  fixtureDirectory,
  jsonSchemas,
  routeInventory,
  parserFixtures,
} from "../tests/compatibility/capture";

if (!process.argv.includes("--write"))
  throw new Error(
    "Freezing fixtures requires --write. Run tests to verify without changing expectations.",
  );
await fs.mkdir(".leanreview-test", { recursive: true });
await fs.mkdir(fixtureDirectory, { recursive: true });
for (const [name, value] of Object.entries({
  "http.json": await captureHttp(),
  "schemas.json": jsonSchemas(),
  "routes.json": await routeInventory(),
  "parsers.json": await parserFixtures(),
  "storage.json": await exportDatabases(
    path.join(fixtureDirectory, "databases"),
  ),
})) {
  await fs.writeFile(
    path.join(fixtureDirectory, name),
    JSON.stringify(value, null, 2) + "\n",
  );
}
const files = (
  await fs.readdir(fixtureDirectory, { recursive: true, withFileTypes: true })
)
  .filter((entry) => entry.isFile() && entry.name !== "manifest.json")
  .map((entry) =>
    path
      .relative(fixtureDirectory, path.join(entry.parentPath, entry.name))
      .replaceAll("\\", "/"),
  )
  .sort();
const manifest = {
  formatVersion: 1,
  baselineCommit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  files: await Promise.all(
    files.map(async (name) => ({
      path: name,
      sha256: hash(await fs.readFile(path.join(fixtureDirectory, name))),
    })),
  ),
};
await fs.writeFile(
  path.join(fixtureDirectory, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `Frozen synthetic backend compatibility fixtures in ${fixtureDirectory}`,
);
