import { build } from "tsup";
await build({
  entry: ["backend-java/helper/index.ts"],
  format: ["esm"],
  outDir: "backend-java/helper/dist",
  platform: "node",
  external: ["web-tree-sitter"],
  clean: true,
});
