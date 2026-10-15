import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";

const commands = {
  build: { command: "npm run build", timeout: 15 * 60_000 },
  browser: { command: "npm run test:browser", timeout: 5 * 60_000 },
};
const name = process.argv[2];
const selected = commands[name];
if (!selected) throw new Error("Expected build or browser.");
await mkdir(".leanreview-test", { recursive: true });
const log = createWriteStream(`.leanreview-test/ci-${name}.log`);
const windows = process.platform === "win32";
const child = windows
  ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", selected.command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
  : spawn("npm", ["run", name === "build" ? "build" : "test:browser"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    log.write(chunk);
    process.stdout.write(chunk);
  });
}
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  const message = `\nCI ${name} exceeded ${selected.timeout / 60_000} minutes; stopping owned processes.\n`;
  log.write(message);
  process.stderr.write(message);
  if (windows) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 20_000,
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}, selected.timeout);
child.on("error", (error) => {
  clearTimeout(timer);
  log.end(String(error));
  process.exitCode = 1;
});
child.on("close", (code) => {
  clearTimeout(timer);
  log.end();
  process.exitCode = timedOut ? 124 : code ?? 1;
});
