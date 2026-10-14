import { createServer } from "node:http";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import express from "express";
import { Store } from "../backend/src/storage/store";
import { createApp } from "../backend/src/api/app";
await mkdir(".leanreview-test", { recursive: true });
const dir = await mkdtemp(path.resolve(".leanreview-test", "browser-"));
const root = path.join(dir, "identity-service");
await mkdir(path.join(root, "src", "auth"), { recursive: true });
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.name", "Fixture");
git("config", "user.email", "fixture@example.invalid");
await writeFile(
  path.join(root, "src/auth/validatePassword.ts"),
  "export function validatePassword(value: string) {\n  return value.length >= 8;\n}\n",
);
git("add", ".");
git("commit", "-m", "initial");
await writeFile(
  path.join(root, "src/auth/validatePassword.ts"),
  "export function validatePassword(value: string) {\n  if (value.length < 12) return false;\n  return /[0-9]/.test(value);\n}\n",
);
await writeFile(
  path.join(root, "src/auth/types.ts"),
  "export interface LoginRequest {\n  email: string;\n  password: string;\n}\n",
);
await writeFile(
  ".leanreview-test/browser-fixture.json",
  JSON.stringify({ root }),
);
const store = new Store(path.join(dir, "data"));
store.setSetting("provider", {
  provider: "ollama",
  endpoint: "http://127.0.0.1:11435",
  model: "fixture-model",
  contextWindow: 8192,
  maxOutput: 2048,
  localOnly: true,
});
const fixtureProvider = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const input = JSON.parse(JSON.parse(text).messages[1].content);
  const result = {
    cohorts: [
      {
        name: "Authentication",
        explanation: "Password policy and its contract",
        layers: input.files.map((f: any, index: number) => ({
          name: index === 0 ? "Validation rules" : "Contract",
          explanation: "Understand this part of the authentication change.",
          fileIds: [f.id],
        })),
      },
    ],
    findings: [],
  };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message: { content: JSON.stringify(result) } }));
}).listen(11435, "127.0.0.1");
const { app } = createApp(
  store,
  "http://127.0.0.1:4318",
  "browser-fixture-nonce",
);
app.use(express.static(path.resolve("frontend/dist")));
const server = app.listen(4318, "127.0.0.1");
const close = () => {
  server.closeAllConnections();
  fixtureProvider.closeAllConnections();
  server.close();
  fixtureProvider.close();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
