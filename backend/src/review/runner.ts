import { z } from "zod";
import {
  providerSchema,
  type Analysis,
  type Review,
} from "../../../packages/contracts/src/index";
import { Store } from "../storage/store";
import { CredentialVault } from "../credentials/vault";
import { infer } from "../llm/providers";
import { configKey, prepare, validateAnalysis } from "./analysis";

type Job = {
  review: Review;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
};

/** Owns the single app-wide analysis slot, including pending credential reads. */
export class ReviewAnalysis {
  private job?: Job;
  private closing = false;

  constructor(
    private store: Store,
    private vault: Pick<CredentialVault, "get">,
    private provider: typeof infer = infer,
  ) {}

  manifest(sessionId: string) {
    return prepare(this.store.review(sessionId).snapshot, this.config())
      .manifest;
  }

  async start(sessionId: string, body: unknown): Promise<Review> {
    const input = z
      .object({
        snapshotId: z.string(),
        manifestId: z.string(),
        authorize: z.boolean(),
      })
      .parse(body);
    const review = this.store.review(sessionId);
    if (review.snapshot.id !== input.snapshotId)
      throw new Error("Snapshot changed. Reload this review before editing.");
    const config = this.config();
    if (!review.snapshot.files.length)
      throw new Error("No changed files to analyze.");
    if (!input.authorize)
      throw new Error(
        "Confirm this run’s input manifest before sending repository data.",
      );
    if (this.closing) throw new Error("Application is shutting down.");
    if (this.job)
      throw new Error(
        "One analysis runs at a time. Cancel or wait for the current run.",
      );
    const prepared = prepare(review.snapshot, config);
    if (input.manifestId !== prepared.manifest.id)
      throw new Error(
        "Provider configuration or snapshot changed. Preview and authorize again.",
      );

    let finish!: () => void;
    const job: Job = {
      review,
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
    };
    this.job = job;
    try {
      review.state.analysisStatus = "running";
      review.state.analysisError = undefined;
      review.state.manifest = prepared.manifest;
      this.store.saveState(review.snapshot.id, review.state);
      const token = await this.vault.get(
        configKey(config),
        this.store.setting(`credential-mode:${configKey(config)}`) === "os",
      );
      this.check(job);
      if (this.manifest(sessionId).id !== input.manifestId)
        throw new Error(
          "Provider configuration or snapshot changed. Preview and authorize again.",
        );
      if (config.provider !== "ollama" && !token)
        throw new Error(
          "The API key is unavailable. Enter it in provider settings.",
        );
      const response = this.store.review(sessionId);
      void this.execute(job, async () => {
        const results: Analysis[] = [];
        for (const batch of prepared.batches) {
          this.check(job);
          const result = await this.provider(
            config,
            token,
            batch,
            job.controller.signal,
          );
          this.check(job);
          const ids = new Set(batch.files.map((file) => file.id));
          validateAnalysis(result, {
            files: review.snapshot.files.filter((file) => ids.has(file.id)),
          });
          results.push(result);
        }
        const proposal = validateAnalysis(
          {
            cohorts: results.flatMap((result) => result.cohorts),
            findings: results.flatMap((result) => result.findings),
          },
          review.snapshot,
        );
        this.check(job);
        const latest = this.store.review(sessionId, review.snapshot.id);
        latest.state.proposal = proposal;
        latest.state.analysisStatus = "ready";
        latest.state.analysisError = undefined;
        this.store.saveState(review.snapshot.id, latest.state);
      });
      return response;
    } catch (error) {
      try {
        this.fail(job, error);
      } finally {
        this.release(job);
      }
      throw error;
    }
  }

  cancel(snapshotId: string) {
    const job = this.job;
    if (!job || job.review.snapshot.id !== snapshotId) return;
    job.controller.abort();
    this.fail(job, new Error("Analysis canceled."));
  }

  async shutdown() {
    this.closing = true;
    const job = this.job;
    if (!job) return;
    try {
      this.cancel(job.review.snapshot.id);
    } finally {
      await job.done;
    }
  }

  private config() {
    const config =
      this.store.setting<z.infer<typeof providerSchema>>("provider");
    if (!config) throw new Error("Configure an LLM provider first.");
    return config;
  }

  private check(job: Job) {
    if (job.controller.signal.aborted) throw new Error("Analysis canceled.");
    if (
      this.store.review(job.review.snapshot.sessionId).snapshot.id !==
      job.review.snapshot.id
    ) {
      job.controller.abort();
      throw new Error("Snapshot changed. Analysis canceled.");
    }
  }

  private fail(job: Job, error: unknown) {
    const latest = this.store.review(
      job.review.snapshot.sessionId,
      job.review.snapshot.id,
    );
    latest.state.analysisStatus = job.controller.signal.aborted
      ? "canceled"
      : "failed";
    latest.state.analysisError =
      error instanceof Error ? error.message : "Analysis failed.";
    this.store.saveState(job.review.snapshot.id, latest.state);
  }

  private async execute(job: Job, work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      try {
        this.fail(job, error);
      } catch (persistenceError) {
        console.error("Could not save analysis failure.", persistenceError);
      }
    } finally {
      this.release(job);
    }
  }

  private release(job: Job) {
    if (this.job === job) this.job = undefined;
    job.finish();
  }
}
