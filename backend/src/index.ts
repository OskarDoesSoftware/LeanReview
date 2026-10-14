import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import open from "open";
import { Store } from "./storage/store";
import { createApp } from "./api/app";
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error(
    "LeanReview requires Node 24. Run npm scripts with the pinned workspace runtime.",
  );
const dataRoot =
  process.env.LEANREVIEW_DATA_DIR ??
  path.join(
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? os.homedir())
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : (process.env.XDG_DATA_HOME ??
          path.join(os.homedir(), ".local", "share")),
    "LeanReview",
  );
const origin = process.env.LEANREVIEW_ORIGIN ?? "http://127.0.0.1:4318";
const store = new Store(dataRoot);
const { app, nonce, abort } = createApp(store, origin);
const dist = path.resolve("frontend/dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}
const server = app.listen(4318, "127.0.0.1", () => {
  console.log(
    `LeanReview is running at ${origin}. Data directory: ${dataRoot}`,
  );
  // This intentionally displayed startup link is a one-time local authorization, not an access-log entry.
  if (process.env.LEANREVIEW_NO_OPEN === "1")
    console.log(`Startup link: ${origin}/#bootstrap=${nonce}`);
  else
    void open(`${origin}/#bootstrap=${nonce}`).catch(() =>
      console.log(`Open ${origin}/#bootstrap=${nonce}`),
    );
});
const shutdown = async () => {
  await abort();
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
