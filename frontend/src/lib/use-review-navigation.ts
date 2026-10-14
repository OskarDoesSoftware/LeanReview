import { useEffect, useState, useSyncExternalStore } from "react";
import { ReviewNavigation } from "./review-navigation";

export function useReviewNavigation(onError: (error: Error) => void) {
  const [navigation] = useState(() => new ReviewNavigation());
  const state = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  useEffect(() => navigation.connect(onError), [navigation, onError]);
  return { ...state, navigation };
}
