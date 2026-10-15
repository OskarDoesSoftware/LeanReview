import type { AnalysisProgress } from "../../../packages/contracts/src/index";

export function analysisEstimate(progress: AnalysisProgress, now: number) {
  if (progress.phase === "combining") return "Finishing the combined proposal…";
  if (progress.estimatedRemainingMs === null)
    return "Estimating wait after the first batch completes…";
  const elapsed = Math.max(0, now - progress.updatedAt);
  const lower = Math.max(0, progress.estimatedRemainingMs * 0.65 - elapsed);
  const upper = progress.estimatedRemainingMs * 1.5 - elapsed;
  if (upper <= 0)
    return "Taking longer than estimated. Still waiting for the provider…";
  if (upper < 60000) {
    const low = Math.max(5, Math.ceil(lower / 5000) * 5);
    const high = Math.max(low, Math.ceil(upper / 5000) * 5);
    return low === high
      ? `About ${high}s remaining`
      : `About ${low}–${high}s remaining`;
  }
  const low = Math.max(1, Math.ceil(lower / 60000));
  const high = Math.max(low, Math.ceil(upper / 60000));
  return low === high
    ? `About ${high} min remaining`
    : `About ${low}–${high} min remaining`;
}
