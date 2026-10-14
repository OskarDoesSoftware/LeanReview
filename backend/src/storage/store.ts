import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash } from "../git/local";
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
  constructor(public directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.cache = path.join(directory, "cache");
    fs.mkdirSync(this.cache, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(directory, "leanreview.sqlite"));
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 1)
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
  private cacheText(text: string) {
    const digest = hash(text);
    const file = path.join(this.cache, digest);
    if (!fs.existsSync(file)) {
      const temp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, text, { mode: 0o600 });
      fs.renameSync(temp, file);
    }
    return digest;
  }
  private encode(snapshot: Snapshot) {
    return JSON.stringify({
      ...snapshot,
      files: snapshot.files.map((file) => ({
        ...file,
        patch: undefined,
        before:
          file.before.kind === "text"
            ? { kind: "text", hash: this.cacheText(file.before.text) }
            : file.before,
        after:
          file.after.kind === "text"
            ? { kind: "text", hash: this.cacheText(file.after.text) }
            : file.after,
        patchHash: this.cacheText(file.patch),
      })),
    });
  }
  private decode(data: string): Snapshot {
    const raw = JSON.parse(data);
    const read = (digest: string) => {
      if (!/^[a-f0-9]{64}$/.test(digest))
        throw new Error("Invalid cache identity.");
      const text = fs.readFileSync(path.join(this.cache, digest), "utf8");
      if (hash(text) !== digest) throw new Error("Cached source is corrupt.");
      return text;
    };
    const expand = (value: Content & { hash?: string }): Content =>
      value.kind === "text" ? { kind: "text", text: read(value.hash!) } : value;
    return {
      ...raw,
      files: raw.files.map(
        (file: { before: Content; after: Content; patchHash: string }) => ({
          ...file,
          before: expand(file.before),
          after: expand(file.after),
          patch: read(file.patchHash),
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
