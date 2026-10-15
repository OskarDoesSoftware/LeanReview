import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

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
await writeFile(path.join(root, "first.ts"), "export const first = 2;\n");
await writeFile(path.join(root, "second.ts"), "export const second = true;\n");
const data = path.join(directory, "data");
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
      JSON.stringify({ root, link: match[1] }),
    );
    console.log("Java browser fixture ready");
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill());
