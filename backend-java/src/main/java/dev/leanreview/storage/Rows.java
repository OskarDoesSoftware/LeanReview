package dev.leanreview.storage;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;
import java.io.Serializable;
import java.util.Objects;

/** Persistence rows mirror the existing SQLite schema. JSON stays lossless TEXT. */
public final class Rows {
  private Rows() {}

  @Entity(name = "StoredSession")
  @Table(name = "sessions")
  public static class Session {
    @Id
    @Column(columnDefinition = "TEXT")
    public String id;

    @Column(nullable = false, columnDefinition = "TEXT")
    public String name;

    @Column(nullable = false, columnDefinition = "TEXT")
    public String root;

    @Column(name = "active_snapshot", columnDefinition = "TEXT")
    public String activeSnapshot;

    @Column(name = "updated_at", nullable = false, columnDefinition = "TEXT")
    public String updatedAt;
  }

  @Entity(name = "StoredSnapshot")
  @Table(name = "snapshots")
  public static class Snapshot {
    @Id
    @Column(columnDefinition = "TEXT")
    public String id;

    @Column(name = "session_id", nullable = false, columnDefinition = "TEXT")
    public String sessionId;

    @Column(nullable = false, columnDefinition = "TEXT")
    public String data;

    @Column(nullable = false, columnDefinition = "TEXT")
    public String state;
  }

  @Entity(name = "StoredSetting")
  @Table(name = "settings")
  public static class Setting {
    @Id
    @Column(columnDefinition = "TEXT")
    public String key;

    @Column(nullable = false, columnDefinition = "TEXT")
    public String value;
  }

  public static class CoverageKey implements Serializable {
    public String snapshotId;
    public String format;

    public CoverageKey() {}

    public CoverageKey(String snapshotId, String format) {
      this.snapshotId = snapshotId;
      this.format = format;
    }

    @Override
    public boolean equals(Object other) {
      return other instanceof CoverageKey key
          && Objects.equals(snapshotId, key.snapshotId)
          && Objects.equals(format, key.format);
    }

    @Override
    public int hashCode() {
      return Objects.hash(snapshotId, format);
    }
  }

  @Entity(name = "StoredCoverage")
  @Table(name = "coverage_reports")
  @IdClass(CoverageKey.class)
  public static class Coverage {
    @Id
    @Column(name = "snapshot_id", nullable = false, columnDefinition = "TEXT")
    public String snapshotId;

    @Id
    @Column(nullable = false, columnDefinition = "TEXT")
    public String format;

    @Column(nullable = false, columnDefinition = "TEXT")
    public String data;

    @Column(name = "raw_hash", nullable = false, columnDefinition = "TEXT")
    public String rawHash;

    @Column(columnDefinition = "TEXT")
    public String provenance;
  }

  @Entity(name = "StoredTestRun")
  @Table(name = "test_runs")
  public static class TestRun {
    @Id
    @Column(columnDefinition = "TEXT")
    public String id;

    @Column(name = "snapshot_id", nullable = false, columnDefinition = "TEXT")
    public String snapshotId;

    @Column(nullable = false, columnDefinition = "TEXT")
    public String data;
  }

  public static class GraphKey implements Serializable {
    public String snapshotId;
    public String side;

    public GraphKey() {}

    public GraphKey(String snapshotId, String side) {
      this.snapshotId = snapshotId;
      this.side = side;
    }

    @Override
    public boolean equals(Object other) {
      return other instanceof GraphKey key
          && Objects.equals(snapshotId, key.snapshotId)
          && Objects.equals(side, key.side);
    }

    @Override
    public int hashCode() {
      return Objects.hash(snapshotId, side);
    }
  }

  @Entity(name = "StoredGraph")
  @Table(name = "graphs")
  @IdClass(GraphKey.class)
  public static class Graph {
    @Id
    @Column(name = "snapshot_id", nullable = false, columnDefinition = "TEXT")
    public String snapshotId;

    @Id
    @Column(nullable = false, columnDefinition = "TEXT")
    public String side;

    @Column(columnDefinition = "TEXT")
    public String artifact;

    @Column(nullable = false, columnDefinition = "TEXT")
    public String sources;

    @Column(nullable = false, columnDefinition = "TEXT")
    public String run;
  }
}
