// Local JSON-RPC fixture. Never opens a browser or contacts OpenAI.
import readline from "node:readline";
import { appendFileSync } from "node:fs";
const [scenario, log] = process.argv.slice(2);
let signedIn = ![
  "signed-out",
  "login",
  "login-fast",
  "login-fails",
  "unsafe-login",
].includes(scenario);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => send({ method, params });
appendFileSync(
  log,
  JSON.stringify({
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(OPENAI_|CODEX_|CHATGPT_)/i.test(key),
      ),
    ),
    cwd: process.cwd(),
    args: process.argv.slice(4),
  }) + "\n",
);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(log, JSON.stringify(message) + "\n");
  if (message.id === undefined || !message.method) return;
  const { method, id, params } = message;
  const result = (value) => send({ id, result: value });
  switch (method) {
    case "initialize":
      if (scenario === "exit") return process.exit(1);
      if (scenario === "invalid-rpc")
        return process.stdout.write("invalid json\n");
      return result({ userAgent: "fixture" });
    case "account/read":
      return result({
        account: signedIn
          ? {
              type: scenario === "api-key" ? "apiKey" : "chatgpt",
              email: "reviewer@example.invalid",
              planType: "plus",
            }
          : null,
        requiresOpenaiAuth: true,
      });
    case "account/login/start":
      result({
        type: "chatgpt",
        loginId: "login-1",
        authUrl:
          scenario === "unsafe-login"
            ? "https://example.invalid/login"
            : "https://auth.openai.com/authorize?fixture=1",
      });
      if (scenario === "login-fast") {
        signedIn = true;
        notify("account/login/completed", {
          loginId: "login-1",
          success: true,
        });
      }
      if (scenario === "login" || scenario === "login-fails")
        setTimeout(() => {
          signedIn = scenario === "login";
          notify("account/login/completed", {
            loginId: "login-1",
            success: signedIn,
            error: signedIn ? null : "sensitive error",
          });
        }, 80);
      return;
    case "account/login/cancel":
      return result({ status: "canceled" });
    case "account/logout":
      signedIn = false;
      return result({});
    case "model/list":
      return result({
        data: [
          {
            model: params.cursor ? "fixture-secondary" : "fixture-codex",
            displayName: params.cursor ? "Secondary model" : "Fixture Codex",
            isDefault: !params.cursor,
          },
        ],
        nextCursor: params.cursor ? null : "page-2",
      });
    case "account/rateLimits/read":
      if (scenario === "usage-error")
        return send({ id, error: { code: -1, message: "sensitive error" } });
      return result({
        ordinaryUsageAllowed: scenario === "blocked" ? false : null,
        rateLimits:
          scenario === "unknown-usage"
            ? {}
            : {
                primary: {
                  usedPercent: scenario === "exhausted" ? 100 : 20,
                  windowDurationMins: 300,
                  resetsAt: 2000000000,
                },
              },
      });
    case "thread/start":
      return result({
        thread: { id: "thread-1" },
        modelProvider: scenario === "wrong-provider" ? "other" : "openai",
        activePermissionProfile: { id: "leanreview_analysis" },
      });
    case "turn/start": {
      if (
        params.sandboxPolicy?.type === "readOnly" &&
        params.sandboxPolicy.access
      )
        return send({
          id,
          error: {
            code: -32600,
            message:
              "Invalid request: readOnly.access is no longer supported; use permissionProfile for restricted reads",
          },
        });
      if (scenario === "turn-error")
        return send({ id, error: { code: -1, message: "sensitive error" } });
      result({ turn: { id: "turn-1", status: "inProgress", items: [] } });
      if (scenario === "hang") return;
      if (scenario === "disconnect") return process.exit(1);
      if (scenario === "tool")
        return notify("item/started", {
          threadId: "thread-1",
          item: { type: "commandExecution", id: "tool-1" },
        });
      const input = JSON.parse(params.input[0].text);
      let analysis = {
        cohorts: [
          {
            name: "Feature",
            explanation: "Related changes",
            layers: [
              {
                name: "Implementation",
                explanation: "Read changes",
                fileIds:
                  scenario === "duplicate-file"
                    ? [input.files[0].id, input.files[0].id]
                    : input.files.map((file) => file.id),
              },
            ],
          },
        ],
        findings: [],
      };
      if (params.outputSchema.properties.fileAssignments) {
        analysis = {
          fileAssignments: Object.fromEntries(
            input.files.map((file, index) => [
              file.id,
              {
                cohortName: "Feature",
                cohortExplanation: "Related changes",
                layerName: "Implementation",
                layerExplanation: "Read changes",
                readingOrder: index,
              },
            ]),
          ),
          findings: [],
        };
      }
      notify("item/completed", {
        threadId: "thread-1",
        item: {
          type: "agentMessage",
          id: "message-1",
          phase: "final_answer",
          text:
            scenario === "bad-output" ? "invalid" : JSON.stringify(analysis),
        },
      });
      return notify("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: scenario === "failed-turn" ? "failed" : "completed",
          items: [],
        },
      });
    }
    default:
      return send({
        id,
        error: { code: -32601, message: "Unsupported method" },
      });
  }
});
