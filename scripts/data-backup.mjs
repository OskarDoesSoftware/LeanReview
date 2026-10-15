import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { pathToFileURL } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Backups contain the database and captured artifacts, never account credentials.
export async function backupData(source, destination) {
  source = await fs.realpath(source);
  destination = path.resolve(destination);
  if (destination === source || destination.startsWith(source + path.sep))
    throw new Error(
      "Choose a backup directory outside the application data directory.",
    );
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  const db = new DatabaseSync(path.join(source, "leanreview.sqlite"), {
    readOnly: true,
  });
  try {
    await backup(db, path.join(destination, "leanreview.sqlite"));
  } finally {
    db.close();
  }
  await fs.mkdir(path.join(destination, "cache"), { mode: 0o700 });
  const files = {};
  for (const name of await fs.readdir(path.join(source, "cache"))) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const file = path.join(source, "cache", name);
    if (!(await fs.lstat(file)).isFile())
      throw new Error("Unexpected captured artifact type.");
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== name)
      throw new Error(
        "A captured artifact is corrupt; backup was not completed.",
      );
    await fs.writeFile(path.join(destination, "cache", name), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    files[`cache/${name}`] = name;
  }
  files["leanreview.sqlite"] = digest(
    await fs.readFile(path.join(destination, "leanreview.sqlite")),
  );
  const check = new DatabaseSync(path.join(destination, "leanreview.sqlite"), {
    readOnly: true,
  });
  try {
    if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("Backup integrity check failed.");
    // All encoded content references must be included in the paired backup.
    for (const row of check.prepare("SELECT data FROM snapshots").iterate()) {
      for (const file of JSON.parse(row.data).files) {
        for (const hash of [
          file.before?.hash,
          file.after?.hash,
          file.patchHash,
        ].filter(Boolean))
          if (!files[`cache/${hash}`])
            throw new Error("Backup is missing a referenced artifact.");
      }
    }
  } finally {
    check.close();
  }
  await fs.writeFile(
    path.join(destination, "backup.json"),
    JSON.stringify(
      { version: 1, createdAt: new Date().toISOString(), files },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
}

export async function restoreData(source, destination) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(source, "backup.json"), "utf8"),
  );
  if (manifest.version !== 1 || !manifest.files?.["leanreview.sqlite"])
    throw new Error("Unsupported or incomplete backup.");
  // Validate everything before creating a fresh restore directory. Never overwrite user data.
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (name !== "leanreview.sqlite" && !/^cache\/[a-f0-9]{64}$/.test(name))
      throw new Error("Invalid backup entry.");
    if (digest(await fs.readFile(path.join(source, name))) !== hash)
      throw new Error("Backup verification failed.");
  }
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  await fs.mkdir(path.join(destination, "cache"), { mode: 0o700 });
  for (const name of Object.keys(manifest.files))
    await fs.copyFile(
      path.join(source, name),
      path.join(destination, name),
      fs.constants.COPYFILE_EXCL,
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [operation, source, destination] = process.argv.slice(2);
  if (!source || !destination || !["backup", "restore"].includes(operation))
    throw new Error(
      "Usage: node scripts/data-backup.mjs backup|restore SOURCE NEW_DESTINATION",
    );
  await (operation === "backup" ? backupData : restoreData)(
    source,
    destination,
  );
  console.log(`${operation} completed and verified.`);
}
