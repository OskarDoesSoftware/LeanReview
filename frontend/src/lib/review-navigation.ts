import type {
  Comparison,
  Manifest,
  Review,
} from "../../../packages/contracts/src/index";
import { api } from "./api";
import { nextUnreviewed } from "./navigation";

export type CommentAnchor = {
  fileId: string;
  side: "before" | "after";
  line: number;
};
export type NavigationState = {
  review: Review | null;
  selected: string;
  anchor: CommentAnchor | null;
  comment: string;
  navigating: boolean;
  manifest: Manifest | null;
};

/** Responses belong to a selection, even while its replacement is loading. */
export class ReviewNavigation {
  private state: NavigationState = {
    review: null,
    selected: "",
    anchor: null,
    comment: "",
    navigating: false,
    manifest: null,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private revision = 0;
  private pending = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private connected = false;
  private onError: (error: Error) => void = () => {};

  constructor(private request: typeof api = api) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  connect(onError: (error: Error) => void) {
    this.connected = true;
    this.onError = onError;
    this.schedule();
    return () => {
      this.connected = false;
      ++this.epoch;
      this.clearTimer();
    };
  }

  navigate(sessionId: string, snapshotId?: string) {
    return this.load(
      `/sessions/${sessionId}${snapshotId ? `?snapshot=${snapshotId}` : ""}`,
    );
  }

  open(root: string, comparison: Comparison) {
    return this.load("/sessions", { root, comparison });
  }

  async previewAnalysis() {
    const review = this.state.review,
      epoch = this.epoch,
      revision = this.revision;
    if (!review || this.state.navigating) return;
    try {
      const manifest = await this.request<Manifest>(
        `/sessions/${review.snapshot.sessionId}/manifest`,
      );
      if (epoch !== this.epoch || revision !== this.revision) return;
      if (manifest.snapshotId !== review.snapshot.id)
        throw new Error("Snapshot changed; preview again.");
      this.patch({ manifest });
    } catch (error) {
      if (epoch === this.epoch && revision === this.revision) throw error;
    }
  }
  closeManifest() {
    this.patch({ manifest: null });
  }

  async mutate(
    route: string,
    body: object,
    options: {
      method?: string;
      advance?: boolean;
      clearComment?: boolean;
    } = {},
  ) {
    const review = this.state.review;
    if (!review || this.state.navigating) return false;
    const epoch = this.epoch,
      revision = ++this.revision;
    const selected = this.state.selected;
    const anchor = this.state.anchor,
      comment = this.state.comment;
    ++this.pending;
    this.clearTimer();
    try {
      const next = await this.request<Review>(
        `/sessions/${review.snapshot.sessionId}/${route}`,
        {
          ...body,
          snapshotId: review.snapshot.id,
        },
        options.method,
      );
      if (epoch !== this.epoch || revision !== this.revision) return false;
      if (
        next.snapshot.sessionId !== review.snapshot.sessionId ||
        (route !== "refresh" && next.snapshot.id !== review.snapshot.id)
      )
        throw new Error(
          "Response does not belong to the selected review snapshot.",
        );
      this.accept(next);
      if (options.advance && this.state.selected === selected) {
        const nextId = nextUnreviewed(next, selected);
        if (nextId) this.selectFile(nextId);
      }
      if (
        options.clearComment &&
        this.state.anchor === anchor &&
        this.state.comment === comment
      )
        this.patch({ comment: "", anchor: null });
      if (route === "analysis") this.closeManifest();
      return true;
    } catch (error) {
      if (epoch === this.epoch && revision === this.revision) throw error;
      return false;
    } finally {
      --this.pending;
      this.schedule();
    }
  }

  selectFile(selected: string) {
    if (!this.state.review?.snapshot.files.some((file) => file.id === selected))
      return;
    if (selected !== this.state.selected)
      this.patch({ selected, anchor: null, comment: "" });
  }
  setAnchor(anchor: CommentAnchor | null) {
    if (
      anchor &&
      !this.state.review?.snapshot.files.some(
        (file) => file.id === anchor.fileId,
      )
    )
      return;
    this.patch({ anchor });
  }
  setComment(comment: string) {
    this.patch({ comment });
  }

  async poll() {
    const review = this.state.review;
    if (!review || this.state.navigating || this.pending || this.polling)
      return;
    const epoch = this.epoch,
      revision = this.revision;
    this.polling = true;
    try {
      const next = await this.request<Review>(
        `/sessions/${review.snapshot.sessionId}?snapshot=${review.snapshot.id}`,
      );
      if (epoch !== this.epoch || revision !== this.revision || this.pending)
        return;
      if (
        next.snapshot.sessionId !== review.snapshot.sessionId ||
        next.snapshot.id !== review.snapshot.id
      )
        throw new Error(
          "Response does not belong to the selected review snapshot.",
        );
      this.accept(next);
    } catch (error) {
      if (epoch === this.epoch && revision === this.revision) throw error;
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  private async load(route: string, body?: object) {
    const epoch = ++this.epoch;
    this.clearTimer();
    this.patch({ navigating: true, anchor: null, comment: "", manifest: null });
    try {
      const next = await this.request<Review>(route, body);
      if (epoch !== this.epoch) return false;
      this.accept(next);
      return true;
    } catch (error) {
      if (epoch === this.epoch) throw error;
      return false;
    } finally {
      if (epoch === this.epoch) this.patch({ navigating: false });
    }
  }

  private accept(review: Review) {
    const sessionChanged =
      this.state.review?.snapshot.sessionId !== review.snapshot.sessionId;
    const changed =
      sessionChanged || this.state.review?.snapshot.id !== review.snapshot.id;
    const selected = review.snapshot.files.some(
      (file) => file.id === this.state.selected,
    )
      ? this.state.selected
      : (review.snapshot.files[0]?.id ?? "");
    this.patch({
      review,
      selected: sessionChanged
        ? (review.snapshot.files[0]?.id ?? "")
        : selected,
      ...(changed ? { anchor: null, comment: "", manifest: null } : {}),
    });
  }
  private patch(update: Partial<NavigationState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
    this.schedule();
  }
  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule() {
    if (
      !this.connected ||
      this.state.navigating ||
      this.pending ||
      this.polling ||
      this.state.review?.state.analysisStatus !== "running"
    ) {
      this.clearTimer();
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().catch((error) =>
        this.onError(
          error instanceof Error ? error : new Error("Review polling failed."),
        ),
      );
    }, 1000);
  }
}
