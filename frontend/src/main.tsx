import { changeTarget } from "./lib/change-navigation";
import { rememberWorkspace, restoreWorkspace } from "./lib/workspace";
import { Card, CardContent } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { NativeSelect } from "./components/ui/native-select";
import { Badge } from "./components/ui/badge";
import { ReviewDialog } from "./components/review-dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { DialogTitle } from "./components/ui/dialog";
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
  RefreshCw,
  Settings,
  Sparkles,
  X,
  FileCode2,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Button } from "./components/ui/button";
import type {
  Analysis,
  ProviderConfig,
  SessionSummary,
} from "../../packages/contracts/src/index";
import "./style.css";
import { useReviewNavigation } from "./lib/use-review-navigation";
import { api } from "./lib/api";
import { RepositoryPicker } from "./components/repository-picker";
import { GitHubReview } from "./components/github-review";
import { CodexSettings } from "./components/codex-settings";
import { AnalysisLoading } from "./components/analysis-loading";
import { useAutoGrouping } from "./lib/use-auto-grouping";
type EditorConfig = { name: string; executable: string; args: string[] };
(globalThis as any).MonacoEnvironment = {
  getWorker: (_id: string, label: string) =>
    label === "typescript" || label === "javascript"
      ? new TypeScriptWorker()
      : new EditorWorker(),
};
const initialConfig: ProviderConfig = {
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  model: "",
  contextWindow: 8192,
  maxOutput: 2048,
  localOnly: true,
};
function App({ startupError }: { startupError?: string }) {
  const [repositoryPicker, showRepositoryPicker] = React.useState(false);
  const [githubAvailable, setGithubAvailable] = React.useState(false);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const fileList = React.useRef<HTMLDivElement>(null);
  const [root, setRoot] = React.useState("");
  const [mode, setMode] = React.useState<
    "unstaged" | "staged" | "all" | "branch"
  >("all");
  const [base, setBase] = React.useState("main");
  const [split, setSplit] = React.useState(true);
  const diffEditor = React.useRef<monaco.editor.IStandaloneDiffEditor | null>(
    null,
  );
  const [diffChanges, setDiffChanges] = React.useState<{
    key: string;
    count: number;
    starts: number[];
    line: number;
  } | null>(null);
  const pendingChange = React.useRef<{
    key: string;
    direction: "next" | "previous";
  } | null>(null);
  const [error, setError] = React.useState(startupError ?? "");
  const reportNavigationError = React.useCallback(
    (error: Error) => setError(error.message),
    [],
  );
  const { review, selected, anchor, manifest, navigating, navigation } =
    useReviewNavigation(reportNavigationError);
  useAutoGrouping(review, navigating, navigation, reportNavigationError);
  const setSelected = (id: string) => {
    pendingChange.current = null;
    navigation.selectFile(id);
  };
  const setAnchor = (value: typeof anchor) => navigation.setAnchor(value);
  const [busy, setBusy] = React.useState(false);
  const [settings, showSettings] = React.useState<"ai" | "editor" | null>(null);
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
  const [openAfterConfigure, setOpenAfterConfigure] = React.useState(false);
  const [persist, setPersist] = React.useState(true);
  const [theme, setTheme] = React.useState(
    matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "light",
  );
  const file =
    review?.snapshot.files.find((f) => f.id === selected) ??
    review?.snapshot.files[0];
  const active = !navigating && review?.snapshot.id === review?.history[0]?.id;
  React.useEffect(() => {
    const sidebar = fileList.current?.parentElement;
    if (!sidebar) return;
    const resize = () => {
      const available =
        window.innerHeight -
        Math.max(16, sidebar.getBoundingClientRect().top) -
        24;
      sidebar.style.setProperty(
        "--sidebar-height",
        `${Math.max(240, Math.min(720, available))}px`,
      );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(document.body);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", resize, { passive: true });
    document.addEventListener("toggle", resize, true);
    resize();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", resize);
      document.removeEventListener("toggle", resize, true);
    };
  }, [review?.snapshot.id]);
  React.useEffect(() => {
    const list = fileList.current;
    const item = list?.querySelector<HTMLElement>(".file-item.selected");
    if (!list || !item) return;
    const bounds = list.getBoundingClientRect(),
      selectedBounds = item.getBoundingClientRect();
    if (selectedBounds.top < bounds.top)
      list.scrollTop += selectedBounds.top - bounds.top;
    else if (selectedBounds.bottom > bounds.bottom)
      list.scrollTop += selectedBounds.bottom - bounds.bottom;
  }, [selected, review?.snapshot.id]);
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
  const loadSessions = async () => {
    const saved = await api<SessionSummary[]>("/sessions");
    setSessions(saved);
    return saved;
  };
  React.useEffect(() => {
    if (!review || navigating) return;
    rememberWorkspace({
      sessionId: review.snapshot.sessionId,
      snapshotId: review.snapshot.id,
      fileId: selected,
    });
  }, [review?.snapshot.id, selected, navigating]);
  React.useEffect(() => {
    if (!review) return;
    setRoot(review.snapshot.root);
    setMode(review.snapshot.comparison.mode);
    setBase(review.snapshot.comparison.base);
  }, [review?.snapshot.id]);
  React.useEffect(() => {
    if (startupError) return;
    void run(async () => {
      void api<{ github: boolean }>("/capabilities")
        .then((c) => setGithubAvailable(c.github))
        .catch(() => {});
      const sessions = await loadSessions();
      await restoreWorkspace(sessions, navigation);
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
  const mutate = (route: string, body: object) =>
    run(async () => {
      await navigation.mutate(route, body);
      await loadSessions();
    });
  const reviewed = review?.state.reviewed ?? [];
  const percent = review?.snapshot.files.length
    ? Math.round((reviewed.length / review.snapshot.files.length) * 100)
    : 0;
  const currentDiff =
    diffChanges?.key === review?.snapshot.id + ":" + file?.id
      ? diffChanges
      : null;
  const getChangeTarget = (direction: "next" | "previous") =>
    review &&
    file &&
    !navigating &&
    (currentDiff ||
      ![file.before.kind, file.after.kind].every(
        (kind) => kind === "text" || kind === "absent",
      ))
      ? changeTarget(
          review,
          file.id,
          currentDiff?.starts ?? [],
          currentDiff?.line ?? 1,
          direction,
        )
      : null;
  const navigateChange = (direction: "next" | "previous") => {
    const target = getChangeTarget(direction);
    if (!target || !review) return;
    if (target.line !== null) {
      const source = diffEditor.current?.getModifiedEditor();
      source?.setPosition({ lineNumber: target.line, column: 1 });
      source?.revealLineInCenter(target.line);
    } else {
      pendingChange.current = {
        key: review.snapshot.id + ":" + target.fileId,
        direction,
      };
      navigation.selectFile(target.fileId);
    }
  };
  const selectedCohort = review?.state.accepted?.cohorts.find((c) =>
    c.layers.some((l) => l.fileIds.includes(file?.id ?? "")),
  );
  const reviewSequence =
    review?.state.accepted?.cohorts.flatMap((c) =>
      c.layers.flatMap((l) => l.fileIds),
    ) ?? [];
  const nextReviewId = reviewSequence.find((id) => !reviewed.includes(id));
  const nextReviewFile = review?.snapshot.files.find(
    (f) => f.id === nextReviewId,
  );
  const nextReviewCohort = review?.state.accepted?.cohorts.find((c) =>
    c.layers.some((l) => l.fileIds.includes(nextReviewId ?? "")),
  );
  const nextReviewLayer = nextReviewCohort?.layers.find((l) =>
    l.fileIds.includes(nextReviewId ?? ""),
  );
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
        showSettings("editor");
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
      await navigation.mutate(
        "progress",
        { fileIds: [file.id], reviewed: marking },
        { advance: marking },
      );
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
          <Button
            variant="ghost"
            onClick={() => {
              setOpenAfterConfigure(false);
              showSettings("ai");
            }}
          >
            <Settings size={16} />
            Settings
          </Button>
        </div>
      </header>
      <section className="repository-bar">
        {githubAvailable && (
          <Button variant="outline" onClick={() => showRepositoryPicker(true)}>
            Choose repository
          </Button>
        )}
        {review?.snapshot.source ? (
          <div className="remote-review-heading">
            <strong>
              {review.snapshot.source.fullName} #
              {review.snapshot.source.pullNumber}
            </strong>
            <span>{review.snapshot.source.title}</span>
          </div>
        ) : githubAvailable ? (
          <div className="remote-review-heading">
            <strong>
              {review
                ? review.snapshot.root
                : "Choose a repository to get started"}
            </strong>
            {review && <span>{review.snapshot.comparison.mode} changes</span>}
          </div>
        ) : (
          <>
            <label className="root-input">
              <FolderOpen size={16} />
              <Input
                aria-label="Repository root"
                placeholder="Absolute path to a local Git repository"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
              />
            </label>
            <NativeSelect
              aria-label="Comparison mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="all">All uncommitted</option>
              <option value="unstaged">Unstaged + untracked</option>
              <option value="staged">Staged</option>
              <option value="branch">Branch comparison</option>
            </NativeSelect>
            {mode === "branch" && (
              <Input
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
                  await navigation.open(root, { mode, base });
                  await loadSessions();
                })
              }
            >
              {pendingComparison ? "Open comparison" : "Open review"}
            </Button>
          </>
        )}
        <NativeSelect
          aria-label="Saved reviews"
          value={review?.snapshot.sessionId ?? ""}
          onChange={(e) => {
            if (e.target.value)
              void run(async () => {
                await navigation.navigate(e.target.value);
              });
          }}
        >
          <option value="">Saved reviews…</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {new Date(s.updatedAt).toLocaleDateString()}
            </option>
          ))}
        </NativeSelect>
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
          {githubAvailable && (
            <Button onClick={() => showRepositoryPicker(true)}>
              Choose a repository to review
            </Button>
          )}
          <div className="eyebrow">YOUR REVIEW WORKSPACE</div>
          <h1>Your changes. A clear place to start.</h1>
          <p>
            Open a local Git repository. Inspect its changes, organize them with
            your selected AI provider, and save your review progress.
          </p>
          <div className="welcome-features">
            <Card>
              <CardContent className="welcome-card">
                <GitBranch />
                <h2>Capture a snapshot</h2>
                <p>
                  Staged, unstaged, uncommitted, or branch changes. Your review
                  stays fixed as code evolves.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="welcome-card">
                <Sparkles />
                <h2>Follow the change</h2>
                <p>
                  AI proposes cohorts and reading layers. You decide what to
                  accept and adjust.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="welcome-card">
                <Check />
                <h2>Keep your place</h2>
                <p>
                  File progress and accepted cohorts survive restarts. Basic
                  diff review needs no AI.
                </p>
              </CardContent>
            </Card>
          </div>
          <p className="small muted">
            Start with a repository above. Your snapshots, cohorts, and review
            progress are saved locally.
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
                <NativeSelect
                  aria-label="Snapshot history"
                  value={review.snapshot.id}
                  onChange={(e) =>
                    void run(async () => {
                      await navigation.navigate(
                        review.snapshot.sessionId,
                        e.target.value,
                      );
                    })
                  }
                >
                  {review.history.map((h, i) => (
                    <option key={h.id} value={h.id}>
                      {i === 0 ? "Current" : "Previous"} ·{" "}
                      {new Date(h.capturedAt).toLocaleTimeString()}
                    </option>
                  ))}
                </NativeSelect>
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
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Files reviewed"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div style={{ width: `${percent}%` }} />
              </div>
            </div>
          </div>
          {review.snapshot.id !== review.history[0]?.id && (
            <div
              className="proposal-banner"
              role="region"
              aria-label="Previous snapshot guidance"
            >
              <div>
                <strong>You're viewing a previous snapshot</strong>
                <p>
                  Return to the current snapshot to generate a new AI proposal
                  or continue reviewing.
                </p>
                {review.state.analysisError && (
                  <details>
                    <summary>Saved error from this previous analysis</summary>
                    <p>{review.state.analysisError}</p>
                  </details>
                )}
              </div>
              <Button
                disabled={navigating}
                onClick={() =>
                  void run(async () => {
                    await navigation.navigate(review.snapshot.sessionId);
                  })
                }
              >
                Return to current snapshot
              </Button>
            </div>
          )}
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
                void run(async () => {
                  await navigation.previewAnalysis();
                })
              }
            >
              <Sparkles size={15} />
              {review.state.analysisStatus === "running"
                ? "Analysis in progress…"
                : "Generate AI proposal"}
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !active}
              onClick={() => void mutate("refresh", {})}
            >
              <RefreshCw size={15} />
              Refresh snapshot
            </Button>
            {review.state.analysisError &&
              review.snapshot.id === review.history[0]?.id && (
                <span className="text-destructive text-sm">
                  {review.state.analysisError}
                </span>
              )}
            {!active && (
              <Badge variant="secondary" className="badge">
                Previous snapshot · read only
              </Badge>
            )}
          </div>
          {review.state.analysisStatus === "running" && (
            <AnalysisLoading
              key={review.snapshot.id}
              provider={
                (review.state.manifest?.config.provider ?? config.provider) ===
                "codex"
                  ? "Codex"
                  : (review.state.manifest?.config.provider ?? config.provider)
              }
              fileCount={review.snapshot.files.length}
              progress={review.state.analysisProgress}
              onCancel={async () => {
                await api(`/sessions/${review.snapshot.sessionId}/cancel`, {
                  snapshotId: review.snapshot.id,
                });
              }}
            />
          )}
          {review.state.accepted && (
            <section
              className="review-route"
              aria-label="Suggested review route"
            >
              <div>
                <span className="eyebrow">
                  {reviewed.length ? "CONTINUE YOUR REVIEW" : "START HERE"}
                </span>
                <h2>{nextReviewFile?.path ?? "All files reviewed"}</h2>
                {nextReviewCohort && nextReviewLayer && (
                  <p className="small">
                    {nextReviewCohort.name} · Step{" "}
                    {nextReviewCohort.layers.indexOf(nextReviewLayer) + 1}:{" "}
                    {nextReviewLayer.name}
                    <br />
                    {nextReviewLayer.explanation}
                  </p>
                )}
                <p className="small muted">
                  {nextReviewFile
                    ? "Follow the cohorts and numbered layers below. Start with the first unreviewed file in this order."
                    : "You have reviewed every file in this snapshot."}
                </p>
                {review.state.groupingCarriedForward && (
                  <p className="small muted">
                    Cohorts kept from the previous snapshot. Check their
                    explanations against the latest changes or generate a new AI
                    proposal.
                  </p>
                )}
              </div>
              {nextReviewId && (
                <Button onClick={() => setSelected(nextReviewId)}>
                  {reviewed.length ? "Continue review" : "Start review"}
                  <ChevronRight size={16} />
                </Button>
              )}
            </section>
          )}
          {review.snapshot.source && (
            <GitHubReview
              review={review}
              active={active}
              anchor={anchor}
              onChanged={async () => {
                await navigation.navigate(review.snapshot.sessionId);
                await loadSessions();
              }}
            />
          )}
          <main className="workspace">
            <aside className="cohort-sidebar">
              <div className="section-heading">
                <h2>
                  {review.state.accepted ? "Cohorts & layers" : "Changed files"}
                </h2>
                <Badge variant="secondary" className="badge">
                  {review.state.accepted ? "AI + your edits" : "Ungrouped"}
                </Badge>
              </div>
              <div
                className="cohort-file-list"
                ref={fileList}
                role="region"
                aria-label="Changed files list"
                tabIndex={0}
              >
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
                        <p className="cohort-reason">
                          {cohort.explanation ||
                            "No grouping explanation was provided."}
                        </p>
                        <p className="small muted">
                          {
                            cohort.layers
                              .flatMap((l) => l.fileIds)
                              .filter((id) => reviewed.includes(id)).length
                          }{" "}
                          /{" "}
                          {cohort.layers.reduce(
                            (n, l) => n + l.fileIds.length,
                            0,
                          )}{" "}
                          reviewed
                        </p>
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
                                      [ls[li - 1], ls[li]] = [
                                        ls[li],
                                        ls[li - 1],
                                      ];
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
                                      [ls[li + 1], ls[li]] = [
                                        ls[li],
                                        ls[li + 1],
                                      ];
                                    })
                                  }
                                >
                                  <ArrowDown size={12} />
                                </Button>
                              </div>
                            </div>
                            <p className="layer-reason">{layer.explanation}</p>
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
                  <p className="empty-message">
                    No changes in this comparison.
                  </p>
                )}
              </div>
            </aside>
            <section className="diff-pane">
              {file ? (
                <>
                  <div className="file-heading">
                    <div>
                      <strong>{file.path}</strong>
                      <Badge variant="secondary" className="badge">
                        {file.status}
                      </Badge>
                      {file.oldPath !== file.path && (
                        <p className="small muted">From {file.oldPath}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Previous change"
                        title="Previous change"
                        disabled={!getChangeTarget("previous")}
                        onClick={() => navigateChange("previous")}
                      >
                        <ArrowUp size={15} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Next change"
                        title="Next change"
                        disabled={!getChangeTarget("next")}
                        onClick={() => navigateChange("next")}
                      >
                        <ArrowDown size={15} />
                      </Button>
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
                    {anchor && !review.snapshot.source && (
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
                        editorRef={diffEditor}
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
                          const key = review.snapshot.id + ":" + file.id;
                          const updateChanges = () => {
                            const changes = editor.getLineChanges();
                            if (!changes) return;
                            const starts = changes.map((change) =>
                              Math.min(
                                editor
                                  .getModifiedEditor()
                                  .getModel()!
                                  .getLineCount(),
                                Math.max(
                                  1,
                                  change.modifiedEndLineNumber === 0
                                    ? change.modifiedStartLineNumber + 1
                                    : change.modifiedStartLineNumber,
                                ),
                              ),
                            );
                            if (pendingChange.current?.key === key) {
                              const direction = pendingChange.current.direction;
                              pendingChange.current = null;
                              const line =
                                direction === "next"
                                  ? starts[0]
                                  : starts.at(-1);
                              if (line !== undefined) {
                                const source = editor.getModifiedEditor();
                                source.setPosition({
                                  lineNumber: line,
                                  column: 1,
                                });
                                source.revealLineInCenter(line);
                              }
                            }
                            setDiffChanges({
                              key,
                              count: changes.length,
                              starts,
                              line:
                                editor.getModifiedEditor().getPosition()
                                  ?.lineNumber ?? 1,
                            });
                          };
                          editor.onDidUpdateDiff(updateChanges);
                          editor
                            .getModifiedEditor()
                            .onDidChangeCursorPosition(updateChanges);
                          updateChanges();
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
                      {review.snapshot.source
                        ? "Select a diff line to attach feedback. Drafts stay local until submission."
                        : "Select a line to open it in your editor."}
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
            <aside className="detail-pane" aria-label="AI review guide">
              <h2 className="review-guide-heading">
                <Sparkles size={16} />
                AI review guide
              </h2>
              <div className="details-content">
                {selectedCohort && (
                  <section
                    className="cohort-context"
                    aria-label="Why these files belong together"
                  >
                    <span className="eyebrow">
                      WHY THESE FILES BELONG TOGETHER
                    </span>
                    <h2>{selectedCohort.name}</h2>
                    <p>
                      {selectedCohort.explanation ||
                        "No grouping explanation was provided."}
                    </p>
                  </section>
                )}
                <span className="eyebrow">
                  {selectedLayer && selectedCohort
                    ? "STEP " +
                      (selectedCohort.layers.indexOf(selectedLayer) + 1) +
                      " OF " +
                      selectedCohort.layers.length
                    : "READING ORDER"}
                </span>
                <h2>{selectedLayer?.name ?? "Review this file"}</h2>
                <p>
                  {selectedLayer?.explanation ??
                    "Generate an AI grouping to organize these changes into cohorts and layers. Ungrouped review is available now."}
                </p>
                {selectedLayer && (
                  <Badge variant="secondary" className="badge">
                    Suggested order · editable
                  </Badge>
                )}
                {selectedLayer && (
                  <ol
                    className="layer-reading-list"
                    aria-label="Files in this review step"
                  >
                    {selectedLayer.fileIds.map((id) => {
                      const entry = review.snapshot.files.find(
                        (f) => f.id === id,
                      );
                      return (
                        <li key={id}>
                          <button
                            aria-current={file?.id === id ? "step" : undefined}
                            onClick={() => setSelected(id)}
                          >
                            {entry?.path}
                            <span className="small muted">
                              {reviewed.includes(id)
                                ? "Reviewed"
                                : id === nextReviewId
                                  ? "Up next"
                                  : "To review"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
                <h3 className="mt-7">AI findings</h3>
                {review.state.accepted?.findings
                  .filter((f) => f.fileId === file?.id)
                  .map((finding, i) => (
                    <div className="finding" key={i}>
                      <Badge variant="secondary" className="badge">
                        {finding.kind} · AI suggestion
                      </Badge>
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
                            const editor =
                              diffEditor.current?.getModifiedEditor();
                            editor?.setPosition({
                              lineNumber: finding.line!,
                              column: 1,
                            });
                            editor?.revealLineInCenter(finding.line!);
                          }}
                        >
                          Go to finding
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
                    <NativeSelect
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
                            c.layers = c.layers.filter((l) => l.fileIds.length);
                          });
                          a.cohorts = a.cohorts.filter((c) => c.layers.length);
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
                    </NativeSelect>
                  </label>
                )}
              </div>
            </aside>
          </main>
        </>
      )}
      {repositoryPicker && (
        <RepositoryPicker
          sessions={sessions}
          onClose={() => showRepositoryPicker(false)}
          onLocal={async (root, comparison) => {
            await navigation.open(root, comparison);
            await loadSessions();
          }}
          onRemote={async (remote) => {
            await navigation.navigate(remote.snapshot.sessionId);
            await loadSessions();
          }}
        />
      )}
      {settings && (
        <ReviewDialog
          labelledBy="settings-title"
          onClose={() => {
            showSettings(null);
            setOpenAfterConfigure(false);
          }}
        >
          <DialogTitle id="settings-title">Settings</DialogTitle>
          <Tabs
            value={settings}
            onValueChange={(value) => showSettings(value as "ai" | "editor")}
          >
            <TabsList aria-label="Settings sections">
              <TabsTrigger value="ai">AI</TabsTrigger>
              <TabsTrigger value="editor">Editor</TabsTrigger>
            </TabsList>
            <TabsContent value="editor" className="settings-section">
              <p className="small muted">
                This opens your working file, not an editable copy of the review
                snapshot. Use an executable path or a terminal launcher for
                Neovim.
              </p>
              <label>
                Preset
                <NativeSelect
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
                </NativeSelect>
              </label>
              <label>
                Editor name
                <Input
                  value={editorDraft.name}
                  onChange={(e) =>
                    setEditorDraft({ ...editorDraft, name: e.target.value })
                  }
                />
              </label>
              <label>
                Executable
                <Input
                  value={editorDraft.executable}
                  onChange={(e) =>
                    setEditorDraft({
                      ...editorDraft,
                      executable: e.target.value,
                    })
                  }
                  placeholder="Path to Code.exe, idea64.exe, or your terminal launcher"
                />
              </label>
              <label>
                Arguments as a JSON array
                <Input
                  value={editorArgs}
                  onChange={(e) => setEditorArgs(e.target.value)}
                />
              </label>
              <p className="small muted">
                Placeholders: {"{file}"}, {"{line}"}, {"{column}"}. Arguments
                are passed directly, without a shell. On macOS, configure a
                terminal launcher for Neovim rather than starting it without a
                terminal.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    showSettings(null);
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
                      showSettings(null);
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
            </TabsContent>
            <TabsContent value="ai" className="settings-section">
              <p className="small muted">
                Repository content is sent only after you confirm an analysis
                manifest.
              </p>
              <label>
                Provider
                <NativeSelect
                  value={config.provider}
                  onChange={(e) => {
                    const provider = e.target
                      .value as ProviderConfig["provider"];
                    setToken("");
                    setConfig({
                      ...config,
                      provider,
                      model: "",
                      localOnly: provider === "ollama",
                      endpoint:
                        provider === "ollama"
                          ? "http://127.0.0.1:11434"
                          : provider === "codex"
                            ? "https://chatgpt.com/codex"
                            : provider === "openai"
                              ? "https://api.openai.com/v1"
                              : "https://api.anthropic.com/v1",
                    });
                  }}
                >
                  {["codex", "ollama", "openai", "anthropic"].map((p) => (
                    <option key={p} value={p}>
                      {p === "codex" ? "Codex · ChatGPT subscription" : p}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              {config.provider === "codex" && (
                <CodexSettings
                  model={config.model}
                  onModel={(model) =>
                    setConfig((current) => ({ ...current, model }))
                  }
                />
              )}
              {config.provider !== "codex" && (
                <>
                  <label>
                    Endpoint
                    <Input
                      value={config.endpoint}
                      onChange={(e) =>
                        setConfig({ ...config, endpoint: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Model
                    <Input
                      value={config.model}
                      onChange={(e) =>
                        setConfig({ ...config, model: e.target.value })
                      }
                      placeholder="An installed or API-accessible structured-output model"
                    />
                  </label>
                </>
              )}
              <div className="two-fields">
                <label>
                  Context window
                  <Input
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
                  <Input
                    type="number"
                    value={config.maxOutput}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        maxOutput: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
              {config.provider === "ollama" && (
                <label className="checkbox-label">
                  <Input
                    type="checkbox"
                    checked={config.localOnly}
                    onChange={(e) =>
                      setConfig({ ...config, localOnly: e.target.checked })
                    }
                  />
                  I use a local model with Ollama cloud features disabled
                </label>
              )}
              {config.provider !== "ollama" && config.provider !== "codex" && (
                <>
                  <label>
                    API key
                    <Input
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="Enter a new key; stored keys are never returned"
                    />
                  </label>
                  <label className="checkbox-label">
                    <Input
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
                      token:
                        config.provider === "codex"
                          ? undefined
                          : token || undefined,
                      persist,
                    });
                    setToken("");
                    showSettings(null);
                  })
                }
              >
                Save configuration
              </Button>
            </TabsContent>
          </Tabs>
        </ReviewDialog>
      )}
      {manifest && (
        <ReviewDialog
          labelledBy="manifest-title"
          onClose={() => navigation.closeManifest()}
        >
          <DialogTitle id="manifest-title">Confirm analysis input</DialogTitle>
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
            Conservative byte-based token estimate: {manifest.estimatedTokens}.
            Batches fit an input budget of {manifest.inputBudget}; no silent
            model downloads.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => navigation.closeManifest()}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!review || manifest.snapshotId !== review.snapshot.id)
                    throw new Error("Snapshot changed; preview again.");
                  await navigation.mutate("analysis", {
                    manifestId: manifest.id,
                    authorize: true,
                  });
                })
              }
            >
              Authorize & analyze
            </Button>
          </div>
        </ReviewDialog>
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
