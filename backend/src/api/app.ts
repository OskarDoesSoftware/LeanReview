import express from "express";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  comparisonSchema,
  providerSchema,
  type Analysis,
} from "../../../packages/contracts/src/index";
import { captureSnapshot, selectRepository } from "../git/local";
import { Store } from "../storage/store";
import { CredentialVault } from "../credentials/vault";
import { prepare, configKey, validateAnalysis } from "../review/analysis";
import { infer } from "../llm/providers";
import {
  editorSchema,
  editorPresets,
  openEditor,
  type EditorConfig,
} from "./editor";
export function createApp(
  store: Store,
  origin: string,
  nonce = randomBytes(32).toString("hex"),
) {
  const app = express();
  const vault = new CredentialVault();
  const browserSession = randomBytes(32).toString("hex");
  let bootstrapExpires = Date.now() + 5 * 60 * 1000;
  const jobs = new Map<string, AbortController>();
  const safeEqual = (a: string, b: string) => {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const allowedHosts = new Set([
      new URL(origin).host,
      "127.0.0.1:4318",
      "localhost:4318",
    ]);
    if (!allowedHosts.has(req.headers.host ?? ""))
      return res.status(403).json({ error: "Invalid local host." });
    if (req.headers.origin && req.headers.origin !== origin)
      return res.status(403).json({ error: "Cross-origin request rejected." });
    if (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== origin)
      return res.status(403).json({ error: "Same-origin request required." });
    if (req.path === "/session" && req.method === "POST") return next();
    const cookie =
      req.headers.cookie
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("leanreview="))
        ?.slice("leanreview=".length) ?? "";
    if (!safeEqual(cookie, browserSession))
      return res.status(401).json({
        error:
          "Open LeanReview using its startup link to establish a local session.",
      });
    next();
  });
  app.post("/api/session", (req, res) => {
    const candidate = z.object({ nonce: z.string() }).parse(req.body).nonce;
    if (Date.now() > bootstrapExpires || !safeEqual(candidate, nonce))
      return res.status(403).json({
        error:
          "Startup link expired or already used. Restart LeanReview for a new link.",
      });
    bootstrapExpires = 0;
    res.cookie("leanreview", browserSession, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  });
  app.get("/api/sessions", (_req, res) => res.json(store.sessions()));
  app.post("/api/sessions", async (req, res) => {
    const input = z
      .object({ root: z.string().min(1), comparison: comparisonSchema })
      .parse(req.body);
    const root = await selectRepository(input.root);
    const snapshot = await captureSnapshot(
      root,
      input.comparison,
      randomUUID(),
    );
    res.json(store.create(snapshot));
  });
  app.get("/api/sessions/:id", (req, res) =>
    res.json(
      store.review(
        String(req.params.id),
        typeof req.query.snapshot === "string" ? req.query.snapshot : undefined,
      ),
    ),
  );
  function current(id: string, body: unknown) {
    const { snapshotId } = z.object({ snapshotId: z.string() }).parse(body);
    const review = store.review(id);
    if (review.snapshot.id !== snapshotId)
      throw new Error("Snapshot changed. Reload this review before editing.");
    return review;
  }
  app.post("/api/sessions/:id/refresh", async (req, res) => {
    const review = current(String(req.params.id), req.body);
    jobs.get(review.snapshot.id)?.abort();
    const next = await captureSnapshot(
      review.snapshot.root,
      review.snapshot.comparison,
      review.snapshot.sessionId,
    );
    // A second concurrent refresh must not replace a newer snapshot.
    current(String(req.params.id), req.body);
    res.json(store.refresh(next));
  });
  app.post("/api/sessions/:id/progress", (req, res) => {
    const review = current(String(req.params.id), req.body);
    const input = z
      .object({ fileIds: z.array(z.string()), reviewed: z.boolean() })
      .parse(req.body);
    const known = new Set(review.snapshot.files.map((f) => f.id));
    if (input.fileIds.some((id) => !known.has(id)))
      throw new Error("Unknown file in progress update.");
    const ids = new Set(review.state.reviewed);
    input.fileIds.forEach((id) =>
      input.reviewed ? ids.add(id) : ids.delete(id),
    );
    review.state.reviewed = [...ids];
    store.saveState(review.snapshot.id, review.state);
    res.json(store.review(review.snapshot.sessionId));
  });
  app.post("/api/sessions/:id/grouping", (req, res) => {
    const review = current(String(req.params.id), req.body);
    review.state.accepted = validateAnalysis(
      req.body.analysis,
      review.snapshot,
    );
    if (req.body.acceptProposal) review.state.proposal = null;
    store.saveState(review.snapshot.id, review.state);
    res.json(store.review(review.snapshot.sessionId));
  });
  app.post("/api/sessions/:id/drafts", (req, res) => {
    const review = current(String(req.params.id), req.body);
    const input = z
      .object({
        fileId: z.string(),
        side: z.enum(["before", "after"]),
        line: z.number().int().positive(),
        text: z.string().trim().min(1).max(10000),
      })
      .parse(req.body);
    const file = review.snapshot.files.find((f) => f.id === input.fileId);
    const content = file?.[input.side];
    if (
      !file ||
      content?.kind !== "text" ||
      input.line > content.text.split("\n").length
    )
      throw new Error("Comment location is outside captured text.");
    review.state.drafts.push({
      ...input,
      id: randomUUID(),
      path: file.path,
      needsReattachment: false,
    });
    store.saveState(review.snapshot.id, review.state);
    res.json(store.review(review.snapshot.sessionId));
  });
  app.delete("/api/sessions/:id/drafts/:draft", (req, res) => {
    const review = current(String(req.params.id), req.body);
    review.state.drafts = review.state.drafts.filter(
      (d) => d.id !== req.params.draft,
    );
    store.saveState(review.snapshot.id, review.state);
    res.json(store.review(review.snapshot.sessionId));
  });
  app.get("/api/provider", (_req, res) => res.json(store.setting("provider")));
  app.get("/api/editor", async (_req, res) =>
    res.json({
      config: store.setting("editor"),
      presets: await editorPresets(),
    }),
  );
  app.post("/api/editor", (req, res) => {
    const config = editorSchema.parse(req.body);
    store.setSetting("editor", config);
    res.json(config);
  });
  app.post("/api/sessions/:id/open-editor", async (req, res) => {
    const review = current(String(req.params.id), req.body);
    const config = store.setting<EditorConfig>("editor");
    if (!config) throw new Error("Configure a default editor first.");
    const input = z
      .object({
        fileId: z.string(),
        side: z.enum(["before", "after"]),
        line: z.number().int().positive(),
        column: z.number().int().positive().default(1),
      })
      .parse(req.body);
    res.json(await openEditor(config, review.snapshot, input));
  });
  app.post("/api/provider", async (req, res) => {
    const config = providerSchema.parse(req.body.config);
    const url = new URL(config.endpoint);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error(
        "Use HTTPS, or HTTP for a loopback endpoint, without embedded credentials.",
      );
    if (config.maxOutput >= config.contextWindow)
      throw new Error(
        "Output reservation must be smaller than the context window.",
      );
    if (
      config.localOnly &&
      (config.provider !== "ollama" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        config.model.includes(":cloud"))
    )
      throw new Error(
        "Local-only mode requires loopback Ollama and a local model with cloud features disabled.",
      );
    const token = z.string().max(10000).optional().parse(req.body.token);
    const persist = z.boolean().parse(req.body.persist);
    if (token) {
      await vault.set(configKey(config), token, persist);
      store.setSetting(
        `credential-mode:${configKey(config)}`,
        persist ? "os" : "session",
      );
    }
    store.setSetting("provider", config);
    res.json({ config });
  });
  app.get("/api/sessions/:id/manifest", (req, res) => {
    const review = store.review(String(req.params.id));
    const config = store.setting<z.infer<typeof providerSchema>>("provider");
    if (!config) throw new Error("Configure an LLM provider first.");
    res.json(prepare(review.snapshot, config).manifest);
  });
  app.post("/api/sessions/:id/analysis", async (req, res) => {
    const review = current(String(req.params.id), req.body);
    const config = store.setting<z.infer<typeof providerSchema>>("provider");
    if (!config) throw new Error("Configure an LLM provider first.");
    if (!review.snapshot.files.length)
      throw new Error("No changed files to analyze.");
    const authorize = z.boolean().parse(req.body.authorize);
    if (!authorize)
      throw new Error(
        "Confirm this run’s input manifest before sending repository data.",
      );
    if (jobs.size)
      throw new Error(
        "One analysis runs at a time. Cancel or wait for the current run.",
      );
    const prepared = prepare(review.snapshot, config);
    if (req.body.manifestId !== prepared.manifest.id)
      throw new Error(
        "Provider configuration or snapshot changed. Preview and authorize again.",
      );
    const token = await vault.get(
      configKey(config),
      store.setting(`credential-mode:${configKey(config)}`) === "os",
    );
    if (config.provider !== "ollama" && !token)
      throw new Error(
        "The API key is unavailable. Enter it in provider settings.",
      );
    const controller = new AbortController();
    jobs.set(review.snapshot.id, controller);
    review.state.analysisStatus = "running";
    review.state.analysisError = undefined;
    review.state.manifest = prepared.manifest;
    store.saveState(review.snapshot.id, review.state);
    res.status(202).json(store.review(review.snapshot.sessionId));
    void (async () => {
      try {
        const results: Analysis[] = [];
        for (const batch of prepared.batches) {
          const result = await infer(config, token, batch, controller.signal);
          const batchIds = new Set(batch.files.map((f) => f.id));
          validateAnalysis(result, {
            files: review.snapshot.files.filter((f) => batchIds.has(f.id)),
          });
          results.push(result);
        }
        if (controller.signal.aborted) throw new Error("Canceled");
        const proposal = validateAnalysis(
          {
            cohorts: results.flatMap((r) => r.cohorts),
            findings: results.flatMap((r) => r.findings),
          },
          review.snapshot,
        );
        const latest = store.review(
          review.snapshot.sessionId,
          review.snapshot.id,
        );
        latest.state.proposal = proposal;
        latest.state.analysisStatus = "ready";
        store.saveState(review.snapshot.id, latest.state);
      } catch (error) {
        const latest = store.review(
          review.snapshot.sessionId,
          review.snapshot.id,
        );
        latest.state.analysisStatus = controller.signal.aborted
          ? "canceled"
          : "failed";
        latest.state.analysisError =
          error instanceof Error ? error.message : "Analysis failed.";
        store.saveState(review.snapshot.id, latest.state);
      } finally {
        jobs.delete(review.snapshot.id);
      }
    })();
  });
  app.post("/api/sessions/:id/cancel", (req, res) => {
    const review = current(String(req.params.id), req.body);
    jobs.get(review.snapshot.id)?.abort();
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API endpoint not found." }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Request failed.",
      });
    },
  );
  return { app, nonce, abort: () => jobs.forEach((job) => job.abort()) };
}
