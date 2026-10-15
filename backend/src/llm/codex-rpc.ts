import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

type Message = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export const codexPermissionProfile = "leanreview_analysis";

// Never use a shell to launch the CLI, including npm's Windows command shim.
function command(): [string, string[]] {
  if (process.env.LEANREVIEW_CODEX_PATH)
    return [process.env.LEANREVIEW_CODEX_PATH, []];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const executable = path.join(
      directory,
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    if (existsSync(executable)) return [executable, []];
    if (process.platform === "win32") {
      const script = path.join(
        directory,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      if (existsSync(script)) return [process.execPath, [script]];
    }
  }
  throw new Error(
    "Codex CLI was not found. Install @openai/codex, restart LeanReview, or set LEANREVIEW_CODEX_PATH to the Codex executable.",
  );
}

export class CodexRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  readonly workspace: string;

  constructor(
    readonly home: string,
    private launch = command,
  ) {
    super();
    this.workspace = path.join(home, "empty-workspace");
  }

  async ready() {
    if (this.closed) throw new Error("Codex connection is closed.");
    if (!this.starting) {
      this.starting = this.start().catch((error) => {
        this.stop(
          error instanceof Error ? error : new Error("Could not start Codex."),
        );
        throw error;
      });
    }
    await this.starting;
  }

  private async start() {
    mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
    const [executable, prefix] = this.launch();
    const env = { ...process.env };
    // Inherited API keys, access tokens and desktop routing must never select billing/auth.
    for (const key of Object.keys(env))
      if (/^(OPENAI_|CODEX_|CHATGPT_)/i.test(key)) delete env[key];
    env.CODEX_HOME = this.home;
    const settings = [
      'forced_login_method="chatgpt"',
      'model_provider="openai"',
      'cli_auth_credentials_store="auto"',
      'approval_policy="never"',
      `default_permissions="${codexPermissionProfile}"`,
      `permissions.${codexPermissionProfile}.filesystem={${JSON.stringify(this.workspace)}="read"}`,
      `permissions.${codexPermissionProfile}.network.enabled=false`,
      // The legacy Windows restricted-token sandbox cannot enforce restricted reads.
      ...(process.platform === "win32"
        ? ['windows.sandbox="mxc"', "features.prefer_mxc=true"]
        : []),
      'web_search="disabled"',
      'history.persistence="none"',
      "features.shell_tool=false",
      "features.shell_snapshot=false",
      "features.apps=false",
      "features.remote_plugin=false",
      "features.browser_use=false",
      "features.computer_use=false",
      "features.view_image=false",
      "features.multi_agent=false",
      "features.skip_host_skill_discovery=true",
    ];
    const child = spawn(
      executable,
      [
        ...prefix,
        "app-server",
        "--listen",
        "stdio://",
        ...settings.flatMap((value) => ["-c", value]),
      ],
      {
        cwd: this.workspace,
        env,
        windowsHide: true,
        stdio: "pipe",
      },
    );
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
        this.stop(new Error("Codex returned an oversized protocol message."));
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line) as Message);
        } catch {
          this.stop(new Error("Codex returned an invalid protocol message."));
          return;
        }
      }
    });
    // Drain without logging credentials, login URLs, prompts, or repository content.
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (this.child === child)
        this.stop(new Error("Codex connection closed."));
    });
    child.on("error", () => {
      if (this.child === child)
        this.stop(
          new Error(
            "Could not start Codex CLI. Check its installation and LEANREVIEW_CODEX_PATH.",
          ),
        );
    });
    child.on("exit", () => {
      if (this.child === child)
        this.stop(new Error("Codex app-server exited. Retry to reconnect."));
    });
    await this.request("initialize", {
      clientInfo: { name: "leanreview", title: "LeanReview", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }

  request(
    method: string,
    params: unknown = {},
    timeout = 30000,
  ): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out. Retry or reconnect.`));
      }, timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private send(message: Message) {
    if (!this.child || this.child.killed)
      throw new Error("Codex is not connected.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(message: Message) {
    if (message.id !== undefined && message.method) {
      // This adapter never approves tools, permissions, or external actions.
      this.send({
        id: message.id,
        error: {
          code: -32601,
          message:
            "LeanReview supports analysis only; tool requests are disabled.",
        },
      });
      return;
    }
    if (typeof message.id === "number") {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) {
        const error = message.error;
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "number" &&
          Number.isSafeInteger(error.code)
            ? error.code
            : undefined;
        waiting.reject(
          new Error(
            code === -32600 || code === -32602
              ? `Codex ${waiting.method} rejected incompatible request settings (RPC ${code}). Update LeanReview or Codex. No API fallback was used.`
              : `Codex ${waiting.method} failed${code === undefined ? "" : ` (RPC ${code})`}. Check sign-in, subscription allowance and the selected model. No API fallback was used.`,
          ),
        );
      } else waiting.resolve(message.result);
    } else if (message.method)
      this.emit("notification", message.method, message.params);
  }

  stop(error = new Error("Codex connection closed.")) {
    const child = this.child;
    this.child = undefined;
    this.starting = undefined;
    child?.kill();
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
    this.emit("disconnected", error);
  }

  close() {
    this.closed = true;
    this.stop();
  }
}
