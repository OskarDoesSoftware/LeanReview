import type express from "express";
import { z } from "zod";
import { Store } from "../storage/store";
import { GraphService } from "../graph/service";
import { graphOptionsSchema } from "../../../packages/contracts/src/graph";
export function mountGraphs(app: express.Express, store: Store) {
  const service = new GraphService(store);
  const side = (value: unknown) =>
    z.enum(["before", "after"]).parse(value ?? "after");
  app.get("/api/sessions/:id/graph", (req, res) => {
    const review = store.review(
      String(req.params.id),
      z.string().parse(req.query.snapshot),
    );
    res.json(
      service.view(
        review.snapshot,
        side(req.query.side),
        req.query.statusOnly === "1",
      ),
    );
  });
  app.post("/api/sessions/:id/graph", (req, res) => {
    const input = z
      .object({ snapshotId: z.string(), options: graphOptionsSchema })
      .parse(req.body);
    const review = store.review(String(req.params.id), input.snapshotId);
    res.status(202).json(service.start(review.snapshot, input.options));
  });
  app.post("/api/sessions/:id/graph/cancel", (req, res) => {
    const input = z.object({ snapshotId: z.string() }).parse(req.body);
    const review = store.review(String(req.params.id), input.snapshotId);
    service.cancel(review.snapshot.id);
    res.json({ ok: true });
  });
  app.get("/api/sessions/:id/graph/source", (req, res) => {
    const review = store.review(
      String(req.params.id),
      z.string().parse(req.query.snapshot),
    );
    res.json(
      service.source(
        review.snapshot,
        side(req.query.side),
        z.string().parse(req.query.node),
      ),
    );
  });
  return service;
}
