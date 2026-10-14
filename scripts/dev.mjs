import { spawn } from "node:child_process";
const children = [];
for (const [args, env] of [
  [
    ["node_modules/vite/bin/vite.js", "--config", "frontend/vite.config.ts"],
    {},
  ],
  [
    ["--import", "tsx", "backend/src/index.ts"],
    { LEANREVIEW_ORIGIN: "http://127.0.0.1:5173" },
  ],
])
  children.push(
    spawn(process.execPath, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    }),
  );
const stop = () => children.forEach((child) => child.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((child) =>
  child.on("exit", () => {
    stop();
    process.exitCode = 0;
  }),
);
