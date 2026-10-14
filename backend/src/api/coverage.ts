import express from "express";
import { z } from "zod";
import { Store } from "../storage/store";
import { CoverageRunner } from "../coverage/runner";
import { measure } from "../coverage/metrics";
import {
  provenanceSchema,
  testConfigSchema,
} from "../../../packages/contracts/src/coverage";
import type { Review } from "../../../packages/contracts/src/index";
export function mountCoverage(
  app: express.Express,
  store: Store,
  current: (id: string, body: unknown) => Review,
) {
  const runner = new CoverageRunner(store);
  const format = (value: unknown) =>
    z.enum(["istanbul", "jacoco"]).parse(value);
  app.get("/api/sessions/:id/coverage", (req, res) => {
    const review = store.review(
      String(req.params.id),
      typeof req.query.snapshot === "string" ? req.query.snapshot : undefined,
    );
    const kind = format(req.query.format ?? "istanbul");
    const config = runner.config(review.snapshot.root, kind);
    res.json({
      config,
      metrics:
        store.coverage(review.snapshot.id, kind) ??
        measure(
          review.snapshot,
          kind,
          undefined,
          undefined,
          config?.threshold ?? 8,
        ),
      run: store.latestTestRun(review.snapshot.id, kind),
    });
  });
  app.post("/api/sessions/:id/coverage/config", (req, res) => {
    const review = current(String(req.params.id), req.body);
    const config = testConfigSchema.parse(req.body.config);
    runner.saveConfig(review.snapshot.root, config);
    res.json(config);
  });
  app.post(
    "/api/sessions/:id/coverage/import",
    express.json({
      type: "application/vnd.leanreview.coverage+json",
      limit: "20mb",
    }),
    (req, res) => {
      const review = current(String(req.params.id), req.body);
      const input = z
        .object({
          format: z.enum(["istanbul", "jacoco"]),
          report: z.string().min(1),
          provenance: provenanceSchema.nullish(),
          threshold: z.number().min(0).max(1000000).default(8),
        })
        .parse(req.body);
      const metrics = measure(
        review.snapshot,
        input.format,
        input.report,
        input.provenance,
        input.threshold,
      );
      store.saveCoverage(metrics, input.report, input.provenance ?? undefined);
      res.json(metrics);
    },
  );
  app.get("/api/sessions/:id/coverage/artifact", (req, res) => {
    const review = store.review(
      String(req.params.id),
      typeof req.query.snapshot === "string" ? req.query.snapshot : undefined,
    );
    res.json(
      store.coverageArtifact(review.snapshot.id, format(req.query.format)),
    );
  });
  app.post("/api/sessions/:id/coverage/preview", async (req, res) => {
    const review = current(String(req.params.id), req.body);
    res.json(
      await runner.prepare(
        review.snapshot,
        runner.config(review.snapshot.root, format(req.body.format)),
      ),
    );
  });
  app.post("/api/sessions/:id/coverage/run", async (req, res) => {
    const review = current(String(req.params.id), req.body);
    const input = z
      .object({ previewId: z.string(), confirmed: z.literal(true) })
      .parse(req.body);
    res.status(202).json(await runner.start(review.snapshot, input.previewId));
  });
  app.post("/api/sessions/:id/coverage/cancel", (req, res) => {
    const review = current(String(req.params.id), req.body);
    const id = z.string().parse(req.body.runId);
    const run = store.testRun(id);
    if (!run || run.snapshotId !== review.snapshot.id)
      throw new Error("Test run does not belong to this snapshot.");
    runner.cancel(id);
    res.json({ ok: true });
  });
  return runner;
}
