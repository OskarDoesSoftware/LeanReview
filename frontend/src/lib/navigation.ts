import type { Review } from "../../../packages/contracts/src/index";
export function nextUnreviewed(review: Review, currentId: string) {
  const order = review.state.accepted
    ? review.state.accepted.cohorts.flatMap((c) =>
        c.layers.flatMap((l) => l.fileIds),
      )
    : review.snapshot.files.map((f) => f.id);
  const index = order.indexOf(currentId);
  return [...order.slice(index + 1), ...order.slice(0, index)].find(
    (id) => !review.state.reviewed.includes(id),
  );
}
