import { it, expect } from "vitest";
import { nextUnreviewed } from "../frontend/src/lib/navigation";
import {
  emptyState,
  type Snapshot,
  type Review,
} from "../packages/contracts/src/index";
it("advances in accepted reading order, skipping reviewed files, and stops when complete", () => {
  const review: Review = {
    snapshot: {
      id: "snapshot",
      sessionId: "review",
      root: "",
      capturedAt: "",
      comparison: { mode: "all", base: "main" },
      head: null,
      base: null,
      files: [],
      complete: true,
    },
    history: [],
    state: {
      ...emptyState(),
      reviewed: ["c", "a"],
      accepted: {
        cohorts: [
          {
            name: "Concern",
            explanation: "",
            layers: [
              { name: "First", explanation: "", fileIds: ["c", "a"] },
              { name: "Next", explanation: "", fileIds: ["b"] },
            ],
          },
        ],
        findings: [],
      },
    },
  };
  expect(nextUnreviewed(review, "c")).toBe("b");
  review.state.reviewed.push("b");
  expect(nextUnreviewed(review, "b")).toBeUndefined();
});
