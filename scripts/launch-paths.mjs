import path from "node:path";
import os from "node:os";

export function dataDirectory(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  return path.resolve(
    env.LEANREVIEW_DATA_DIR ||
      env.LEANREVIEW_JAVA_DATA_DIR ||
      path.join(
        platform === "win32"
          ? env.LOCALAPPDATA || home
          : platform === "darwin"
            ? path.join(home, "Library/Application Support")
            : env.XDG_DATA_HOME || path.join(home, ".local/share"),
        "LeanReview",
      ),
  );
}
