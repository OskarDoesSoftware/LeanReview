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
  path.join(root, ".gitignore"),
  "coverage/\nnode_modules/\n*.test.ts\nvitest.config.mjs\n",
);
await writeFile(
  path.join(root, "src/auth/validatePassword.ts"),
  "export function validatePassword(value: string) {\n  return value.length >= 8;\n}\n",
);
await mkdir(path.join(root, "src/graph"), { recursive: true });
await mkdir(path.join(root, "src/main/java/a"), { recursive: true });
await mkdir(path.join(root, "src/main/java/b"), { recursive: true });
await writeFile(
  path.join(root, "src/graph/entry.ts"),
  'import "./helper";import "javascript:alert(1)";export const entry=1;',
);
await writeFile(
  path.join(root, "src/graph/helper.ts"),
  'import "./entry";export const helper=1;',
);
await writeFile(
  path.join(root, "src/main/java/a/A.java"),
  "package a; import b.B; public class A { B dependency; }",
);
await writeFile(
  path.join(root, "src/main/java/b/B.java"),
  "package b; public class B { a.A dependency; }",
);
for (let i = 0; i < 40; i++) {
  const folder = path.join(root, "src/features", `area${Math.floor(i / 8)}`);
  await mkdir(folder, { recursive: true });
  const imports =
    i < 39 ? `import '../area${Math.floor((i + 1) / 8)}/feature${i + 1}';` : "";
  await writeFile(
    path.join(folder, `feature${i}.ts`),
    `${imports}export const value${i}=${i};`,
  );
}
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
  path.join(root, "password.test.ts"),
  'import {it,expect} from "vitest";import {validatePassword} from "./src/auth/validatePassword";it("password branches",()=>{expect(validatePassword("Abcdefghijk12")).toBe(true);expect(validatePassword("short")).toBe(false);});',
);
await writeFile(
  path.join(root, "vitest.config.mjs"),
  'export default {test:{include:["password.test.ts"],coverage:{provider:"v8",enabled:true,reporter:["json"],include:["src/auth/*.ts"]}}};',
);
await writeFile(
  ".leanreview-test/browser-fixture.json",
  JSON.stringify({
    root,
    node: process.execPath,
    vitest: path.resolve("node_modules/vitest/vitest.mjs"),
  }),
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
const { app, abort } = createApp(
  store,
  "http://127.0.0.1:4320",
  "browser-fixture-nonce",
);
app.use(express.static(path.resolve("frontend/dist")));
const server = app.listen(4320, "127.0.0.1");
const close = async () => {
  await abort();
  server.closeAllConnections();
  fixtureProvider.closeAllConnections();
  server.close();
  fixtureProvider.close();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
