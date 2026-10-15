import { useEffect, useRef } from "react";
import type { Review } from "../../../packages/contracts/src/index";
import type { ReviewNavigation } from "./review-navigation";

/** Apply validated results to the current snapshot without a second confirmation. */
export function useAutoGrouping(
  review: Review | null,
  navigating: boolean,
  navigation: ReviewNavigation,
  onError: (error: Error) => void,
) {
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (!review?.state.proposal) {
      attempted.current = null;
      return;
    }
    if (
      navigating ||
      review.snapshot.id !== review.history[0]?.id ||
      review.state.analysisStatus !== "ready"
    )
      return;
    const key = review.snapshot.id + JSON.stringify(review.state.proposal);
    if (attempted.current === key) return;
    attempted.current = key;
    void navigation
      .mutate("grouping", {
        analysis: review.state.proposal,
        acceptProposal: true,
      })
      .catch(onError);
  }, [review, navigating, navigation, onError]);
}
