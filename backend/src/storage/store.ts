import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { CapturedArtifacts } from "./artifacts";
import type {
  CoverageMetrics,
  CoverageProvenance,
  TestRun,
} from "../../../packages/contracts/src/coverage";
import {
  emptyState,
  type Content,
  type Review,
  type ReviewState,
  type Snapshot,
  type SessionSummary,
} from "../../../packages/contracts/src/index";
type Row = { id: string; session_id: string; data: string; state: string };
export class Store {
  db: Database.Database;
  cache: string;
  private artifacts: CapturedArtifacts;
  constructor(public directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.cache = path.join(directory, "cache");
    this.artifacts = new CapturedArtifacts(this.cache);
    this.db = new Database(path.join(directory, "leanreview.sqlite"));
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 3)
      throw new Error(
        "Database is newer than this application; use the newer version.",
      );
    if (version === 0)
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL, active_snapshot TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE snapshots (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL, state TEXT NOT NULL);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;`);
      })();
    if (version < 2) {
      if (version === 1)
        this.db
          .prepare("VACUUM INTO ?")
          .run(path.join(directory, `leanreview.pre-v2.${Date.now()}.sqlite`));
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE coverage_reports (snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, format TEXT NOT NULL, data TEXT NOT NULL, raw_hash TEXT NOT NULL, provenance TEXT, PRIMARY KEY(snapshot_id,format));
          CREATE TABLE test_runs (id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, data TEXT NOT NULL);
          PRAGMA user_version = 2;`);
      })();
    }
    if (version < 3) {
      if (version === 2)
        this.db
          .prepare("VACUUM INTO ?")
          .run(path.join(directory, `leanreview.pre-v3.${Date.now()}.sqlite`));
      this.db.transaction(() =>
        this.db.exec(
          `CREATE TABLE graphs (snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, side TEXT NOT NULL, artifact TEXT, sources TEXT NOT NULL, run TEXT NOT NULL, PRIMARY KEY(snapshot_id,side)); PRAGMA user_version=3;`,
        ),
      )();
    }
    for (const row of this.db
      .prepare("SELECT snapshot_id,side,run FROM graphs")
      .all() as { snapshot_id: string; side: string; run: string }[]) {
      const run = JSON.parse(row.run);
      if (run.status === "running") {
        run.status = "interrupted";
        run.error = "Graph scan interrupted by application restart.";
        run.finishedAt = new Date().toISOString();
        this.db
          .prepare("UPDATE graphs SET run=? WHERE snapshot_id=? AND side=?")
          .run(JSON.stringify(run), row.snapshot_id, row.side);
      }
    }
    for (const row of this.db
      .prepare("SELECT id,data FROM test_runs")
      .all() as { id: string; data: string }[]) {
      const run = JSON.parse(row.data) as TestRun;
      if (run.status === "running") {
        run.status = "interrupted";
        run.finishedAt = new Date().toISOString();
        run.error =
          "Test run interrupted by application restart; not resumed automatically.";
        this.saveTestRun(run);
      }
    }
    for (const row of this.db
      .prepare("SELECT * FROM snapshots")
      .all() as Row[]) {
      const state = JSON.parse(row.state) as ReviewState;
      if (state.analysisStatus === "running") {
        state.analysisStatus = "interrupted";
        state.analysisError = "Analysis interrupted by application restart.";
        this.saveState(row.id, state);
      }
    }
  }
  saveCoverage(
    metrics: CoverageMetrics,
    raw: string,
    provenance?: CoverageProvenance,
  ) {
    const rawHash = this.artifacts.write(raw);
    this.db
      .prepare(
        "INSERT INTO coverage_reports VALUES (?,?,?,?,?) ON CONFLICT(snapshot_id,format) DO UPDATE SET data=excluded.data,raw_hash=excluded.raw_hash,provenance=excluded.provenance",
      )
      .run(
        metrics.snapshotId,
        metrics.format,
        JSON.stringify(metrics),
        rawHash,
        provenance ? JSON.stringify(provenance) : null,
      );
  }
  coverage(snapshotId: string, format: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM coverage_reports WHERE snapshot_id=? AND format=?",
      )
      .get(snapshotId, format) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as CoverageMetrics) : null;
  }
  coverageArtifact(snapshotId: string, format: string) {
    const row = this.db
      .prepare(
        "SELECT raw_hash,provenance FROM coverage_reports WHERE snapshot_id=? AND format=?",
      )
      .get(snapshotId, format) as
      { raw_hash: string; provenance: string | null } | undefined;
    if (!row) throw new Error("Coverage report not found.");
    const report = this.artifacts.read(row.raw_hash);
    return {
      report,
      provenance: row.provenance
        ? (JSON.parse(row.provenance) as CoverageProvenance)
        : null,
    };
  }
  saveTestRun(run: TestRun) {
    this.db
      .prepare(
        "INSERT INTO test_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(run.id, run.snapshotId, JSON.stringify(run));
  }
  testRun(id: string) {
    const row = this.db
      .prepare("SELECT data FROM test_runs WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as TestRun) : null;
  }
  latestTestRun(snapshotId: string, format: string) {
    const rows = this.db
      .prepare(
        "SELECT data FROM test_runs WHERE snapshot_id=? ORDER BY rowid DESC",
      )
      .all(snapshotId) as { data: string }[];
    return (
      rows
        .map((row) => JSON.parse(row.data) as TestRun)
        .find((run) => run.config.format === format) ?? null
    );
  }
  private encode(snapshot: Snapshot) {
    return JSON.stringify({
      ...snapshot,
      files: snapshot.files.map((file) => ({
        ...file,
        patch: undefined,
        before:
          file.before.kind === "text"
            ? { kind: "text", hash: this.artifacts.write(file.before.text) }
            : file.before,
        after:
          file.after.kind === "text"
            ? { kind: "text", hash: this.artifacts.write(file.after.text) }
            : file.after,
        patchHash: this.artifacts.write(file.patch),
      })),
    });
  }
  private decode(data: string): Snapshot {
    const raw = JSON.parse(data);
    const expand = (value: Content & { hash?: string }): Content =>
      value.kind === "text"
        ? { kind: "text", text: this.artifacts.read(value.hash!) }
        : value;
    return {
      ...raw,
      files: raw.files.map(
        (file: { before: Content; after: Content; patchHash: string }) => ({
          ...file,
          before: expand(file.before),
          after: expand(file.after),
          patch: this.artifacts.read(file.patchHash),
        }),
      ),
    };
  }
  create(snapshot: Snapshot) {
    const encoded = this.encode(snapshot);
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)")
        .run(
          snapshot.sessionId,
          path.basename(snapshot.root),
          snapshot.root,
          snapshot.id,
          snapshot.capturedAt,
        );
      this.db
        .prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?)")
        .run(
          snapshot.id,
          snapshot.sessionId,
          encoded,
          JSON.stringify(emptyState()),
        );
    })();
    return this.review(snapshot.sessionId);
  }
  refresh(snapshot: Snapshot) {
    const previous = this.review(snapshot.sessionId);
    const same = new Set(
      snapshot.files
        .filter((file) =>
          previous.snapshot.files.some(
            (old) => old.id === file.id && old.fingerprint === file.fingerprint,
          ),
        )
        .map((f) => f.id),
    );
    const state = emptyState();
    if (previous.state.accepted && snapshot.files.length) {
      const ids = new Set(snapshot.files.map((f) => f.id));
      const accepted = structuredClone(previous.state.accepted);
      accepted.cohorts = accepted.cohorts
        .map((c) => ({
          ...c,
          layers: c.layers
            .map((l) => ({
              ...l,
              fileIds: l.fileIds.filter((id) => ids.has(id)),
            }))
            .filter((l) => l.fileIds.length),
        }))
        .filter((c) => c.layers.length);
      const assigned = new Set(
        accepted.cohorts.flatMap((c) => c.layers.flatMap((l) => l.fileIds)),
      );
      const added = snapshot.files
        .filter((f) => !assigned.has(f.id))
        .map((f) => f.id);
      if (added.length)
        accepted.cohorts.push({
          name: "New files to organize",
          explanation:
            "These files were added since the previous grouping. Generate a new AI proposal to place them with related changes.",
          layers: [
            {
              name: "Review new changes",
              explanation:
                "Check how these files connect to the existing cohorts.",
              fileIds: added,
            },
          ],
        });
      accepted.findings = accepted.findings.filter((f) => same.has(f.fileId));
      state.accepted = accepted;
      state.groupingCarriedForward = true;
    }
    state.reviewed = previous.state.reviewed.filter((id) => same.has(id));
    state.drafts = previous.state.drafts.map((draft) => ({
      ...draft,
      needsReattachment: draft.needsReattachment || !same.has(draft.fileId),
    }));
    const encoded = this.encode(snapshot);
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?)")
        .run(snapshot.id, snapshot.sessionId, encoded, JSON.stringify(state));
      this.db
        .prepare(
          "UPDATE sessions SET active_snapshot = ?, updated_at = ? WHERE id = ?",
        )
        .run(snapshot.id, snapshot.capturedAt, snapshot.sessionId);
    })();
    return this.review(snapshot.sessionId);
  }
  review(sessionId: string, snapshotId?: string): Review {
    const session = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as { active_snapshot: string } | undefined;
    if (!session) throw new Error("Review session not found.");
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE id = ? AND session_id = ?")
      .get(snapshotId ?? session.active_snapshot, sessionId) as Row | undefined;
    if (!row) throw new Error("Snapshot not found.");
    const history = (
      this.db
        .prepare(
          "SELECT id, data FROM snapshots WHERE session_id = ? ORDER BY rowid DESC",
        )
        .all(sessionId) as { id: string; data: string }[]
    ).map((r) => ({ id: r.id, capturedAt: JSON.parse(r.data).capturedAt }));
    return {
      snapshot: this.decode(row.data),
      state: JSON.parse(row.state),
      history,
    };
  }
  saveState(snapshotId: string, state: ReviewState) {
    this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT session_id FROM snapshots WHERE id = ?")
        .get(snapshotId) as { session_id: string } | undefined;
      if (!row) throw new Error("Snapshot not found.");
      this.db
        .prepare("UPDATE snapshots SET state = ? WHERE id = ?")
        .run(JSON.stringify(state), snapshotId);
      this.db
        .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.session_id);
    })();
  }
  sessions() {
    return this.db
      .prepare(
        "SELECT id, name, root, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC",
      )
      .all() as SessionSummary[];
  }
  setting<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
}
