import type { Review } from "../../../packages/contracts/src/index";

export function changeTarget(
  review: Review,
  fileId: string,
  starts: number[],
  line: number,
  direction: "next" | "previous",
) {
  const targetLine =
    direction === "next"
      ? starts.find((start) => start > line)
      : [...starts].reverse().find((start) => start < line);
  if (targetLine !== undefined) return { fileId, line: targetLine };
  const order = review.state.accepted
    ? review.state.accepted.cohorts.flatMap((cohort) =>
        cohort.layers.flatMap((layer) => layer.fileIds),
      )
    : review.snapshot.files.map((file) => file.id);
  const neighbor =
    order[order.indexOf(fileId) + (direction === "next" ? 1 : -1)];
  return neighbor ? { fileId: neighbor, line: null } : null;
}
