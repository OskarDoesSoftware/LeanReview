import React from "react";
import { createRoot } from "react-dom/client";
import { DiffEditor } from "./components/diff-editor";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";
import {
  Check,
  ChevronRight,
  GitBranch,
  FolderOpen,
  Layers,
  MessageSquare,
  RefreshCw,
  Settings,
  Sparkles,
  X,
  ShieldCheck,
  FileCode2,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Button } from "./components/ui/button";
import type {
  Analysis,
  Manifest,
  ProviderConfig,
  Review,
  SessionSummary,
} from "../../packages/contracts/src/index";
import "./style.css";
import { nextUnreviewed } from "./lib/navigation";
type EditorConfig = { name: string; executable: string; args: string[] };
(globalThis as any).MonacoEnvironment = {
  getWorker: (_id: string, label: string) =>
    label === "typescript" || label === "javascript"
      ? new TypeScriptWorker()
      : new EditorWorker(),
};
async function api<T>(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}
const initialConfig: ProviderConfig = {
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  model: "",
  contextWindow: 8192,
  maxOutput: 2048,
  localOnly: true,
};
function App({ startupError }: { startupError?: string }) {
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [review, setReview] = React.useState<Review | null>(null);
  const [root, setRoot] = React.useState("");
  const [mode, setMode] = React.useState<
    "unstaged" | "staged" | "all" | "branch"
  >("all");
  const [base, setBase] = React.useState("main");
  const [selected, setSelected] = React.useState("");
  const [tab, setTab] = React.useState("Explanation");
  const [split, setSplit] = React.useState(true);
  const [error, setError] = React.useState(startupError ?? "");
  const [busy, setBusy] = React.useState(false);
  const [settings, showSettings] = React.useState(false);
  const [config, setConfig] = React.useState(initialConfig);
  const [token, setToken] = React.useState("");
  const [editorConfig, setEditorConfig] = React.useState<EditorConfig | null>(
    null,
  );
  const [editorDraft, setEditorDraft] = React.useState<EditorConfig>({
    name: "Custom editor",
    executable: "",
    args: ["{file}"],
  });
  const [editorArgs, setEditorArgs] = React.useState('["{file}"]');
  const [editorPresets, setEditorPresets] = React.useState<EditorConfig[]>([]);
  const [editorSettings, showEditorSettings] = React.useState(false);
  const [openAfterConfigure, setOpenAfterConfigure] = React.useState(false);
  const [persist, setPersist] = React.useState(true);
  const [manifest, setManifest] = React.useState<Manifest | null>(null);
  const [comment, setComment] = React.useState("");
  const [anchor, setAnchor] = React.useState<{
    fileId: string;
    side: "before" | "after";
    line: number;
  } | null>(null);
  const [theme, setTheme] = React.useState(
    matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "light",
  );
  const file =
    review?.snapshot.files.find((f) => f.id === selected) ??
    review?.snapshot.files[0];
  const active = review?.snapshot.id === review?.history[0]?.id;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  const loadSessions = async () => setSessions(await api("/sessions"));
  React.useEffect(() => {
    if (!review) return;
    setRoot(review.snapshot.root);
    setMode(review.snapshot.comparison.mode);
    setBase(review.snapshot.comparison.base);
  }, [review?.snapshot.id]);
  React.useEffect(() => {
    if (startupError) return;
    void run(async () => {
      await loadSessions();
      const saved = await api<ProviderConfig | null>("/provider");
      if (saved) setConfig(saved);
      const editors = await api<{
        config: EditorConfig | null;
        presets: EditorConfig[];
      }>("/editor");
      setEditorConfig(editors.config);
      setEditorPresets(editors.presets);
      if (editors.config) {
        setEditorDraft(editors.config);
        setEditorArgs(JSON.stringify(editors.config.args));
      }
    });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setTheme(mq.matches ? "vs-dark" : "light");
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  React.useEffect(() => {
    if (review?.state.analysisStatus !== "running") return;
    const id = setInterval(
      () =>
        void api<Review>(`/sessions/${review.snapshot.sessionId}`)
          .then(setReview)
          .catch((e) => setError(e.message)),
      1000,
    );
    return () => clearInterval(id);
  }, [review?.snapshot.sessionId, review?.state.analysisStatus]);
  React.useEffect(() => {
    setAnchor(null);
    setComment("");
  }, [file?.id, review?.snapshot.id]);
  const mutate = (route: string, body: object) =>
    run(async () => {
      if (!review) return;
      setReview(
        await api(`/sessions/${review.snapshot.sessionId}/${route}`, {
          snapshotId: review.snapshot.id,
          ...body,
        }),
      );
      await loadSessions();
    });
  const reviewed = review?.state.reviewed ?? [];
  const percent = review?.snapshot.files.length
    ? Math.round((reviewed.length / review.snapshot.files.length) * 100)
    : 0;
  const selectedLayer = review?.state.accepted?.cohorts
    .flatMap((c) => c.layers)
    .find((l) => l.fileIds.includes(file?.id ?? ""));
  const language = file?.path.match(/\.tsx?$/)
    ? "typescript"
    : file?.path.match(/\.jsx?$/)
      ? "javascript"
      : file?.path.endsWith(".java")
        ? "java"
        : "plaintext";
  const regroup = (work: (analysis: Analysis) => void) => {
    if (!review?.state.accepted) return;
    const analysis = structuredClone(review.state.accepted);
    work(analysis);
    void mutate("grouping", { analysis });
  };
  const pendingComparison =
    review &&
    (root !== review.snapshot.root ||
      mode !== review.snapshot.comparison.mode ||
      (mode === "branch" && base !== review.snapshot.comparison.base));
  const openSelectedLine = () =>
    run(async () => {
      if (!review || !anchor) return;
      if (!editorConfig) {
        setOpenAfterConfigure(true);
        showEditorSettings(true);
        return;
      }
      await api(`/sessions/${review.snapshot.sessionId}/open-editor`, {
        snapshotId: review.snapshot.id,
        ...anchor,
        column: 1,
      });
    });
  const markFile = () =>
    run(async () => {
      if (!review || !file) return;
      const marking = !reviewed.includes(file.id);
      const next = await api<Review>(
        `/sessions/${review.snapshot.sessionId}/progress`,
        {
          snapshotId: review.snapshot.id,
          fileIds: [file.id],
          reviewed: marking,
        },
      );
      setReview(next);
      if (marking) {
        const nextId = nextUnreviewed(next, file.id);
        if (nextId) setSelected(nextId);
      }
      await loadSessions();
    });
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="flex items-center gap-3">
          <div className="logo">
            <Layers size={20} />
          </div>
          <strong className="brand">LeanReview</strong>
          <span className="header-divider" />
          <span className="text-muted-foreground text-sm">
            Local review workspace
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="privacy-label">
            <ShieldCheck size={14} />
            On your machine
          </span>
          <Button variant="ghost" onClick={() => showSettings(true)}>
            <Settings size={16} />
            AI settings
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setOpenAfterConfigure(false);
              showEditorSettings(true);
            }}
          >
            Editor settings
          </Button>
        </div>
      </header>
      <section className="repository-bar">
        <label className="root-input">
          <FolderOpen size={16} />
          <input
            aria-label="Repository root"
            placeholder="Absolute path to a local Git repository"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
          />
        </label>
        <select
          aria-label="Comparison mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="all">All uncommitted</option>
          <option value="unstaged">Unstaged + untracked</option>
          <option value="staged">Staged</option>
          <option value="branch">Branch comparison</option>
        </select>
        {mode === "branch" && (
          <input
            className="base-input"
            aria-label="Base branch"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
        )}
        <Button
          disabled={busy || !root || !!startupError}
          onClick={() =>
            void run(async () => {
              const created = await api<Review>("/sessions", {
                root,
                comparison: { mode, base },
              });
              setReview(created);
              setSelected(created.snapshot.files[0]?.id ?? "");
              await loadSessions();
            })
          }
        >
          {pendingComparison ? "Open comparison" : "Open review"}
        </Button>
        <select
          aria-label="Saved reviews"
          value={review?.snapshot.sessionId ?? ""}
          onChange={(e) => {
            if (e.target.value)
              void run(async () => {
                const next = await api<Review>(`/sessions/${e.target.value}`);
                setReview(next);
                setRoot(next.snapshot.root);
                setSelected(next.snapshot.files[0]?.id ?? "");
              });
          }}
        >
          <option value="">Saved reviews…</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {new Date(s.updatedAt).toLocaleDateString()}
            </option>
          ))}
        </select>
      </section>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {!review ? (
        <main className="welcome">
          <div className="eyebrow">UNDERSTAND THE CHANGE</div>
          <h1>A clear path through your review.</h1>
          <p>
            Open a local Git repository. Inspect its changes, organize them with
            your selected AI provider, and save your review progress.
          </p>
          <div className="welcome-features">
            <div>
              <GitBranch />
              <h2>Capture a snapshot</h2>
              <p>
                Staged, unstaged, uncommitted, or branch changes. Your review
                stays fixed as code evolves.
              </p>
            </div>
            <div>
              <Sparkles />
              <h2>Follow the change</h2>
              <p>
                AI proposes cohorts and reading layers. You decide what to
                accept and adjust.
              </p>
            </div>
            <div>
              <Check />
              <h2>Keep your place</h2>
              <p>
                File progress and local comments survive restarts. Basic diff
                review needs no AI.
              </p>
            </div>
          </div>
          <p className="small muted">
            Local vertical slice · remote providers, measured CRAP, and module
            graphs are subsequent implementation work.
          </p>
        </main>
      ) : (
        <>
          <div className="review-heading">
            <div>
              <div className="eyebrow">
                {review.snapshot.comparison.mode.toUpperCase()} ·{" "}
                {review.snapshot.files.length} CHANGED FILES
              </div>
              <h1>
                {sessions.find((s) => s.id === review.snapshot.sessionId)
                  ?.name ?? review.snapshot.root.split(/[\\/]/).pop()}
              </h1>
              <div className="snapshot-meta">
                <GitBranch size={13} />
                {review.snapshot.head?.slice(0, 8) ?? "Unborn HEAD"}
                <span>·</span>
                <select
                  aria-label="Snapshot history"
                  value={review.snapshot.id}
                  onChange={(e) =>
                    void run(async () =>
                      setReview(
                        await api(
                          `/sessions/${review.snapshot.sessionId}?snapshot=${e.target.value}`,
                        ),
                      ),
                    )
                  }
                >
                  {review.history.map((h, i) => (
                    <option key={h.id} value={h.id}>
                      {i === 0 ? "Current" : "Previous"} ·{" "}
                      {new Date(h.capturedAt).toLocaleTimeString()}
                    </option>
                  ))}
                </select>
                <span className="muted">Immutable snapshot</span>
              </div>
            </div>
            <div className="progress-summary">
              <strong>
                {reviewed.length}
                <span className="muted">
                  {" "}
                  / {review.snapshot.files.length} reviewed
                </span>
              </strong>
              <span>{percent}%</span>
              <div className="progress-track">
                <div style={{ width: `${percent}%` }} />
              </div>
            </div>
          </div>
          {pendingComparison && (
            <div className="proposal-banner" role="status">
              The selection differs from this {review.snapshot.comparison.mode}{" "}
              snapshot. Choose Open comparison to capture the selected changes;
              Refresh keeps this snapshot’s comparison.
            </div>
          )}
          <div className="review-actions">
            <Button
              variant="outline"
              disabled={
                busy ||
                !active ||
                review.state.analysisStatus === "running" ||
                !review.snapshot.files.length
              }
              onClick={() =>
                void run(async () =>
                  setManifest(
                    await api(
                      `/sessions/${review.snapshot.sessionId}/manifest`,
                    ),
                  ),
                )
              }
            >
              <Sparkles size={15} />
              Generate AI proposal
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !active}
              onClick={() => void mutate("refresh", {})}
            >
              <RefreshCw size={15} />
              Refresh snapshot
            </Button>
            {review.state.analysisStatus === "running" && (
              <>
                <span className="badge">Analyzing with {config.provider}…</span>
                <Button
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `/sessions/${review.snapshot.sessionId}/cancel`,
                        { snapshotId: review.snapshot.id },
                      );
                    })
                  }
                >
                  Cancel
                </Button>
              </>
            )}
            {review.state.analysisError && (
              <span className="text-destructive text-sm">
                {review.state.analysisError}
              </span>
            )}
            {!active && (
              <span className="badge">Previous snapshot · read only</span>
            )}
          </div>
          {review.state.proposal && (
            <div className="proposal-banner">
              <div>
                <strong>Analysis proposal ready</strong>
                <p>
                  {review.state.proposal.cohorts.length} cohorts ·{" "}
                  {review.state.proposal.cohorts.reduce(
                    (n, c) => n + c.layers.length,
                    0,
                  )}{" "}
                  layers · {review.state.proposal.findings.length} AI findings.
                  Accepting replaces the grouping, not your reviewed status.
                </p>
                <details>
                  <summary>Preview proposed cohorts and layers</summary>
                  {review.state.proposal.cohorts.map((c, i) => (
                    <div key={i}>
                      <strong>{c.name}</strong>
                      <p>{c.explanation}</p>
                      {c.layers.map((l, j) => (
                        <p key={j}>
                          {j + 1}. {l.name} ·{" "}
                          {l.fileIds
                            .map(
                              (id) =>
                                review.snapshot.files.find((f) => f.id === id)
                                  ?.path,
                            )
                            .join(", ")}
                          <br />
                          {l.explanation}
                        </p>
                      ))}
                    </div>
                  ))}
                </details>
              </div>
              <Button
                disabled={!active || busy}
                onClick={() =>
                  void mutate("grouping", {
                    analysis: review.state.proposal,
                    acceptProposal: true,
                  })
                }
              >
                Accept proposal
              </Button>
            </div>
          )}
          <main className="workspace">
            <aside className="cohort-sidebar">
              <div className="section-heading">
                <h2>
                  {review.state.accepted ? "Cohorts & layers" : "Changed files"}
                </h2>
                <span className="badge">
                  {review.state.accepted ? "AI + your edits" : "Ungrouped"}
                </span>
              </div>
              {review.state.accepted
                ? review.state.accepted.cohorts.map((cohort, ci) => (
                    <div className="cohort-group" key={ci}>
                      <div className="flex items-center justify-between gap-1">
                        <h3>{cohort.name}</h3>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!active}
                          aria-label={`Rename ${cohort.name}`}
                          onClick={() => {
                            const name = prompt("Cohort name", cohort.name);
                            if (name?.trim())
                              regroup((a) => {
                                a.cohorts[ci].name = name.trim();
                              });
                          }}
                        >
                          Edit
                        </Button>
                      </div>
                      {cohort.layers.map((layer, li) => (
                        <div key={li}>
                          <div className="layer-title">
                            <span>
                              {li + 1}. {layer.name}
                            </span>
                            <div className="flex">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!active || li === 0}
                                aria-label={`Move ${layer.name} earlier`}
                                onClick={() =>
                                  regroup((a) => {
                                    const ls = a.cohorts[ci].layers;
                                    [ls[li - 1], ls[li]] = [ls[li], ls[li - 1]];
                                  })
                                }
                              >
                                <ArrowUp size={12} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={
                                  !active || li === cohort.layers.length - 1
                                }
                                aria-label={`Move ${layer.name} later`}
                                onClick={() =>
                                  regroup((a) => {
                                    const ls = a.cohorts[ci].layers;
                                    [ls[li + 1], ls[li]] = [ls[li], ls[li + 1]];
                                  })
                                }
                              >
                                <ArrowDown size={12} />
                              </Button>
                            </div>
                          </div>
                          {layer.fileIds.map((id) => {
                            const f = review.snapshot.files.find(
                              (f) => f.id === id,
                            )!;
                            return (
                              <button
                                className={`file-item ${file?.id === id ? "selected" : ""}`}
                                key={id}
                                onClick={() => setSelected(id)}
                              >
                                <span
                                  className={`file-indicator ${reviewed.includes(id) ? "done" : ""}`}
                                >
                                  {reviewed.includes(id) ? (
                                    <Check size={12} />
                                  ) : (
                                    <FileCode2 size={12} />
                                  )}
                                </span>
                                <span>
                                  {f.path.split("/").pop()}
                                  <small>{f.path}</small>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ))
                : review.snapshot.files.map((f) => (
                    <button
                      className={`file-item ${file?.id === f.id ? "selected" : ""}`}
                      key={f.id}
                      onClick={() => setSelected(f.id)}
                    >
                      <span
                        className={`file-indicator ${reviewed.includes(f.id) ? "done" : ""}`}
                      >
                        {reviewed.includes(f.id) ? (
                          <Check size={12} />
                        ) : (
                          <FileCode2 size={12} />
                        )}
                      </span>
                      <span>
                        {f.path.split("/").pop()}
                        <small>{f.path}</small>
                      </span>
                      <span className="status-letter">
                        {f.status[0].toUpperCase()}
                      </span>
                    </button>
                  ))}
              {!review.snapshot.files.length && (
                <p className="empty-message">No changes in this comparison.</p>
              )}
            </aside>
            <section className="diff-pane">
              {file ? (
                <>
                  <div className="file-heading">
                    <div>
                      <strong>{file.path}</strong>
                      <span className="badge">{file.status}</span>
                      {file.oldPath !== file.path && (
                        <p className="small muted">From {file.oldPath}</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant={split ? "outline" : "ghost"}
                        onClick={() => setSplit(true)}
                      >
                        Split
                      </Button>
                      <Button
                        size="sm"
                        variant={!split ? "outline" : "ghost"}
                        onClick={() => setSplit(false)}
                      >
                        Unified
                      </Button>
                    </div>
                  </div>
                  <div className="editor-wrapper">
                    {anchor && (
                      <div className="diff-footer">
                        <span className="small">
                          {anchor.side} · line {anchor.line}
                          {anchor.side === "before"
                            ? " · external editor opens the working file at its start"
                            : ""}
                        </span>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setTab("Comments")}
                          >
                            Draft comment
                          </Button>
                          <Button
                            size="sm"
                            disabled={
                              !active || busy || file.after.kind !== "text"
                            }
                            onClick={() => void openSelectedLine()}
                          >
                            Open {editorConfig?.name ?? "in editor"}
                          </Button>
                        </div>
                      </div>
                    )}
                    {[file.before.kind, file.after.kind].every(
                      (k) => k === "text" || k === "absent",
                    ) ? (
                      <DiffEditor
                        key={`${review.snapshot.id}:${file.id}`}
                        height="540px"
                        language={language}
                        theme={theme}
                        original={
                          file.before.kind === "text" ? file.before.text : ""
                        }
                        modified={
                          file.after.kind === "text" ? file.after.text : ""
                        }
                        options={{
                          readOnly: true,
                          originalEditable: false,
                          renderSideBySide: split,
                          minimap: { enabled: false },
                          scrollBeyondLastLine: false,
                          fontSize: 13,
                          automaticLayout: true,
                          wordWrap: "on",
                          glyphMargin: true,
                        }}
                        onMount={(editor) => {
                          for (const [side, source] of [
                            ["before", editor.getOriginalEditor()],
                            ["after", editor.getModifiedEditor()],
                          ] as const)
                            source.onMouseDown((event) => {
                              if (!active || !event.target.position) return;
                              setAnchor({
                                fileId: file.id,
                                side,
                                line: event.target.position.lineNumber,
                              });
                              if (
                                [
                                  monaco.editor.MouseTargetType
                                    .GUTTER_LINE_NUMBERS,
                                  monaco.editor.MouseTargetType
                                    .GUTTER_GLYPH_MARGIN,
                                ].includes(event.target.type)
                              ) {
                                setAnchor({
                                  fileId: file.id,
                                  side,
                                  line: event.target.position.lineNumber,
                                });
                                setTab("Comments");
                              }
                            });
                        }}
                      />
                    ) : (
                      <div className="metadata-only">
                        <FileCode2 size={32} />
                        <h2>Metadata-only change</h2>
                        <p>
                          Before: {file.before.kind} · After: {file.after.kind}
                        </p>
                        <p>
                          This content cannot be displayed as a text diff. You
                          can explicitly acknowledge the file.
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="diff-footer">
                    <span className="muted small">
                      Click a line number to draft a local comment.
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || !active || !selectedLayer}
                        onClick={() =>
                          void mutate("progress", {
                            fileIds: selectedLayer!.fileIds,
                            reviewed: true,
                          })
                        }
                      >
                        Mark layer reviewed
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || !active}
                        onClick={() => void markFile()}
                      >
                        <Check size={14} />
                        {reviewed.includes(file.id)
                          ? "Reviewed · undo"
                          : "Mark file reviewed"}
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="metadata-only">
                  <Check size={32} />
                  <h2>No changed files</h2>
                  <p>
                    Select another comparison or refresh after editing your
                    repository.
                  </p>
                </div>
              )}
            </section>
            <aside className="detail-pane">
              <div className="detail-tabs">
                {["Explanation", "Comments"].map((t) => (
                  <button
                    key={t}
                    className={tab === t ? "active" : ""}
                    onClick={() => setTab(t)}
                  >
                    {t}
                    {t === "Comments" && (
                      <span>{review.state.drafts.length}</span>
                    )}
                  </button>
                ))}
              </div>
              {tab === "Explanation" ? (
                <div className="details-content">
                  <span className="eyebrow">READING ORDER</span>
                  <h2>{selectedLayer?.name ?? "Review this file"}</h2>
                  <p>
                    {selectedLayer?.explanation ??
                      "Generate and accept an AI proposal to organize these changes into cohorts and layers. Ungrouped review is available now."}
                  </p>
                  {selectedLayer && (
                    <span className="badge">Suggested order · editable</span>
                  )}
                  <h3 className="mt-7">AI findings</h3>
                  {review.state.accepted?.findings
                    .filter((f) => f.fileId === file?.id)
                    .map((finding, i) => (
                      <div className="finding" key={i}>
                        <span className="badge">
                          {finding.kind} · AI suggestion
                        </span>
                        <p>{finding.message}</p>
                        {finding.line && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!active}
                            onClick={() => {
                              setAnchor({
                                fileId: finding.fileId,
                                side: "after",
                                line: finding.line!,
                              });
                              setComment(finding.message);
                              setTab("Comments");
                            }}
                          >
                            Create local draft
                          </Button>
                        )}
                      </div>
                    ))}
                  {!review.state.accepted?.findings.some(
                    (f) => f.fileId === file?.id,
                  ) && (
                    <p className="small muted">
                      No accepted AI findings for this file. This is not a
                      guarantee of correctness.
                    </p>
                  )}
                  {file &&
                    review.state.manifest?.files.find((f) => f.id === file.id)
                      ?.reason && (
                      <p className="omission">
                        AI context omitted:{" "}
                        {
                          review.state.manifest.files.find(
                            (f) => f.id === file.id,
                          )?.reason
                        }
                      </p>
                    )}
                  {review.state.accepted && file && (
                    <label className="mt-7 small">
                      Move file to cohort
                      <select
                        disabled={!active}
                        value=""
                        onChange={(e) => {
                          const target = Number(e.target.value);
                          regroup((a) => {
                            for (const c of a.cohorts)
                              for (const l of c.layers)
                                l.fileIds = l.fileIds.filter(
                                  (id) => id !== file.id,
                                );
                            a.cohorts[target].layers[0].fileIds.push(file.id);
                            a.cohorts.forEach((c) => {
                              c.layers = c.layers.filter(
                                (l) => l.fileIds.length,
                              );
                            });
                            a.cohorts = a.cohorts.filter(
                              (c) => c.layers.length,
                            );
                          });
                        }}
                      >
                        <option value="" disabled>
                          Select cohort…
                        </option>
                        {review.state.accepted.cohorts.map((c, i) => (
                          <option key={i} value={i}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="phase-note">
                    <h3>Measured metrics & graphs</h3>
                    <p>
                      CRAP collection and module extraction are not connected in
                      this initial slice. No estimated quality scores are shown.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="details-content">
                  <h2>Local draft comments</h2>
                  <p className="small muted">
                    Saved on this machine. Local Git has no remote publication
                    target.
                  </p>
                  {anchor ? (
                    <>
                      <div className="anchor-label">
                        {anchor.side} · line {anchor.line}
                      </div>
                      <textarea
                        aria-label="Draft comment"
                        rows={4}
                        placeholder="Write a review comment…"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                      />
                      <Button
                        disabled={busy || !comment.trim() || !active}
                        onClick={() =>
                          void run(async () => {
                            if (!review) return;
                            setReview(
                              await api(
                                `/sessions/${review.snapshot.sessionId}/drafts`,
                                {
                                  snapshotId: review.snapshot.id,
                                  ...anchor,
                                  text: comment,
                                },
                              ),
                            );
                            setComment("");
                            setAnchor(null);
                          })
                        }
                      >
                        Save draft
                      </Button>
                    </>
                  ) : (
                    <p className="empty-message">
                      Select a line number in the diff to add a comment.
                    </p>
                  )}
                  {review.state.drafts.map((d) => (
                    <div className="draft" key={d.id}>
                      <div className="flex justify-between">
                        <span className="badge">
                          {d.needsReattachment
                            ? "Needs reattachment"
                            : "Local draft"}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Delete draft"
                          disabled={!active}
                          onClick={() =>
                            void run(async () =>
                              setReview(
                                await api(
                                  `/sessions/${review.snapshot.sessionId}/drafts/${d.id}`,
                                  { snapshotId: review.snapshot.id },
                                  "DELETE",
                                ),
                              ),
                            )
                          }
                        >
                          <X size={12} />
                        </Button>
                      </div>
                      <p>{d.text}</p>
                      <small>
                        {d.path} · {d.side} {d.line}
                      </small>
                    </div>
                  ))}
                </div>
              )}
            </aside>
          </main>
        </>
      )}
      {editorSettings && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="editor-title"
          >
            <h2 id="editor-title">Choose your default editor</h2>
            <p className="small muted">
              This opens your working file, not an editable copy of the review
              snapshot. Use an executable path or a terminal launcher for
              Neovim.
            </p>
            <label>
              Preset
              <select
                aria-label="Editor preset"
                value=""
                onChange={(e) => {
                  const preset = editorPresets[Number(e.target.value)];
                  if (preset) {
                    setEditorDraft(preset);
                    setEditorArgs(JSON.stringify(preset.args));
                  }
                }}
              >
                <option value="" disabled>
                  Select a preset…
                </option>
                {editorPresets.map((p, i) => (
                  <option key={p.name} value={i}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Editor name
              <input
                value={editorDraft.name}
                onChange={(e) =>
                  setEditorDraft({ ...editorDraft, name: e.target.value })
                }
              />
            </label>
            <label>
              Executable
              <input
                value={editorDraft.executable}
                onChange={(e) =>
                  setEditorDraft({ ...editorDraft, executable: e.target.value })
                }
                placeholder="Path to Code.exe, idea64.exe, or your terminal launcher"
              />
            </label>
            <label>
              Arguments as a JSON array
              <input
                value={editorArgs}
                onChange={(e) => setEditorArgs(e.target.value)}
              />
            </label>
            <p className="small muted">
              Placeholders: {"{file}"}, {"{line}"}, {"{column}"}. Arguments are
              passed directly, without a shell. On macOS, configure a terminal
              launcher for Neovim rather than starting it without a terminal.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  showEditorSettings(false);
                  setOpenAfterConfigure(false);
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={busy || !editorDraft.executable}
                onClick={() =>
                  void run(async () => {
                    const config = {
                      ...editorDraft,
                      args: JSON.parse(editorArgs),
                    };
                    const saved = await api<EditorConfig>("/editor", config);
                    setEditorConfig(saved);
                    showEditorSettings(false);
                    if (openAfterConfigure && review && anchor)
                      await api(
                        `/sessions/${review.snapshot.sessionId}/open-editor`,
                        {
                          snapshotId: review.snapshot.id,
                          ...anchor,
                          column: 1,
                        },
                      );
                    setOpenAfterConfigure(false);
                  })
                }
              >
                {openAfterConfigure
                  ? "Save & open editor"
                  : "Save default editor"}
              </Button>
            </div>
          </section>
        </div>
      )}
      {settings && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="flex items-center justify-between">
              <h2 id="settings-title">AI provider settings</h2>
              <Button
                variant="ghost"
                aria-label="Close settings"
                onClick={() => showSettings(false)}
              >
                <X size={16} />
              </Button>
            </div>
            <p className="small muted">
              Repository content is sent only after you confirm an analysis
              manifest.
            </p>
            <label>
              Provider
              <select
                value={config.provider}
                onChange={(e) => {
                  const provider = e.target.value as ProviderConfig["provider"];
                  setConfig({
                    ...config,
                    provider,
                    model: "",
                    localOnly: provider === "ollama",
                    endpoint:
                      provider === "ollama"
                        ? "http://127.0.0.1:11434"
                        : provider === "openai"
                          ? "https://api.openai.com/v1"
                          : "https://api.anthropic.com/v1",
                  });
                }}
              >
                {["ollama", "openai", "anthropic"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label>
              Endpoint
              <input
                value={config.endpoint}
                onChange={(e) =>
                  setConfig({ ...config, endpoint: e.target.value })
                }
              />
            </label>
            <label>
              Model
              <input
                value={config.model}
                onChange={(e) =>
                  setConfig({ ...config, model: e.target.value })
                }
                placeholder="An installed or API-accessible structured-output model"
              />
            </label>
            <div className="two-fields">
              <label>
                Context window
                <input
                  type="number"
                  value={config.contextWindow}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      contextWindow: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                Output reservation
                <input
                  type="number"
                  value={config.maxOutput}
                  onChange={(e) =>
                    setConfig({ ...config, maxOutput: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            {config.provider === "ollama" && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={config.localOnly}
                  onChange={(e) =>
                    setConfig({ ...config, localOnly: e.target.checked })
                  }
                />
                I use a local model with Ollama cloud features disabled
              </label>
            )}
            {config.provider !== "ollama" && (
              <>
                <label>
                  API key
                  <input
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Enter a new key; stored keys are never returned"
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={persist}
                    onChange={(e) => setPersist(e.target.checked)}
                  />
                  Store using the OS credential manager
                </label>
                <p className="small muted">
                  Uncheck for session-only storage. Cloud retention depends on
                  your provider and account; this app cannot grant zero
                  retention.
                </p>
              </>
            )}
            <Button
              disabled={busy || !config.model}
              onClick={() =>
                void run(async () => {
                  await api("/provider", {
                    config,
                    token: token || undefined,
                    persist,
                  });
                  setToken("");
                  showSettings(false);
                })
              }
            >
              Save configuration
            </Button>
          </section>
        </div>
      )}
      {manifest && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manifest-title"
          >
            <h2 id="manifest-title">Confirm analysis input</h2>
            <p>
              <strong>
                {manifest.config.provider} · {manifest.config.model}
              </strong>
              <br />
              <span className="small">{manifest.config.endpoint}</span>
            </p>
            <p className="small muted">
              {manifest.config.localOnly
                ? "Configured as local-only; verify your Ollama server has cloud disabled."
                : "This transmits repository code and filenames to the configured endpoint."}{" "}
              No provider fallback occurs.
            </p>
            <div className="manifest-list">
              {manifest.files.map((f) => (
                <div key={f.id}>
                  <span>{f.path}</span>
                  <small>
                    {f.included
                      ? "Diff included"
                      : `Code omitted · ${f.reason} · filename included`}
                  </small>
                </div>
              ))}
            </div>
            <p className="small muted">
              Conservative byte-based token estimate: {manifest.estimatedTokens}
              . Batches fit an input budget of {manifest.inputBudget}; no silent
              model downloads.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setManifest(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!review || manifest.snapshotId !== review.snapshot.id)
                      throw new Error("Snapshot changed; preview again.");
                    setReview(
                      await api(
                        `/sessions/${review.snapshot.sessionId}/analysis`,
                        {
                          snapshotId: manifest.snapshotId,
                          manifestId: manifest.id,
                          authorize: true,
                        },
                      ),
                    );
                    setManifest(null);
                  })
                }
              >
                Authorize & analyze
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
async function boot() {
  let startupError: string | undefined;
  const nonce = new URLSearchParams(location.hash.slice(1)).get("bootstrap");
  if (nonce) {
    history.replaceState(null, "", location.pathname + location.search);
    try {
      await api("/session", { nonce });
    } catch (error) {
      startupError = (error as Error).message;
    }
  }
  createRoot(document.getElementById("root")!).render(
    <App startupError={startupError} />,
  );
}
void boot();
