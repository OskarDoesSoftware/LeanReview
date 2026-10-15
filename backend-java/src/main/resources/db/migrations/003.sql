CREATE TABLE graphs (snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, side TEXT NOT NULL, artifact TEXT, sources TEXT NOT NULL, run TEXT NOT NULL, PRIMARY KEY(snapshot_id,side));
