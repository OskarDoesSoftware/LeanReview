import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Immutable captured content. Reads never fall back to the working repository. */
export class CapturedArtifacts {
  constructor(private directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  read(digest: string): string {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
      throw new Error("Invalid captured artifact identity.");
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.directory, digest), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(`Captured artifact is missing: ${digest}.`);
      throw error;
    }
    if (this.digest(text) !== digest)
      throw new Error(`Captured artifact is corrupt: ${digest}.`);
    return text;
  }

  write(text: string): string {
    const digest = this.digest(text);
    const file = path.join(this.directory, digest);
    if (fs.existsSync(file)) {
      this.read(digest);
      return digest;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return digest;
  }

  private digest(text: string) {
    return createHash("sha256").update(text).digest("hex");
  }
}
