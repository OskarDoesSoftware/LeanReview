import { expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../backend/src/storage/store";
import { CapturedArtifacts } from "../backend/src/storage/artifacts";
import { hash } from "../backend/src/git/local";
import {
  captureHttp,
  fixtureDirectory,
  jsonSchemas,
  routeInventory,
  snapshot,
  parserFixtures,
} from "./compatibility/capture";

async function fixture(name: string) {
  return JSON.parse(
    await fs.readFile(path.join(fixtureDirectory, name), "utf8"),
  );
}
it("matches the frozen fixture manifest including SQLite files and every cache blob", async () => {
  const manifest = await fixture("manifest.json");
  for (const file of manifest.files)
    expect(
      hash(await fs.readFile(path.join(fixtureDirectory, file.path))),
      file.path,
    ).toBe(file.sha256);
});
it("preserves frozen HTTP requests, response bodies, status codes, and session protection", async () => {
  expect(await captureHttp()).toEqual(await fixture("http.json"));
});
it("preserves route inventory and input validation schemas", async () => {
  expect(await routeInventory()).toEqual(await fixture("routes.json"));
  expect(jsonSchemas()).toEqual(await fixture("schemas.json"));
});
it("preserves TypeScript resolution, Java extraction, and complexity outputs", async () => {
  expect(await parserFixtures()).toEqual(await fixture("parsers.json"));
});
for (const version of [1, 2, 3])
  it(`reopens the frozen v${version} database and preserves data through migration and restart`, async () => {
    await fs.mkdir(".leanreview-test", { recursive: true });
    const directory = await fs.mkdtemp(
      path.resolve(`.leanreview-test/migrate-v${version}-`),
    );
    await fs.cp(
      path.join(fixtureDirectory, "databases", `v${version}`),
      directory,
      { recursive: true },
    );
    const before = new Database(path.join(directory, "leanreview.sqlite"));
    const expected = (await fixture("storage.json"))[`v${version}`];
    expect(before.pragma("user_version", { simple: true })).toBe(version);
    for (const table of expected.tables) {
      expect(
        before
          .prepare("SELECT sql FROM sqlite_master WHERE name=?")
          .get(table.name),
      ).toEqual({ sql: table.sql });
      expect(
        before
          .prepare(
            `SELECT rowid AS _rowid_, * FROM ${table.name} ORDER BY rowid`,
          )
          .all(),
      ).toEqual(table.rows);
    }
    before.close();
    const store = new Store(directory);
    try {
      expect(store.db.pragma("user_version", { simple: true })).toBe(3);
      const review = store.review("session-fixture");
      expect(review.snapshot.files.map((f) => f.after)).toEqual(
        snapshot().files.map((f) => f.after),
      );
      expect(review.state.reviewed).toEqual(["file-ts"]);
      expect(review.state.drafts[0].text).toBe(
        "Synthetic review comment: café",
      );
      expect(review.state.analysisStatus).toBe("interrupted");
      expect(review.history.map((s) => s.id)).toEqual([
        "snapshot-current",
        "snapshot-history",
      ]);
      expect(store.setting("provider")).toMatchObject({ model: "fixture" });
      if (version >= 2) {
        expect(store.coverage("snapshot-current", "istanbul")).toMatchObject({
          aligned: false,
          measured: 1,
          highest: 2.5,
        });
        expect(store.testRun("test-running")?.status).toBe("interrupted");
        expect(
          store.coverageArtifact("snapshot-current", "istanbul").report,
        ).toContain("statementMap");
      }
      if (version >= 3) {
        const row = store.db.prepare("SELECT run FROM graphs").get() as {
          run: string;
        };
        expect(JSON.parse(row.run).status).toBe("interrupted");
      }
      expect(store.db.pragma("foreign_key_check")).toEqual([]);
      expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
      const artifacts = new CapturedArtifacts(store.cache);
      for (const digest of await fs.readdir(store.cache))
        expect(hash(artifacts.read(digest))).toBe(digest);
      if (version < 3)
        expect(
          (await fs.readdir(directory)).some((name) =>
            name.startsWith(`leanreview.pre-v${version + 1}.`),
          ),
        ).toBe(true);
    } finally {
      store.close();
    }
    const reopened = new Store(directory);
    try {
      expect(reopened.review("session-fixture").state.analysisStatus).toBe(
        "interrupted",
      );
      expect(reopened.review("session-fixture").state.reviewed).toEqual([
        "file-ts",
      ]);
    } finally {
      reopened.close();
    }
  });
