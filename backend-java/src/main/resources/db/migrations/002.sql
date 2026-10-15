CREATE TABLE coverage_reports (snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, format TEXT NOT NULL, data TEXT NOT NULL, raw_hash TEXT NOT NULL, provenance TEXT, PRIMARY KEY(snapshot_id,format));
CREATE TABLE test_runs (id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, data TEXT NOT NULL);
