import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CodexRpc } from "../backend/src/llm/codex-rpc";
import { CodexProvider } from "../backend/src/llm/codex";
import { analysisInstructions, infer } from "../backend/src/llm/providers";
import type { ProviderConfig } from "../packages/contracts/src/index";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Store } from "../backend/src/storage/store";
import { createApp } from "../backend/src/api/app";
import { snapshot } from "./compatibility/capture";
import { CredentialVault } from "../backend/src/credentials/vault";
import { validateAnalysis } from "../backend/src/review/analysis";
import { codexOutput } from "../backend/src/llm/codex-output";

const providers: CodexProvider[] = [];
afterEach(() => {
  providers.splice(0).forEach((provider) => provider.close());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const config: ProviderConfig = {
  provider: "codex",
  endpoint: "https://chatgpt.com/codex",
  model: "fixture-codex",
  contextWindow: 8192,
  maxOutput: 2048,
  localOnly: false,
};
const input = {
  files: [{ id: "file-1", path: "private.ts", diff: "private diff" }],
};
async function fixture(scenario = "success") {
  await mkdir(".leanreview-test", { recursive: true });
  const directory = await mkdtemp(path.resolve(".leanreview-test/codex-"));
  const log = path.join(directory, "protocol.jsonl");
  const rpc = new CodexRpc(path.join(directory, "profile"), () => [
    process.execPath,
    [path.resolve("tests/fixtures/codex-app-server.mjs"), scenario, log],
  ]);
  const provider = new CodexProvider(rpc);
  providers.push(provider);
  return {
    provider,
    rpc,
    log,
    messages: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}
const analyze = (
  provider: CodexProvider,
  signal = new AbortController().signal,
) => provider.infer(config, input, analysisInstructions, signal);

describe("Codex subscription adapter", () => {
  it("assigns a file exactly once even when the model would repeat it in grouping arrays", async () => {
    const f = await fixture("duplicate-file");
    const result = await analyze(f.provider);
    expect(() =>
      validateAnalysis(result, {
        files: [{ ...snapshot().files[0], id: "file-1" }],
      }),
    ).not.toThrow();
  });
  it("handles login completion arriving with the RPC response", async () => {
    const f = await fixture("login-fast");
    await f.provider.login();
    const status = await f.provider.status();
    expect(status.connected).toBe(true);
    expect(status.loginPending).toBe(false);
    await expect(analyze(f.provider)).resolves.toHaveProperty("cohorts");
  });
  it("starts an isolated ChatGPT-only process, lists all models, and keeps credentials out of status", async () => {
    vi.stubEnv("OPENAI_API_KEY", "must-not-inherit");
    vi.stubEnv("CODEX_ACCESS_TOKEN", "must-not-inherit");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid");
    const f = await fixture();
    const status = await f.provider.status();
    expect(status.connected).toBe(true);
    expect(status.models.map((entry) => entry.model)).toEqual([
      "fixture-codex",
      "fixture-secondary",
    ]);
    expect(status.limits[0].primary?.usedPercent).toBe(20);
    expect(JSON.stringify(status)).not.toContain("must-not-inherit");
    const [launch, ...messages] = await f.messages();
    expect(launch.env).toEqual({ CODEX_HOME: f.rpc.home });
    expect(launch.cwd).toBe(f.rpc.workspace);
    expect(launch.args).toContain('forced_login_method="chatgpt"');
    expect(launch.args).toContain("features.shell_tool=false");
    expect(launch.args).toContain('default_permissions="leanreview_analysis"');
    expect(launch.args).toContain(
      `permissions.leanreview_analysis.filesystem={${JSON.stringify(f.rpc.workspace)}="read"}`,
    );
    expect(launch.args).not.toContain('sandbox_mode="read-only"');
    if (process.platform === "win32")
      expect(launch.args).toContain('windows.sandbox="mxc"');
    expect(messages.map((message) => message.method)).not.toContain(
      "turn/start",
    );
  });

  it("completes browser login, reports the account, and signs out of its own profile", async () => {
    const f = await fixture("login");
    expect((await f.provider.status()).connected).toBe(false);
    expect(await f.provider.login()).toEqual({
      authUrl: "https://auth.openai.com/authorize?fixture=1",
    });
    expect((await f.provider.status()).loginPending).toBe(true);
    await vi.waitFor(async () =>
      expect((await f.provider.status()).connected).toBe(true),
    );
    expect((await f.provider.status()).loginPending).toBe(false);
    await f.provider.logout();
    expect((await f.provider.status()).connected).toBe(false);
    expect(
      (await f.messages()).find(
        (message) => message.method === "account/login/start",
      ).params,
    ).toEqual({ type: "chatgpt" });
  });

  it("can cancel a pending login and reports failed login without exposing server error details", async () => {
    const pending = await fixture("signed-out");
    await pending.provider.login();
    await pending.provider.cancelLogin();
    expect((await pending.provider.status()).loginPending).toBe(false);
    expect(
      (await pending.messages()).some(
        (message) => message.method === "account/login/cancel",
      ),
    ).toBe(true);
    const failed = await fixture("login-fails");
    await failed.provider.login();
    await vi.waitFor(async () =>
      expect((await failed.provider.status()).loginError).toContain(
        "did not finish",
      ),
    );
    expect(JSON.stringify(await failed.provider.status())).not.toContain(
      "sensitive error",
    );
  });

  it("rejects unexpected login destinations", async () => {
    const f = await fixture("unsafe-login");
    await expect(f.provider.login()).rejects.toThrow("unexpected sign-in URL");
  });

  it("returns validated structured analysis using only the supplied input and read-only ephemeral threads", async () => {
    const f = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await analyze(f.provider);
    expect(result.cohorts[0].layers[0].fileIds).toEqual(["file-1"]);
    const messages = await f.messages();
    const thread = messages.find(
      (message) => message.method === "thread/start",
    ).params;
    expect(thread).toMatchObject({
      modelProvider: "openai",
      ephemeral: true,
      approvalPolicy: "never",
      permissions: "leanreview_analysis",
      cwd: f.rpc.workspace,
    });
    const turn = messages.find(
      (message) => message.method === "turn/start",
    ).params;
    expect(turn.outputSchema).toEqual(codexOutput(input).schema);
    expect(JSON.parse(turn.input[0].text)).toEqual(input);
    expect(thread).not.toHaveProperty("sandbox");
    expect(turn.permissions).toBe("leanreview_analysis");
    expect(turn).not.toHaveProperty("sandboxPolicy");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("identifies protocol validation failures without echoing raw provider details", async () => {
    const f = await fixture();
    await f.rpc.ready();
    await expect(
      f.rpc.request("turn/start", {
        sandboxPolicy: { type: "readOnly", access: { type: "restricted" } },
      }),
    ).rejects.toThrow(
      "Codex turn/start rejected incompatible request settings (RPC -32600)",
    );
  });

  it.each([
    "signed-out",
    "api-key",
    "exhausted",
    "blocked",
    "unknown-usage",
    "usage-error",
    "wrong-provider",
  ])(
    "blocks %s before starting inference and never falls back to HTTP",
    async (scenario) => {
      const f = await fixture(scenario);
      const fetch = vi.spyOn(globalThis, "fetch");
      await expect(analyze(f.provider)).rejects.toThrow();
      expect(
        (await f.messages()).some((message) => message.method === "turn/start"),
      ).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["failed-turn", "bad-output", "disconnect", "turn-error", "tool"])(
    "fails safely for %s",
    async (scenario) => {
      const f = await fixture(scenario);
      await expect(analyze(f.provider)).rejects.toThrow();
    },
  );

  it("terminates in-flight analysis on cancellation and prevents account changes while running", async () => {
    const f = await fixture("hang");
    const controller = new AbortController();
    const result = analyze(f.provider, controller.signal);
    const rejected = expect(result).rejects.toThrow("canceled");
    await vi.waitFor(async () =>
      expect(
        (await f.messages()).some((message) => message.method === "turn/start"),
      ).toBe(true),
    );
    await expect(f.provider.logout()).rejects.toThrow("cancel analysis first");
    controller.abort();
    await rejected;
    // Status restarts the failed process without losing the adapter object.
    expect((await f.provider.status()).connected).toBe(true);
  });

  it.each(["exit", "invalid-rpc"])(
    "rejects requests when startup produces %s",
    async (scenario) => {
      const f = await fixture(scenario);
      await expect(f.provider.status()).rejects.toThrow();
    },
  );

  it("never routes subscription configuration into the HTTP provider adapter", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      infer(config, "some-api-key", input, new AbortController().signal),
    ).rejects.toThrow("app-server");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Codex protected review flow", () => {
  let server: Server | undefined;
  let store: Store | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await shutdown?.();
    if (server)
      await new Promise<void>((resolve) => {
        server!.closeAllConnections();
        server!.close(() => resolve());
      });
    store?.close();
  });

  async function app(scenario = "success") {
    const f = await fixture(scenario);
    store = new Store(path.join(f.rpc.home, "store"));
    store.create(snapshot());
    server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const application = createApp(store, origin, "test-nonce", f.provider);
    shutdown = application.abort;
    server.on("request", application.app);
    let cookie = "";
    async function request(url: string, body?: unknown) {
      return fetch(`${origin}/api${url}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function bootstrap() {
      const response = await request("/session", { nonce: "test-nonce" });
      cookie = response.headers.get("set-cookie")!.split(";")[0];
    }
    return { ...f, request, bootstrap };
  }

  it("protects account routes and requires manifest authorization before sending snapshot data", async () => {
    const f = await app();
    for (const endpoint of [
      "/codex/status",
      "/codex/login",
      "/codex/cancel-login",
      "/codex/logout",
    ]) {
      const response = await f.request(
        endpoint,
        endpoint.endsWith("status") ? undefined : {},
      );
      expect(response.status).toBe(401);
    }
    await f.bootstrap();
    expect((await f.request("/codex/status")).status).toBe(200);
    const before = await f.messages();
    expect(before.some((message) => message.method === "turn/start")).toBe(
      false,
    );
    expect(JSON.stringify(before)).not.toContain("private.ts");
    expect(
      (
        await f.request("/provider", {
          config,
          token: "forbidden-key",
          persist: false,
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.request("/provider", { config, persist: false })).status,
    ).toBe(200);
    const manifest = await (
      await f.request("/sessions/session-fixture/manifest")
    ).json();
    const authorization = {
      snapshotId: manifest.snapshotId,
      manifestId: manifest.id,
      authorize: false,
    };
    expect(
      (await f.request("/sessions/session-fixture/analysis", authorization))
        .status,
    ).toBe(400);
    expect(
      (await f.messages()).some((message) => message.method === "turn/start"),
    ).toBe(false);
    const vault = vi.spyOn(CredentialVault.prototype, "get");
    const started = await f.request("/sessions/session-fixture/analysis", {
      ...authorization,
      authorize: true,
    });
    expect(started.status).toBe(202);
    await vi.waitFor(() =>
      expect(store!.review("session-fixture").state.analysisStatus).toBe(
        "ready",
      ),
    );
    expect(vault).not.toHaveBeenCalled();
    const state = store!.review("session-fixture").state;
    expect(state.accepted).toBeNull();
    expect(state.proposal?.cohorts[0].layers[0].fileIds).toEqual(
      snapshot().files.map((file) => file.id),
    );
  });

  it("preserves an accepted review when subscription allowance is exhausted", async () => {
    const f = await app("exhausted");
    const review = store!.review("session-fixture");
    const accepted = {
      cohorts: [
        {
          name: "Human grouping",
          explanation: "Accepted",
          layers: [
            {
              name: "Read",
              explanation: "Accepted",
              fileIds: snapshot().files.map((file) => file.id),
            },
          ],
        },
      ],
      findings: [],
    };
    review.state.accepted = accepted;
    store!.saveState(review.snapshot.id, review.state);
    await f.bootstrap();
    await f.request("/provider", { config, persist: false });
    const manifest = await (
      await f.request("/sessions/session-fixture/manifest")
    ).json();
    expect(
      (
        await f.request("/sessions/session-fixture/analysis", {
          snapshotId: manifest.snapshotId,
          manifestId: manifest.id,
          authorize: true,
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(() =>
      expect(store!.review("session-fixture").state.analysisStatus).toBe(
        "failed",
      ),
    );
    expect(store!.review("session-fixture").state.accepted).toEqual(accepted);
    expect(store!.review("session-fixture").state.analysisError).toContain(
      "allowance is exhausted",
    );
    expect(
      (await f.messages()).some((message) => message.method === "turn/start"),
    ).toBe(false);
  });
});
