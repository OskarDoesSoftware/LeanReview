import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, cp, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { restoreData } from "./data-backup.mjs";
import path from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";

await mkdir(path.resolve(".leanreview-test"), { recursive: true });
const data = await mkdtemp(path.resolve(".leanreview-test/launch-acceptance-"));
await cp("tests/fixtures/backend-compatibility/databases/v3", data, {
  recursive: true,
});
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const started = performance.now();
const launcher = fork("scripts/java-launch.mjs", [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    LEANREVIEW_PORT: String(port),
    LEANREVIEW_DATA_DIR: data,
    LEANREVIEW_NO_OPEN: "1",
  },
});
let output = "";
launcher.stdout.on("data", (chunk) => {
  output += chunk;
});
launcher.stderr.resume();
const exited = once(launcher, "exit");
try {
  const deadline = Date.now() + 60000;
  while (!output.includes("Startup link:")) {
    if (launcher.exitCode !== null || Date.now() > deadline)
      throw new Error("Java launcher failed to become ready.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const startupMs = Math.round(performance.now() - started);
  const nonce = output.match(/#bootstrap=(\w+)/)[1];
  output = "";
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(origin)).status, 200);
  const session = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const capabilities = await fetch(origin + "/api/capabilities", {
    headers: { cookie },
  });
  assert.equal((await capabilities.json()).backend, "java");
  const saved = await fetch(origin + "/api/sessions/session-fixture", {
    headers: { cookie },
  });
  assert.equal((await saved.json()).snapshot.id, "snapshot-current");
  launcher.send("shutdown");
  const result = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Launcher shutdown deadline exceeded.")),
        15000,
      ).unref(),
    ),
  ]);
  assert.equal(result[0], 0);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(1000) }));
  const marker = JSON.parse(
    await readFile(path.join(data, "java-cutover.json"), "utf8"),
  );
  assert.equal(marker.version, 1);
  const restored = data + "-restored";
  await restoreData(marker.backup, restored);
  const recovered = new DatabaseSync(path.join(restored, "leanreview.sqlite"), {
    readOnly: true,
  });
  try {
    const state = recovered
      .prepare("SELECT state FROM snapshots WHERE id='snapshot-current'")
      .get().state;
    assert.equal(JSON.parse(state).analysisStatus, "running");
  } finally {
    recovered.close();
  }
  console.log(
    JSON.stringify({
      passed: true,
      startupMs,
      shutdown: "owned process stopped",
      dataIsolation: true,
      preJavaBackupRestored: true,
    }),
  );
} finally {
  if (launcher.connected) launcher.send("shutdown");
}
