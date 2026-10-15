import type { Snapshot } from "../../../packages/contracts/src/index";
import type {
  GraphOptions,
  GraphRun,
  ModuleGraph,
} from "../../../packages/contracts/src/graph";
import { Store } from "../storage/store";
import { CapturedArtifacts } from "../storage/artifacts";
import { localGraphSource } from "./source";
import { scanGraph } from "./scan";
export class GraphService {
  private artifacts: CapturedArtifacts;
  private jobs = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  constructor(private store: Store) {
    this.artifacts = new CapturedArtifacts(store.cache);
  }
  view(snapshot: Snapshot, side: string, statusOnly = false) {
    const row = this.store.db
      .prepare(
        statusOnly
          ? "SELECT run FROM graphs WHERE snapshot_id=? AND side=?"
          : "SELECT artifact,run FROM graphs WHERE snapshot_id=? AND side=?",
      )
      .get(snapshot.id, side) as
      { artifact: string | null; sources: string; run: string } | undefined;
    return {
      graph: row?.artifact
        ? (JSON.parse(this.artifacts.read(row.artifact)) as ModuleGraph)
        : null,
      run: row ? (JSON.parse(row.run) as GraphRun) : null,
    };
  }
  source(snapshot: Snapshot, side: string, nodeId: string) {
    const graph = this.view(snapshot, side).graph,
      node = graph?.nodes.find((n) => n.id === nodeId);
    if (!node?.path) throw new Error("Select a captured source node.");
    const row = this.store.db
      .prepare("SELECT sources FROM graphs WHERE snapshot_id=? AND side=?")
      .get(snapshot.id, side) as { sources: string };
    const sources = JSON.parse(row.sources) as Record<string, string>;
    if (!sources[node.path])
      throw new Error("Source was not scanned; raise limits and rerun.");
    return {
      path: node.path,
      text: this.artifacts.read(sources[node.path]),
      line: node.line ?? 1,
    };
  }
  start(snapshot: Snapshot, options: GraphOptions) {
    if (this.jobs.size)
      throw new Error(
        "A graph scan is already running. Cancel or wait for it.",
      );
    const run: GraphRun = {
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.store.db
      .prepare(
        "INSERT INTO graphs VALUES (?,?,NULL,'{}',?) ON CONFLICT(snapshot_id,side) DO UPDATE SET run=excluded.run",
      )
      .run(snapshot.id, options.side, JSON.stringify(run));
    const controller = new AbortController(),
      done = this.execute(snapshot, options, run, controller.signal);
    this.jobs.set(snapshot.id, { controller, done });
    void done.finally(() => this.jobs.delete(snapshot.id));
    return this.view(snapshot, options.side);
  }
  private async execute(
    snapshot: Snapshot,
    options: GraphOptions,
    run: GraphRun,
    signal: AbortSignal,
  ) {
    try {
      const source = localGraphSource(snapshot, options.side);
      const previous = this.store.db
        .prepare("SELECT sources FROM graphs WHERE snapshot_id=? AND side=?")
        .get(snapshot.id, options.side) as { sources: string } | undefined;
      const sources: Record<string, string> = JSON.parse(
        previous?.sources ?? "{}",
      );
      let progressAt = 0;
      const graph = await scanGraph(
        snapshot,
        options,
        signal,
        {
          ...source,
          read: async (name, signal) => {
            const text = sources[name]
              ? this.artifacts.read(sources[name])
              : await source.read(name, signal);
            sources[name] = this.artifacts.write(text);
            return text;
          },
        },
        (progress) => {
          const phaseChanged = run.progress?.phase !== progress.phase;
          run.progress = progress;
          if (phaseChanged || Date.now() - progressAt >= 150) {
            progressAt = Date.now();
            this.store.db
              .prepare("UPDATE graphs SET run=? WHERE snapshot_id=? AND side=?")
              .run(JSON.stringify(run), snapshot.id, options.side);
          }
        },
      );
      if (signal.aborted) throw new Error("Graph scan canceled.");
      const artifact = this.artifacts.write(JSON.stringify(graph));
      run.status = "succeeded";
      run.finishedAt = new Date().toISOString();
      this.store.db
        .prepare(
          "UPDATE graphs SET artifact=?,sources=?,run=? WHERE snapshot_id=? AND side=?",
        )
        .run(
          artifact,
          JSON.stringify(sources),
          JSON.stringify(run),
          snapshot.id,
          options.side,
        );
    } catch (error) {
      run.status = signal.aborted ? "canceled" : "failed";
      run.error = error instanceof Error ? error.message : "Graph scan failed.";
      run.finishedAt = new Date().toISOString();
      this.store.db
        .prepare("UPDATE graphs SET run=? WHERE snapshot_id=? AND side=?")
        .run(JSON.stringify(run), snapshot.id, options.side);
    }
  }
  cancel(snapshotId: string) {
    this.jobs.get(snapshotId)?.controller.abort();
  }
  async shutdown() {
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((j) => j.done));
  }
}
