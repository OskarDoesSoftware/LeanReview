import { spawn } from "node:child_process";

// Explicit live acceptance only. Reuse the CLI's OS-keyring account without copying credentials.
const args = process.argv.slice(2);
const status =
  JSON.stringify(args) ===
  JSON.stringify([
    "auth",
    "status",
    "--hostname",
    "github.com",
    "--active",
    "--json",
    "hosts",
  ]);
const api =
  (args.length === 8 || args.length === 10) &&
  args[0] === "api" &&
  args[1] === "--hostname" &&
  args[2] === "github.com" &&
  args[3] === "--method" &&
  args[5] === "-H" &&
  args[6] === "Accept: application/vnd.github+json";
const get =
  api &&
  args.length === 8 &&
  args[4] === "GET" &&
  /^(repos|repositories|user)\/[A-Za-z0-9_/?&=.%:,+-]+$/.test(args[7]);
const query =
  api &&
  args[4] === "POST" &&
  args[7] === "graphql" &&
  args[8] === "--input" &&
  args[9] === "-";
if (!status && !get && !query)
  throw new Error("Live read-only acceptance rejected this command.");
let body = "";
if (query) {
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024)
      throw new Error("Live read-only query exceeds its limit.");
  }
  const input = JSON.parse(body);
  if (
    typeof input.query !== "string" ||
    !/^query\b/.test(input.query) ||
    /\bmutation\b/.test(input.query)
  )
    throw new Error("Live read-only acceptance rejects GraphQL mutations.");
}
const env = { ...process.env };
for (const name of [
  "GH_CONFIG_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
])
  delete env[name];
const child = spawn("gh", args, {
  env,
  windowsHide: true,
  stdio: [query ? "pipe" : "inherit", "inherit", "inherit"],
});
if (query) child.stdin.end(body);
child.on("error", () => {
  console.error("GitHub CLI is unavailable.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
