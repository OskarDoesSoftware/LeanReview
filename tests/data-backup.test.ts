import { it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error recovery tooling is a source-distributed Node script
import { backupData, restoreData } from "../scripts/data-backup.mjs";

it("restores a paired database/cache backup and rejects corrupt or existing destinations", async () => {
  const directory = await fs.mkdtemp(
    path.resolve(".leanreview-test/recovery-"),
  );
  const source = path.join(directory, "source");
  await fs.cp("tests/fixtures/backend-compatibility/databases/v3", source, {
    recursive: true,
  });
  const original = new DatabaseSync(path.join(source, "leanreview.sqlite"));
  const before = original
    .prepare("SELECT * FROM snapshots ORDER BY rowid")
    .all();
  const backup = path.join(directory, "backup");
  await backupData(source, backup);
  original.close();
  const restored = path.join(directory, "restored");
  await restoreData(backup, restored);
  const reopened = new DatabaseSync(path.join(restored, "leanreview.sqlite"));
  expect(
    reopened.prepare("SELECT * FROM snapshots ORDER BY rowid").all(),
  ).toEqual(before);
  reopened.close();
  await expect(restoreData(backup, restored)).rejects.toThrow();
  await fs.appendFile(path.join(backup, "leanreview.sqlite"), "corruption");
  await expect(
    restoreData(backup, path.join(directory, "invalid")),
  ).rejects.toThrow("verification");
});
