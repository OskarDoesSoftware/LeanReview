import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  type Node,
  type Edge,
  useNodesState,
  Position,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Review } from "../../../packages/contracts/src/index";
import type {
  ModuleGraph,
  GraphRun,
} from "../../../packages/contracts/src/graph";
import { graphView } from "../lib/graph-view";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import ELK from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
type View = { graph: ModuleGraph | null; run: GraphRun | null };
export function ModuleGraphViewer({
  review,
  initialScope,
  onClose,
  onNavigate,
}: {
  review: Review;
  initialScope: "review" | "repository";
  onClose: () => void;
  onNavigate: (id: string) => void;
}) {
  const [scope, setScope] = useState(initialScope),
    [side, setSide] = useState<"before" | "after">("after");
  const [view, setView] = useState<View>({ graph: null, run: null }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""),
    [external, setExternal] = useState(false),
    [typeOnly, setTypeOnly] = useState(true),
    [collapse, setCollapse] = useState(false),
    [javaPackage, setJavaPackage] = useState<string | null>(null),
    [expanded, setExpanded] = useState<string[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const [groupModules, setGroupModules] = useState(true),
    [folder, setFolder] = useState<string | null>(null),
    [connections, setConnections] = useState<"selected" | "all">("all");
  const flow = useRef<ReactFlowInstance | null>(null);
  const [maxFiles, setMaxFiles] = useState(10000),
    [maxMiB, setMaxMiB] = useState(20),
    [limit, setLimit] = useState(200);
  const [source, setSource] = useState<{
      path: string;
      text: string;
      line: number;
    } | null>(null),
    [layoutNote, setLayoutNote] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [evidencePage, setEvidencePage] = useState(0);
  const base = `/sessions/${review.snapshot.sessionId}/graph`,
    snapshotId = review.snapshot.id;
  const reload = useCallback(
    (statusOnly = false) =>
      api<View>(
        `${base}?snapshot=${snapshotId}&side=${side}${statusOnly ? "&statusOnly=1" : ""}`,
      ),
    [base, snapshotId, side],
  );
  useEffect(() => {
    let live = true;
    setView({ graph: null, run: null });
    setSelected(null);
    setEvidencePage(0);
    setSource(null);
    setExpanded([]);
    setJavaPackage(null);
    setFolder(null);
    setError("");
    const load = () =>
      void reload()
        .then((value) => {
          if (live) setView(value);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    load();
    return () => {
      live = false;
    };
  }, [reload]);
  useEffect(() => {
    if (view.run?.status !== "running") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await reload(true);
        if (!live) return;
        if (status.run?.status !== "running") {
          const result = await reload();
          if (live) setView(result);
          return;
        }
        setView((current) => ({ ...current, run: status.run }));
      } catch (e) {
        if (live)
          setError(e instanceof Error ? e.message : "Graph status failed.");
      }
      if (live) timer = setTimeout(() => void poll(), 750);
    };
    timer = setTimeout(() => void poll(), 750);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [reload, view.run?.status]);
  const graph = view.graph;
  const display = useMemo(
    () =>
      graph
        ? graphView(graph, {
            scope,
            query,
            showExternal: external,
            showTypeOnly: typeOnly,
            expanded,
            javaPackage,
            collapseCycles: collapse,
            limit,
            groupModules,
            folder,
          })
        : null,
    [
      graph,
      scope,
      query,
      external,
      typeOnly,
      expanded,
      javaPackage,
      collapse,
      limit,
      groupModules,
      folder,
    ],
  );
  useEffect(() => {
    if (!display) {
      setNodes([]);
      return;
    }
    setLayoutNote("Laying out modules…");
    const members = new Map<string, number>();
    for (const node of graph?.nodes ?? []) {
      if (node.kind === "package") continue;
      const group = display.projection.get(node.id)!;
      members.set(group, (members.get(group) ?? 0) + 1);
    }
    const initial: Node[] = display.nodes.map((node, index) => ({
      id: node.id,
      data: {
        label: (
          <div className="graph-node-label">
            <strong title={node.label}>{node.label.split("/").at(-1)}</strong>
            <span title={node.label}>{node.label}</span>
            <small>
              {node.kind}
              {node.changed ? " · changed" : ""}
              {node.kind === "folder" || node.kind === "package"
                ? ` · ${members.get(node.id) ?? 0} members`
                : ""}
            </small>
          </div>
        ),
      },
      position: { x: (index % 4) * 300, y: Math.floor(index / 4) * 115 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        width: 260,
        minHeight: 90,
        background: node.changed ? "var(--accent)" : "var(--background)",
        color: "var(--foreground)",
        border: `1px ${node.kind === "unresolved" ? "dashed" : "solid"} var(--border)`,
        borderRadius: 8,
        fontSize: 14,
      },
      ariaLabel: `${node.kind}: ${node.label}${node.changed ? ", changed" : ""}`,
    }));
    setNodes(initial);
    if (!initial.length) {
      setLayoutNote("No modules match this view.");
      return;
    }
    let live = true;
    const elk = new ELK({ workerFactory: () => new ElkWorker() });
    const timer = setTimeout(() => {
      live = false;
      elk.terminateWorker();
      setLayoutNote("Layout time limit reached; grid layout is available.");
    }, 8000);
    void elk
      .layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.spacing.nodeNode": "35",
          "elk.layered.spacing.nodeNodeBetweenLayers": "80",
        },
        children: display.nodes.map((node) => ({
          id: node.id,
          width: 260,
          height: 90,
        })),
        edges: display.edges.map((edge) => ({
          id: edge.id,
          sources: [edge.source],
          targets: [edge.target],
        })),
      })
      .then((layout) => {
        if (!live) return;
        const positions = new Map(
          layout.children!.map((node) => [
            node.id,
            { x: node.x ?? 0, y: node.y ?? 0 },
          ]),
        );
        setNodes((current) =>
          current.map((node) => ({
            ...node,
            position: positions.get(node.id) ?? node.position,
          })),
        );
        setLayoutNote("ELK layout ready");
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (live)
              void flow.current?.fitView({
                minZoom: 0.85,
                maxZoom: 1,
                padding: 0.2,
              });
          }),
        );
      })
      .catch(() => {
        if (live)
          setLayoutNote(
            "Automatic layout unavailable; grid layout is available.",
          );
      })
      .finally(() => {
        clearTimeout(timer);
        elk.terminateWorker();
      });
    return () => {
      live = false;
      clearTimeout(timer);
      elk.terminateWorker();
    };
  }, [display, setNodes]);
  const edges: Edge[] = useMemo(
    () =>
      display?.edges
        .filter(
          (e) =>
            connections === "all" ||
            e.source === selected ||
            e.target === selected,
        )
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          label:
            selected && (e.source === selected || e.target === selected)
              ? e.label
              : undefined,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: {
            stroke: e.unresolved ? "#e09a33" : "var(--primary)",
            strokeWidth: 2,
            strokeDasharray: e.typeOnly ? "5 4" : undefined,
          },
          data: { originalIds: e.originalIds },
        })) ?? [],
    [display, selected, connections],
  );
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Graph action failed");
    } finally {
      setBusy(false);
    }
  };
  const originalIds =
    graph && selected
      ? [...display!.projection]
          .filter(([, id]) => id === selected)
          .map(([id]) => id)
      : [];
  const selectedNode = display?.nodes.find((n) => n.id === selected);
  const expandNode = (id: string) => {
    const node = display?.nodes.find((n) => n.id === id);
    if (node?.kind === "folder") setFolder(id.slice("folder:".length));
    else if (node?.kind === "package" && node.language === "java")
      setJavaPackage(id);
    else return;
    setSelected(null);
    setSource(null);
  };
  const evidence =
    graph?.edges.filter(
      (e) => originalIds.includes(e.source) || originalIds.includes(e.target),
    ) ?? [];
  const page = Math.min(
    evidencePage,
    Math.max(0, Math.ceil(evidence.length / 100) - 1),
  );
  return (
    <div
      className="module-graph-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="module-graph-title"
    >
      <header className="graph-header">
        <div>
          <h2 id="module-graph-title">Module dependency viewer</h2>
          <p className="small muted">
            {side === "before" ? "Before" : "After"} snapshot ·{" "}
            {snapshotId.slice(0, 8)} · arrows point from dependent to dependency
          </p>
        </div>
        <Button variant="outline" onClick={onClose}>
          Close graph
        </Button>
      </header>
      <div className="graph-toolbar">
        <Button
          variant={scope === "review" ? "default" : "outline"}
          onClick={() => setScope("review")}
        >
          Review graph
        </Button>
        <Button
          variant={scope === "repository" ? "default" : "outline"}
          onClick={() => setScope("repository")}
        >
          Repository graph
        </Button>
        <label>
          Snapshot side
          <select
            aria-label="Graph snapshot side"
            disabled={busy}
            value={side}
            onChange={(e) => setSide(e.target.value as typeof side)}
          >
            <option value="before">Before</option>
            <option value="after">After</option>
          </select>
        </label>
        <label>
          Source files
          <input
            aria-label="Graph file limit"
            type="number"
            min={1}
            max={50000}
            value={maxFiles}
            onChange={(e) => setMaxFiles(Number(e.target.value))}
          />
        </label>
        <label>
          MiB
          <input
            aria-label="Graph byte limit"
            type="number"
            min={1}
            max={100}
            value={maxMiB}
            onChange={(e) => setMaxMiB(Number(e.target.value))}
          />
        </label>
        <Button
          disabled={busy || view.run?.status === "running"}
          onClick={() =>
            void action(async () => {
              setView(
                await api(base, {
                  snapshotId,
                  options: { side, maxFiles, maxBytes: maxMiB * 1024 * 1024 },
                }),
              );
            })
          }
        >
          {graph ? "Rescan pinned sources" : "Scan pinned sources"}
        </Button>
        {view.run?.status === "running" && (
          <Button
            variant="outline"
            onClick={() =>
              void action(async () => {
                await api(base + "/cancel", { snapshotId });
              })
            }
          >
            Cancel scan
          </Button>
        )}
        <span className="small">
          {view.run?.status ?? "Not scanned"}
          {view.run?.finishedAt
            ? ` · ${((Date.parse(view.run.finishedAt) - Date.parse(view.run.startedAt)) / 1000).toFixed(1)}s`
            : ""}
        </span>
      </div>
      {view.run?.status === "running" && (
        <div className="graph-scan-progress" aria-live="polite">
          <strong>
            {view.run.progress?.phase ?? "Starting scan"} ·{" "}
            {view.run.progress?.completed ?? 0} /{" "}
            {view.run.progress?.total ?? "?"} ·{" "}
            {Math.max(
              0,
              Math.round((Date.now() - Date.parse(view.run.startedAt)) / 1000),
            )}
            s
          </strong>
          <progress
            aria-label="Graph scan progress"
            max={Math.max(1, view.run.progress?.total ?? 1)}
            value={view.run.progress?.completed ?? 0}
          />
          <span>
            {view.run.progress?.path ?? "Preparing pinned source inventory"}
          </span>
        </div>
      )}
      {(error || view.run?.error) && (
        <p className="graph-alert" role="alert">
          {error || view.run?.error}
        </p>
      )}
      {graph ? (
        <>
          <div className="graph-coverage" role="status">
            {graph.coverage.complete
              ? "Source scan complete"
              : "Partial source scan"}{" "}
            · {graph.coverage.listed} listed ·{" "}
            {graph.coverage.listed - graph.coverage.eligible}{" "}
            non-source/excluded · {graph.coverage.scanned}/
            {graph.coverage.eligible} source files scanned ·{" "}
            {graph.coverage.skipped} skipped · {graph.coverage.parserFailures}{" "}
            parser failures · {graph.coverage.unresolved} unresolved ·{" "}
            {graph.cycles.length} cycles ·{" "}
            {graph.coverage.bytes.toLocaleString()} source bytes
            <br />
            <span className="muted">
              {scope === "review"
                ? "Changed modules and direct outgoing dependencies. Expand a module to include scanned neighbors."
                : "Repository-wide evidence from this pinned snapshot."}{" "}
              Incoming coverage: scanned sources only. Extraction completeness
              does not establish semantic completeness.
            </span>
          </div>
          <div className="graph-toolbar">
            <label>
              <input
                type="checkbox"
                checked={groupModules}
                onChange={(e) => {
                  setGroupModules(e.target.checked);
                  setFolder(null);
                  setSelected(null);
                }}
              />
              Group TS/JS folders
            </label>
            <label>
              Connections
              <select
                aria-label="Graph connections"
                value={connections}
                onChange={(e) =>
                  setConnections(e.target.value as typeof connections)
                }
              >
                <option value="selected">Selected module</option>
                <option value="all">All connections</option>
              </select>
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void flow.current?.zoomTo(1, { duration: 150 })}
            >
              Readable zoom
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void flow.current?.fitView({ minZoom: 0.1, maxZoom: 1 })
              }
            >
              Fit overview
            </Button>
            {folder && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setFolder(null);
                  setSelected(null);
                }}
              >
                Back to folder overview
              </Button>
            )}
            <input
              aria-label="Filter modules"
              placeholder="Filter modules or packages"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label>
              <input
                type="checkbox"
                checked={external}
                onChange={(e) => setExternal(e.target.checked)}
              />
              External / unresolved
            </label>
            <label>
              <input
                type="checkbox"
                checked={typeOnly}
                onChange={(e) => setTypeOnly(e.target.checked)}
              />
              Type-only edges
            </label>
            <label>
              <input
                type="checkbox"
                checked={collapse}
                onChange={(e) => setCollapse(e.target.checked)}
              />
              Collapse cycles
            </label>
            <label>
              Visible nodes
              <input
                aria-label="Visible graph node limit"
                type="number"
                min={1}
                max={200}
                value={limit}
                onChange={(e) =>
                  setLimit(
                    Math.max(1, Math.min(200, Number(e.target.value) || 1)),
                  )
                }
              />
            </label>
            {javaPackage && (
              <Button
                variant="outline"
                onClick={() => {
                  setJavaPackage(null);
                  setSelected(null);
                }}
              >
                Back to packages
              </Button>
            )}
            <span className="small">
              {display?.nodes.length} / {display?.total} matching nodes shown ·{" "}
              {edges.length} / {display?.totalEdges} relationships drawn
            </span>
          </div>
          <div className="graph-body">
            <section
              className="graph-canvas"
              aria-label="Interactive dependency diagram"
            >
              <ReactFlow<Node, Edge>
                nodes={nodes.map((node) => ({
                  ...node,
                  selected: node.id === selected,
                }))}
                edges={edges}
                onInit={(instance) => {
                  flow.current = instance;
                }}
                onNodesChange={onNodesChange}
                zoomOnDoubleClick={false}
                onNodeDoubleClick={(_, node) => expandNode(node.id)}
                onNodeClick={(_, node) => {
                  setSelected(node.id);
                  setSource(null);
                }}
                onEdgeClick={(_, edge) => {
                  setSelected(edge.source);
                  setSource(null);
                }}
                fitView
                fitViewOptions={{ minZoom: 0.85, maxZoom: 1, padding: 0.2 }}
                minZoom={0.1}
                colorMode="system"
                nodesConnectable={false}
                deleteKeyCode={null}
              >
                <Background />
                <Controls showInteractive={false} showFitView={false} />
                <MiniMap />
              </ReactFlow>
              {!selectedNode && (
                <p className="graph-focus-hint">
                  Arrows show dependencies between folders. Double-click a
                  folder to explore its files; select a node to inspect source
                  evidence.
                </p>
              )}
              {layoutNote && <p className="graph-layout-note">{layoutNote}</p>}
            </section>
            <aside className="graph-inspector">
              <h3>Modules · accessible list</h3>
              <p className="small muted">
                Filter to find nodes beyond the visible cap. Java packages open
                into classes. No AI edges are included.
              </p>
              <div className="graph-node-list">
                {display?.nodes.map((node) => (
                  <button
                    className={selected === node.id ? "selected" : ""}
                    key={node.id}
                    onDoubleClick={() => expandNode(node.id)}
                    onClick={() => {
                      setSelected(node.id);
                      setSource(null);
                    }}
                  >
                    {node.label}
                    <span>
                      {node.kind}
                      {node.changed ? " · changed" : ""}
                    </span>
                  </button>
                ))}
              </div>
              {selectedNode && (
                <section className="graph-selection">
                  <h3>{selectedNode.label}</h3>
                  {selectedNode.kind === "folder" && (
                    <Button
                      size="sm"
                      onClick={() => expandNode(selectedNode.id)}
                    >
                      Open folder
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void flow.current?.fitView({
                        nodes: [{ id: selectedNode.id }],
                        minZoom: 1,
                        maxZoom: 1,
                        padding: 0.5,
                      })
                    }
                  >
                    Focus selected
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setExpanded([...new Set([...expanded, ...originalIds])])
                    }
                  >
                    Expand scanned neighbors
                  </Button>
                  {selectedNode.kind === "package" &&
                    !selectedNode.id.startsWith("cycle:") && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setJavaPackage(selectedNode.id);
                          setSelected(null);
                        }}
                      >
                        Drill into classes
                      </Button>
                    )}
                  {selectedNode.fileId && (
                    <Button
                      size="sm"
                      onClick={() => {
                        onNavigate(selectedNode.fileId!);
                        onClose();
                      }}
                    >
                      Open changed file
                    </Button>
                  )}
                  {selectedNode.path && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void action(async () =>
                          setSource(
                            await api(
                              `${base}/source?snapshot=${snapshotId}&side=${side}&node=${selectedNode.id}`,
                            ),
                          ),
                        )
                      }
                    >
                      View pinned source
                    </Button>
                  )}
                  <h3>Source evidence · {evidence.length}</h3>
                  {evidence.slice(page * 100, (page + 1) * 100).map((edge) => (
                    <article className="graph-evidence" key={edge.id}>
                      <strong>{edge.specifier}</strong>
                      <p>
                        {edge.path}:{edge.line} · {edge.kind}
                        {edge.typeOnly ? " · type-only" : ""} · {edge.status}
                      </p>
                      <p>{edge.resolver}</p>
                    </article>
                  ))}
                  {evidence.length > 100 && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={page === 0}
                        onClick={() => setEvidencePage(page - 1)}
                      >
                        Previous evidence
                      </Button>
                      <span>
                        Page {page + 1} / {Math.ceil(evidence.length / 100)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={(page + 1) * 100 >= evidence.length}
                        onClick={() => setEvidencePage(page + 1)}
                      >
                        Next evidence
                      </Button>
                    </div>
                  )}
                </section>
              )}
              <details>
                <summary>Extraction provenance & omissions</summary>
                <p className="small">
                  {graph.provenance.typescript}
                  <br />
                  {graph.provenance.java}
                </p>
                {graph.coverage.warnings.map((w, i) => (
                  <p className="small" key={i}>
                    {w}
                  </p>
                ))}
                {graph.coverage.omissions.slice(0, 100).map((o, i) => (
                  <p className="small" key={i}>
                    {o.path}: {o.reason}
                  </p>
                ))}
                <p className="small">
                  Configuration:{" "}
                  {graph.provenance.configuration.join(", ") ||
                    "No captured configuration"}
                </p>
              </details>
            </aside>
          </div>
          {source && (
            <div className="modal-backdrop">
              <section
                className="modal graph-source"
                role="dialog"
                aria-modal="true"
                aria-label="Pinned graph source"
              >
                <div className="flex justify-between">
                  <h2>
                    {source.path} · line {source.line}
                  </h2>
                  <Button variant="outline" onClick={() => setSource(null)}>
                    Close source
                  </Button>
                </div>
                <pre>{source.text}</pre>
              </section>
            </div>
          )}
        </>
      ) : (
        <div className="graph-empty">
          <h3>
            {scope === "repository"
              ? "Repository module graph"
              : "Review module graph"}
          </h3>
          <p>
            Scan captured sources to inspect static dependencies. This runs
            parsers only. It does not execute builds, tests, plugins, or AI.
          </p>
        </div>
      )}
    </div>
  );
}
