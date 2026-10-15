import { z } from "zod";
import {
  providerSchema,
  type Analysis,
  type Review,
  type AnalysisProgress,
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
      review.state.analysisProgress = {
        startedAt: Date.now(),
        updatedAt: Date.now(),
        phase: "preparing",
        completedBatches: 0,
        totalBatches: prepared.batches.length,
        completedFiles: 0,
        totalFiles: review.snapshot.files.length,
        currentFiles: [],
        estimatedRemainingMs: null,
      };
      this.store.saveState(review.snapshot.id, review.state);
      const token =
        config.provider === "codex"
          ? null
          : await this.vault.get(
              configKey(config),
              this.store.setting(`credential-mode:${configKey(config)}`) ===
                "os",
            );
      this.check(job);
      if (this.manifest(sessionId).id !== input.manifestId)
        throw new Error(
          "Provider configuration or snapshot changed. Preview and authorize again.",
        );
      if (config.provider !== "ollama" && config.provider !== "codex" && !token)
        throw new Error(
          "The API key is unavailable. Enter it in provider settings.",
        );
      const response = this.store.review(sessionId);
      void this.execute(job, async () => {
        const results: Analysis[] = [];
        const durations: number[] = [];
        let completedFiles = 0;
        for (const batch of prepared.batches) {
          this.check(job);
          const batchStartedAt = Date.now();
          this.progress(job, {
            phase: "connecting",
            currentFiles: batch.files.map((file) => file.path),
          });
          const result = await this.provider(
            config,
            token,
            batch,
            job.controller.signal,
            (phase) => this.progress(job, { phase }),
          );
          this.check(job);
          this.progress(job, { phase: "validating" });
          const ids = new Set(batch.files.map((file) => file.id));
          validateAnalysis(result, {
            files: review.snapshot.files.filter((file) => ids.has(file.id)),
          });
          results.push(result);
          durations.push(Math.max(1, Date.now() - batchStartedAt));
          completedFiles += batch.files.length;
          const remaining = prepared.batches.length - results.length;
          this.progress(job, {
            completedBatches: results.length,
            completedFiles,
            currentFiles: [],
            estimatedRemainingMs: remaining
              ? Math.round(
                  (durations.reduce((sum, duration) => sum + duration, 0) /
                    durations.length) *
                    remaining,
                )
              : null,
          });
        }
        this.progress(job, { phase: "combining", currentFiles: [] });
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

  private progress(job: Job, update: Partial<AnalysisProgress>) {
    if (this.job !== job || job.controller.signal.aborted) return;
    const latest = this.store.review(
      job.review.snapshot.sessionId,
      job.review.snapshot.id,
    );
    if (
      latest.state.analysisStatus !== "running" ||
      !latest.state.analysisProgress
    )
      return;
    const previous = latest.state.analysisProgress;
    const remaining =
      previous.estimatedRemainingMs === null
        ? null
        : Math.max(
            0,
            previous.estimatedRemainingMs - (Date.now() - previous.updatedAt),
          );
    latest.state.analysisProgress = {
      ...previous,
      estimatedRemainingMs: remaining,
      ...update,
      updatedAt: Date.now(),
    };
    this.store.saveState(job.review.snapshot.id, latest.state);
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
