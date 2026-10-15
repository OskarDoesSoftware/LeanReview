import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { createServer } from "node:http";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

await build({
  configFile: false,
  root: path.resolve("tests/browser-java"),
  base: "/assets/java-analysis/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve("frontend/src") } },
  build: {
    outDir: path.resolve("frontend/dist/assets/java-analysis"),
    emptyOutDir: true,
    rollupOptions: { input: path.resolve("tests/browser-java/analysis.html") },
  },
});

await mkdir(".leanreview-test", { recursive: true });
const directory = await mkdtemp(path.resolve(".leanreview-test/java-browser-"));
const root = path.join(directory, "java-review-fixture");
await mkdir(root);
const git = (...args) =>
  execFileSync("git", ["-c", "core.hooksPath=", ...args], {
    cwd: root,
    windowsHide: true,
    stdio: "pipe",
  });
git("init", "-b", "main");
git("config", "user.name", "Fixture");
git("config", "user.email", "fixture@example.invalid");
git("config", "core.autocrlf", "false");
await writeFile(path.join(root, "first.ts"), "export const first = 1;\n");
git("add", ".");
git("commit", "--no-gpg-sign", "-m", "fixture");
await writeFile(
  path.join(root, "first.ts"),
  "export function first(x: number) { if (x) return 2; return 0; }\n",
);
await writeFile(
  path.join(root, "second.ts"),
  "import { first } from './first'; export const second = first(1);\n",
);
const data = path.join(directory, "data");
const provider = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(JSON.parse(body).messages[1].content);
  const result = {
    cohorts: [
      {
        name: "AI fixture",
        explanation: "Local provider fixture",
        layers: [
          {
            name: "Read changes",
            explanation: "Both files",
            fileIds: input.files.map((file) => file.id),
          },
        ],
      },
    ],
    findings: [],
  };
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      message: { content: JSON.stringify(result) },
      done_reason: "stop",
    }),
  );
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
await cp("tests/fixtures/backend-compatibility/databases/v3", data, {
  recursive: true,
});
const javaHome =
  process.env.JAVA_HOME ||
  path.resolve(".leanreview-test/java-tools/jdk-25.0.4.1+1");
const java = path.join(
  javaHome,
  "bin",
  process.platform === "win32" ? "java.exe" : "java",
);
const child = spawn(
  java,
  [
    "--enable-native-access=ALL-UNNAMED",
    "-jar",
    path.resolve("backend-java/target/leanreview-backend-0.1.0-SNAPSHOT.jar"),
    "--spring.profiles.active=web",
    "--server.port=4324",
    "--leanreview.origin=http://127.0.0.1:4324",
    `--leanreview.data-directory=${data}`,
    `--leanreview.frontend-directory=${path.resolve("frontend/dist")}`,
    `--leanreview.analysis.helper=${path.resolve("backend-java/helper/dist/index.js")}`,
    `--leanreview.analysis.node=${process.execPath}`,
    `--leanreview.codex.command=${JSON.stringify([process.execPath,path.resolve("tests/fixtures/java-codex-app-server.mjs"),"browser-login",path.join(directory,"codex-protocol.jsonl")])}`,
    "--logging.level.root=ERROR",
    "--spring.main.banner-mode=off",
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "",
  saved = false;
child.stdout.on("data", async (chunk) => {
  output += chunk.toString();
  const match = output.match(
    /Startup link: (http:\/\/127\.0\.0\.1:4324\/#bootstrap=\w+)/,
  );
  if (match && !saved) {
    saved = true;
    await writeFile(
      ".leanreview-test/java-browser-fixture.json",
      JSON.stringify({ root, link: match[1], providerOrigin }),
    );
    console.log("Java browser fixture ready");
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill());
