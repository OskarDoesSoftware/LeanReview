import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Run this command with the workspace Node 24 runtime.");
const windows = process.platform === "win32";
const java = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, "bin", windows ? "java.exe" : "java")
  : "java";
const version = spawnSync(java, ["-version"], {
  encoding: "utf8",
  windowsHide: true,
});
if (version.error || !/version "25[.\"]/.test(version.stderr))
  throw new Error("Set JAVA_HOME to JDK 25 before launching the Java backend.");
const build = process.argv.includes("--build");
const dev = process.argv.includes("--dev");
const children = new Set();
let stopping = false;
function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    detached: !windows,
    ...options,
  });
  children.add(child);
  child.on("error", () => {
    console.error("A required Java launch process could not start.");
    stop(1);
  });
  child.on("exit", (code) => {
    children.delete(child);
    if (!stopping) stop(code ?? 1);
  });
  return child;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (process.connected) process.disconnect();
  for (const child of children) {
    if (windows && child.pid)
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 10000,
      });
    else {
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 10000);
      force.unref();
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
process.on("message", (message) => {
  if (message === "shutdown") stop();
});
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
if (build) {
  run(process.execPath, [
    "node_modules/vite/bin/vite.js",
    "build",
    "--config",
    "frontend/vite.config.ts",
  ]);
  run(process.execPath, ["scripts/build-analysis-helper.mjs"]);
  // cmd is required for the Maven wrapper on Windows. All arguments are fixed.
  if (windows)
    run(process.env.ComSpec || "cmd.exe", [
      "/d",
      "/c",
      "backend-java\\mvnw.cmd",
      "-f",
      "backend-java/pom.xml",
      "verify",
    ]);
  else run("sh", ["backend-java/mvnw", "-f", "backend-java/pom.xml", "verify"]);
}
const jar = path.join(
  root,
  "backend-java/target/leanreview-backend-0.1.0-SNAPSHOT.jar",
);
if (
  !fs.existsSync(jar) ||
  !fs.existsSync("backend-java/helper/dist/index.js") ||
  !fs.existsSync("frontend/dist/index.html")
)
  throw new Error("Run npm run build:java first.");
if (process.argv.includes("--build-only")) process.exit(0);
const data = path.resolve(
  process.env.LEANREVIEW_JAVA_DATA_DIR ||
    path.join(
      process.platform === "win32"
        ? process.env.LOCALAPPDATA || os.homedir()
        : process.platform === "darwin"
          ? path.join(os.homedir(), "Library/Application Support")
          : process.env.XDG_DATA_HOME ||
            path.join(os.homedir(), ".local/share"),
      "LeanReview-JavaPreview",
    ),
);
const port = Number(process.env.LEANREVIEW_JAVA_PORT || 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid Java loopback port.");
if (dev && port !== 4318)
  throw new Error("Development proxy requires port 4318.");
const origin = dev ? "http://127.0.0.1:5173" : "http://127.0.0.1:" + port;
if (dev)
  start(process.execPath, [
    "node_modules/vite/bin/vite.js",
    "--config",
    "frontend/vite.config.ts",
  ]);
start(java, [
  "--enable-native-access=ALL-UNNAMED",
  "-jar",
  jar,
  "--spring.profiles.active=web",
  "--spring.main.headless=false",
  "--server.port=" + port,
  `--leanreview.origin=${origin}`,
  `--leanreview.data-directory=${data}`,
  `--leanreview.frontend-directory=${path.join(root, "frontend/dist")}`,
  `--leanreview.analysis.helper=${path.join(root, "backend-java/helper/dist/index.js")}`,
  `--leanreview.analysis.node=${process.execPath}`,
  "--leanreview.open-browser=true",
]);
