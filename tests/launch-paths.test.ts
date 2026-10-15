import { expect, it } from "vitest";
import path from "node:path";
// @ts-expect-error source-distributed launcher utility
import { dataDirectory } from "../scripts/launch-paths.mjs";

it("uses the original application data location and honors explicit overrides", () => {
  expect(dataDirectory({ LOCALAPPDATA: "local" }, "win32", "home")).toBe(
    path.resolve("local/LeanReview"),
  );
  expect(dataDirectory({}, "darwin", "home")).toBe(
    path.resolve("home/Library/Application Support/LeanReview"),
  );
  expect(dataDirectory({ XDG_DATA_HOME: "xdg" }, "linux", "home")).toBe(
    path.resolve("xdg/LeanReview"),
  );
  expect(dataDirectory({}, "linux", "home")).toBe(
    path.resolve("home/.local/share/LeanReview"),
  );
  expect(
    dataDirectory({
      LEANREVIEW_DATA_DIR: "explicit",
      LEANREVIEW_JAVA_DATA_DIR: "preview",
    }),
  ).toBe(path.resolve("explicit"));
  expect(dataDirectory({ LEANREVIEW_JAVA_DATA_DIR: "preview" })).toBe(
    path.resolve("preview"),
  );
});
