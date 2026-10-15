import React from "react";
import type { Review, Draft } from "../../../packages/contracts/src";
import { api } from "../lib/api";
import type { CommentAnchor } from "../lib/review-navigation";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";
import { ReviewDialog } from "./review-dialog";
import { DialogTitle } from "./ui/dialog";

type Comment = {
  databaseId?: string | number;
  id?: number;
  body: string;
  author?: { login: string };
  user?: { login: string };
};
type Thread = {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: Comment[];
};
type Discussions = {
  threads: Thread[];
  comments: Comment[];
  reviews?: Comment[];
};
type Preview = { decision: string; drafts: Draft[]; headSha: string };

export function GitHubReview({
  review,
  active,
  anchor,
  onChanged,
}: {
  review: Review;
  active: boolean;
  anchor: CommentAnchor | null;
  onChanged: () => Promise<unknown>;
}) {
  const source = review.snapshot.source!;
  const base = `/sessions/${review.snapshot.sessionId}`;
  const [discussions, setDiscussions] = React.useState<Discussions>();
  const [newCommits, setNewCommits] = React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [feedback, setFeedback] = React.useState("");
  const [replyTo, setReplyTo] = React.useState<string | number>();
  const [selected, setSelected] = React.useState<string[]>(
    review.state.drafts.map((d) => d.id),
  );
  const [decision, setDecision] = React.useState("COMMENT");
  const [preview, setPreview] = React.useState<Preview>();
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState("");
  const submissionId = React.useRef(crypto.randomUUID());
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const loadDiscussions = async () =>
    setDiscussions(await api<Discussions>(base + "/github/discussions"));
  React.useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        const result = await api<{ newCommits: boolean }>(
          base + "/github/status",
        );
        if (live) setNewCommits(result.newCommits);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void check();
    const timer = setInterval(() => void check(), 30000);
    setDiscussions(undefined);
    setPreview(undefined);
    setSelected(review.state.drafts.map((d) => d.id));
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [review.snapshot.id]);
  const payload = {
    snapshotId: review.snapshot.id,
    draftIds: selected.filter((id) =>
      review.state.drafts.some((draft) => draft.id === id),
    ),
    decision,
    message,
    submissionId: submissionId.current,
  };
  const clean = (body: string) =>
    body.replace(/\n*<!-- leanreview:[^>]*-->/g, "");
  return (
    <section className="github-review" aria-label="Pull request review">
      <div className="flex gap-2 items-center flex-wrap">
        <h2>
          #{source.pullNumber} {source.title}
        </h2>
        <a href={source.url} target="_blank" rel="noreferrer">
          Open on GitHub
        </a>
      </div>
      {newCommits && (
        <p role="status">
          New commits available. Refresh the snapshot when ready. Your current
          diff stays fixed.
        </p>
      )}
      {!review.snapshot.complete && (
        <p role="alert">
          Incomplete change set. Review completion and publication are
          unavailable.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {result && <p role="status">{result}</p>}
      <details>
        <summary>PR description</summary>
        <p className="comment-body">
          {source.body || "No description provided."}
        </p>
        {review.state.githubSubmissions
          ?.filter((s) => s.status === "failed")
          .map((s) => (
            <p className="small muted" key={s.id}>
              An earlier submission was rejected by GitHub. Its unsent drafts
              remain local and can be selected for a new submission.
            </p>
          ))}
      </details>
      <details
        onToggle={(e) => {
          if (e.currentTarget.open && !discussions && !busy)
            void run(loadDiscussions);
        }}
      >
        <summary>
          Discussions and local drafts ({review.state.drafts.length})
        </summary>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run(loadDiscussions)}
        >
          Refresh discussions
        </Button>
        {discussions?.comments.map((c) => (
          <article key={c.id}>
            <strong>{c.user?.login}</strong>
            <p className="comment-body">{clean(c.body)}</p>
          </article>
        ))}
        {discussions?.reviews
          ?.filter((c) => clean(c.body).trim())
          .map((c) => (
            <article key={"review-" + c.id}>
              <strong>{c.user?.login}</strong>
              <p className="comment-body">{clean(c.body)}</p>
            </article>
          ))}
        {discussions?.threads.map((thread) => (
          <article key={thread.id}>
            <h3>
              {thread.path}
              {thread.line ? `:${thread.line}` : ""} ·{" "}
              {thread.isResolved ? "Resolved" : "Open"}
              {thread.isOutdated ? " · Outdated" : ""}
            </h3>
            {thread.comments.map((c) => (
              <div key={c.databaseId}>
                <strong>{c.author?.login}</strong>
                <p className="comment-body">{clean(c.body)}</p>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy || !active}
                onClick={() => {
                  setReplyTo(thread.comments[0]?.databaseId);
                  setFeedback("");
                }}
              >
                Draft reply
              </Button>
              <Button
                variant="outline"
                disabled={busy || !active}
                onClick={() =>
                  void run(async () => {
                    await api(base + "/github/resolve", {
                      snapshotId: review.snapshot.id,
                      threadId: thread.id,
                      resolved: !thread.isResolved,
                    });
                    await loadDiscussions();
                    setResult(
                      thread.isResolved
                        ? "Discussion reopened on GitHub."
                        : "Discussion resolved on GitHub.",
                    );
                  })
                }
              >
                {thread.isResolved
                  ? "Reopen on GitHub now"
                  : "Resolve on GitHub now"}
              </Button>
            </div>
          </article>
        ))}
        {active && (
          <article>
            <h3>{replyTo ? "Draft reply" : "Draft inline comment"}</h3>
            <p className="small muted">
              {replyTo
                ? "Reply stays local until you submit it."
                : anchor
                  ? `Selected ${anchor.side} line ${anchor.line}. This draft stays local until submission.`
                  : "Select a diff line, then write your comment."}
            </p>
            {replyTo && (
              <Button variant="ghost" onClick={() => setReplyTo(undefined)}>
                Switch to inline comment
              </Button>
            )}
            <label>
              Draft feedback
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </label>
            <Button
              disabled={busy || !feedback.trim() || (!replyTo && !anchor)}
              onClick={() =>
                void run(async () => {
                  const response = await api<Review>(
                    base + (replyTo ? "/github/reply-draft" : "/drafts"),
                    {
                      snapshotId: review.snapshot.id,
                      ...anchor,
                      text: feedback,
                      ...(replyTo ? { replyTo } : {}),
                    },
                  );
                  setSelected((prior) => [
                    ...new Set([
                      ...prior,
                      ...response.state.drafts
                        .filter(
                          (draft) =>
                            !review.state.drafts.some(
                              (prior) => prior.id === draft.id,
                            ),
                        )
                        .map((draft) => draft.id),
                    ]),
                  ]);
                  setFeedback("");
                  setReplyTo(undefined);
                  await onChanged();
                })
              }
            >
              Save local draft
            </Button>
          </article>
        )}
        <h3>Choose drafts to submit</h3>
        {review.state.drafts.map((draft) => (
          <article key={draft.id}>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={selected.includes(draft.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, draft.id]
                      : selected.filter((id) => id !== draft.id),
                  )
                }
              />
              {draft.replyTo
                ? "Reply"
                : `${draft.path}:${draft.line} (${draft.side})`}
            </label>
            <p className="comment-body">{draft.text}</p>
            {draft.needsReattachment && (
              <>
                <p className="small">
                  Position needs checking after refresh. Select the right diff
                  line to reattach this draft.
                </p>
                <Button
                  variant="outline"
                  disabled={busy || !active || (!anchor && !draft.replyTo)}
                  onClick={() =>
                    void run(async () => {
                      await api(base + "/github/check-draft", {
                        snapshotId: review.snapshot.id,
                        draftId: draft.id,
                        ...anchor,
                      });
                      await onChanged();
                    })
                  }
                >
                  Confirm checked position
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              disabled={busy || !active}
              onClick={() =>
                void run(async () => {
                  await api(
                    base + `/drafts/${draft.id}`,
                    { snapshotId: review.snapshot.id },
                    "DELETE",
                  );
                  setSelected((ids) => ids.filter((id) => id !== draft.id));
                  await onChanged();
                })
              }
            >
              Delete local draft
            </Button>
          </article>
        ))}
        <label>
          Review decision
          <NativeSelect
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            disabled={!active}
          >
            <option value="COMMENT">Comments only</option>
            <option value="APPROVE">Approve</option>
            <option value="REQUEST_CHANGES">Request changes</option>
          </NativeSelect>
        </label>
        <label>
          Review summary
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <Button
          disabled={
            busy ||
            !active ||
            !review.snapshot.complete ||
            (decision === "COMMENT" && !selected.length && !message.trim())
          }
          onClick={() =>
            void run(async () =>
              setPreview(await api(base + "/github/preview", payload)),
            )
          }
        >
          Preview submission
        </Button>
        {review.state.githubSubmissions
          ?.filter((s) => s.status === "sending" || s.status === "uncertain")
          .map((s) => (
            <article key={s.id}>
              <p>
                A submission has an uncertain result. Confirmed drafts were
                removed; unsent or uncertain drafts remain local.
              </p>
              <Button
                disabled={busy}
                variant="outline"
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ status: string }>(
                      base + "/github/publish",
                      { ...payload, submissionId: s.id },
                    );
                    setResult(
                      result.status === "complete"
                        ? "Submission confirmed on GitHub."
                        : "Still uncertain. Check GitHub before taking further action. No feedback was resent.",
                    );
                    await onChanged();
                  })
                }
              >
                Reconcile with GitHub
              </Button>
            </article>
          ))}
      </details>
      {preview && (
        <ReviewDialog
          labelledBy="submission-title"
          onClose={() => {
            if (!busy) setPreview(undefined);
          }}
        >
          <DialogTitle id="submission-title">
            Submit review to GitHub?
          </DialogTitle>
          <p>
            {source.fullName} #{source.pullNumber} · {preview.decision}
          </p>
          <p className="small muted">
            Revision {preview.headSha.slice(0, 8)}. Only the selected drafts
            below will be published.
          </p>
          {preview.drafts.map((draft) => (
            <article key={draft.id}>
              <strong>
                {draft.replyTo ? "Reply" : `${draft.path}:${draft.line}`}
              </strong>
              <p className="comment-body">{draft.text}</p>
            </article>
          ))}
          <p>{message}</p>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => setPreview(undefined)}
            >
              Keep drafts local
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ status: string }>(
                    base + "/github/publish",
                    payload,
                  );
                  setResult(
                    result.status === "complete"
                      ? "Review submitted to GitHub."
                      : result.status === "failed"
                        ? "GitHub rejected part of the submission. Confirmed feedback was removed; unsent drafts remain local for retry."
                        : "Submission result is uncertain. Drafts are preserved. Reconcile before retrying.",
                  );
                  setPreview(undefined);
                  submissionId.current = crypto.randomUUID();
                  await onChanged();
                  await loadDiscussions();
                })
              }
            >
              Submit to GitHub
            </Button>
          </div>
        </ReviewDialog>
      )}
    </section>
  );
}
