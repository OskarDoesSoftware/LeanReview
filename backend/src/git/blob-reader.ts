import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** One bounded, binary-safe Git protocol stream per scan; no filters or worktree reads. */
export class GitBlobReader {
  private child?: ChildProcessWithoutNullStreams;
  private iterator?: AsyncIterator<Buffer>;
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, Promise<Buffer>>();
  private closed = false;
  constructor(
    private root: string,
    private signal?: AbortSignal,
  ) {}
  private initialize() {
    if (this.closed || this.signal?.aborted)
      throw new Error("Git blob read canceled or closed.");
    if (this.child) return;
    this.child = spawn(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=",
        "-c",
        "diff.external=",
        "cat-file",
        "--batch-command",
      ],
      {
        cwd: this.root,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    this.iterator = this.child.stdout[Symbol.asyncIterator]();
    this.child.stderr.resume();
    this.child.on("error", () =>
      this.child?.stdout.destroy(
        new Error("Git batch process could not start."),
      ),
    );
    this.child.stdin.on("error", () =>
      this.child?.stdout.destroy(new Error("Git batch input closed.")),
    );
    this.signal?.addEventListener("abort", this.abort, { once: true });
  }
  private abort = () => {
    this.closed = true;
    this.child?.kill();
  };
  private async available() {
    if (this.offset < this.chunk.length) return;
    const next = await this.iterator!.next();
    if (next.done) throw new Error("Git batch stream closed unexpectedly.");
    this.chunk = next.value;
    this.offset = 0;
  }
  private async line() {
    const parts: Buffer[] = [];
    let length = 0;
    while (true) {
      await this.available();
      const end = this.chunk.indexOf(10, this.offset);
      const part = this.chunk.subarray(
        this.offset,
        end < 0 ? this.chunk.length : end,
      );
      parts.push(part);
      length += part.length;
      if (length > 256) throw new Error("Invalid Git batch header.");
      this.offset = end < 0 ? this.chunk.length : end + 1;
      if (end >= 0) return Buffer.concat(parts, length).toString("ascii");
    }
  }
  private async bytes(size: number) {
    const parts: Buffer[] = [];
    let remaining = size;
    while (remaining) {
      await this.available();
      const take = Math.min(remaining, this.chunk.length - this.offset);
      parts.push(this.chunk.subarray(this.offset, this.offset + take));
      this.offset += take;
      remaining -= take;
    }
    return Buffer.concat(parts, size);
  }
  private header(line: string, oid: string) {
    const [id, type, rawSize] = line.split(" "),
      size = Number(rawSize);
    if (
      id !== oid ||
      type !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      throw new Error("Pinned Git blob missing or invalid.");
    return size;
  }
  read(oid: string): Promise<Buffer> {
    if (!/^[a-f0-9]{40,64}$/.test(oid))
      return Promise.reject(new Error("Invalid pinned Git object identity."));
    const cached = this.cache.get(oid);
    if (cached) return cached;
    const task = this.queue.then(async () => {
      this.initialize();
      const timer = setTimeout(() => this.abort(), 30000);
      try {
        this.child!.stdin.write(`info ${oid}\n`);
        const size = this.header(await this.line(), oid);
        if (size > 2 * 1024 * 1024)
          throw new Error("Source exceeds 2 MiB file limit.");
        this.child!.stdin.write(`contents ${oid}\n`);
        if (this.header(await this.line(), oid) !== size)
          throw new Error("Git blob size changed unexpectedly.");
        const contents = await this.bytes(size);
        if ((await this.bytes(1))[0] !== 10)
          throw new Error("Invalid Git blob terminator.");
        return contents;
      } finally {
        clearTimeout(timer);
      }
    });
    this.queue = task.catch(() => undefined);
    this.cache.set(oid, task);
    return task;
  }
  async close() {
    this.signal?.removeEventListener("abort", this.abort);
    this.closed = true;
    this.child?.stdin.end();
    this.child?.kill();
    await this.queue.catch(() => undefined);
    this.cache.clear();
  }
}
