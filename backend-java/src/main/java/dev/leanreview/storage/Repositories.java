package dev.leanreview.storage;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public final class Repositories {
  private Repositories() {}

  public interface Sessions extends JpaRepository<Rows.Session, String> {}

  public interface Settings extends JpaRepository<Rows.Setting, String> {}

  public interface Snapshots extends JpaRepository<Rows.Snapshot, String> {
    Optional<Rows.Snapshot> findByIdAndSessionId(String id, String sessionId);

    @Query(
        value = "SELECT * FROM snapshots WHERE session_id=:session ORDER BY rowid DESC",
        nativeQuery = true)
    List<Rows.Snapshot> history(@Param("session") String sessionId);
  }

  public interface CoverageReports extends JpaRepository<Rows.Coverage, Rows.CoverageKey> {}

  public interface TestRuns extends JpaRepository<Rows.TestRun, String> {}

  public interface Graphs extends JpaRepository<Rows.Graph, Rows.GraphKey> {}
}
