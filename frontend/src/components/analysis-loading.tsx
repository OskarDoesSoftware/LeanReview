import React from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";
import type { AnalysisProgress } from "../../../packages/contracts/src/index";
import { analysisEstimate } from "../lib/analysis-progress";

export function AnalysisLoading({
  provider,
  fileCount,
  onCancel,
  progress,
}: {
  provider: string;
  fileCount: number;
  onCancel: () => Promise<void>;
  progress?: AnalysisProgress;
}) {
  const [startedAt] = React.useState(() => Date.now());
  const [now, setNow] = React.useState(() => Date.now());
  const [canceling, setCanceling] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const seconds = Math.max(
    0,
    Math.floor((now - (progress?.startedAt ?? startedAt)) / 1000),
  );
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const phase = progress
    ? {
        preparing: "Preparing review input…",
        connecting: `Connecting to ${provider}…`,
        "checking-account": "Checking sign-in and subscription allowance…",
        analyzing: `Analyzing batch ${Math.min(progress.completedBatches + 1, progress.totalBatches)} of ${progress.totalBatches}…`,
        validating: "Checking the model's file assignments and findings…",
        combining: "Combining batches and validating the proposal…",
      }[progress.phase]
    : "Building your review proposal…";
  async function cancel() {
    setCanceling(true);
    setError("");
    try {
      await onCancel();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not cancel analysis. Try again.",
      );
      setCanceling(false);
    }
  }
  return (
    <section
      className="analysis-loading"
      aria-label="AI analysis in progress"
      aria-busy="true"
    >
      <div className="analysis-loading-content">
        <LoaderCircle
          size={24}
          className="analysis-loading-spinner"
          aria-hidden="true"
        />
        <div>
          <p className="analysis-loading-title" role="status">
            {canceling ? "Canceling analysis…" : phase}
          </p>
          <p className="analysis-loading-description">
            {provider} is organizing {fileCount} changed{" "}
            {fileCount === 1 ? "file" : "files"} into review groups and checking
            for findings.
          </p>
          <p className="analysis-loading-description">
            {progress
              ? analysisEstimate(progress, now)
              : seconds >= 30
                ? "Still working. Larger reviews can take a few minutes. You can keep reading the diff."
                : "This can take a few minutes. You can keep reading the diff."}
          </p>
          {progress && (
            <>
              <p className="analysis-loading-description">
                {progress.completedBatches} / {progress.totalBatches} batches
                checked · {progress.completedFiles} / {progress.totalFiles}{" "}
                files processed
              </p>
              {progress.estimatedRemainingMs !== null && (
                <p className="analysis-loading-description">
                  Estimate based on completed batches; model response times
                  vary.
                </p>
              )}
              {progress.currentFiles.length > 0 && (
                <details className="analysis-batch-details">
                  <summary>
                    Files in this batch ({progress.currentFiles.length})
                  </summary>
                  <ul>
                    {progress.currentFiles.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="analysis-loading-description">
                You can keep reading the diff.
              </p>
            </>
          )}
        </div>
        <span
          className="analysis-loading-elapsed"
          aria-label={`Elapsed time ${elapsed}`}
        >
          {elapsed} elapsed
        </span>
        <Button
          variant="outline"
          disabled={canceling}
          onClick={() => void cancel()}
        >
          {canceling ? "Canceling…" : "Cancel analysis"}
        </Button>
      </div>
      <div
        className={`analysis-loading-track${progress ? " is-determinate" : ""}`}
        role={progress ? "progressbar" : undefined}
        aria-hidden={progress ? undefined : true}
        aria-label={progress ? "Analysis batches completed" : undefined}
        aria-valuenow={progress?.completedBatches}
        aria-valuemin={progress ? 0 : undefined}
        aria-valuemax={progress?.totalBatches}
      >
        <div
          style={
            progress
              ? {
                  width: `${(progress.completedBatches / Math.max(1, progress.totalBatches)) * 100}%`,
                }
              : undefined
          }
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </section>
  );
}
