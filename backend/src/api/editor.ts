import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { containedFile } from "../git/local";
import type { Snapshot } from "../../../packages/contracts/src/index";
export const editorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  executable: z.string().trim().min(1).max(1000),
  args: z.array(z.string().max(2000)).max(32),
});
export type EditorConfig = z.infer<typeof editorSchema>;
export async function editorPresets() {
  let vscode =
    process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA ?? "",
          "Programs",
          "Microsoft VS Code",
          "Code.exe",
        )
      : "code";
  if (process.platform === "win32") {
    try {
      await access(vscode);
    } catch {
      vscode = "Code.exe";
    }
  }
  return [
    {
      name: "VS Code",
      executable: vscode,
      args: ["--goto", "{file}:{line}:{column}"],
    },
    {
      name: "IntelliJ IDEA",
      executable: process.platform === "win32" ? "idea64.exe" : "idea",
      args: ["--line", "{line}", "{file}"],
    },
    {
      name: "Neovim",
      executable:
        process.platform === "win32"
          ? "wt.exe"
          : process.platform === "darwin"
            ? "nvim"
            : "x-terminal-emulator",
      args:
        process.platform === "win32"
          ? ["new-tab", "nvim", "+{line}", "{file}"]
          : process.platform === "darwin"
            ? ["+{line}", "{file}"]
            : ["-e", "nvim", "+{line}", "{file}"],
    },
  ] satisfies EditorConfig[];
}
export async function openEditor(
  config: EditorConfig,
  snapshot: Snapshot,
  input: {
    fileId: string;
    side: "before" | "after";
    line: number;
    column: number;
  },
) {
  const file = snapshot.files.find((f) => f.id === input.fileId);
  if (!file || file.after.kind !== "text")
    throw new Error("This snapshot has no editable working-file text.");
  const target = await containedFile(snapshot.root, file.path);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await readFile(target),
  );
  if (text !== file.after.text)
    throw new Error(
      "Working file differs from this snapshot. Refresh the review before opening a line in the editor.",
    );
  const line = input.side === "before" ? 1 : input.line;
  if (line > text.split("\n").length)
    throw new Error("Line is outside the captured working file.");
  if (/\.(cmd|bat)$/i.test(config.executable))
    throw new Error(
      "Use the editor executable (.exe) or a terminal launcher, not a shell script.",
    );
  const args = config.args.map((arg) =>
    arg.replace(
      /\{(file|line|column)\}/g,
      (_match, key: string) =>
        ({ file: target, line: String(line), column: String(input.column) })[
          key
        ]!,
    ),
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.executable, args, {
      shell: false,
      detached: true,
      windowsHide: false,
      stdio: "ignore",
      cwd: snapshot.root,
    });
    child.once("error", () =>
      reject(
        new Error(
          "Editor could not start. Configure its executable path and arguments in Editor settings.",
        ),
      ),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return { ok: true, line, historicalLine: input.side === "before" };
}
