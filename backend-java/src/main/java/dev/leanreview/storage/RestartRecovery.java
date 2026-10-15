package dev.leanreview.storage;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.time.format.DateTimeFormatterBuilder;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

@Component
public class RestartRecovery implements ApplicationRunner {
  private final Repositories.Snapshots snapshots;
  private final Repositories.Sessions sessions;
  private final Repositories.TestRuns tests;
  private final Repositories.Graphs graphs;
  private final ObjectMapper json;

  public RestartRecovery(
      Repositories.Snapshots snapshots,
      Repositories.Sessions sessions,
      Repositories.TestRuns tests,
      Repositories.Graphs graphs,
      ObjectMapper json) {
    this.snapshots = snapshots;
    this.sessions = sessions;
    this.tests = tests;
    this.graphs = graphs;
    this.json = json;
  }

  @Override
  @Transactional(rollbackFor = Exception.class)
  public void run(ApplicationArguments args) throws Exception {
    String now =
        new DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.now());
    for (Rows.Graph row : graphs.findAll()) {
      ObjectNode run = (ObjectNode) json.readTree(row.run);
      if ("running".equals(run.path("status").asText())) {
        run.put("status", "interrupted")
            .put("error", "Graph scan interrupted by application restart.")
            .put("finishedAt", now);
        row.run = json.writeValueAsString(run);
      }
    }
    for (Rows.TestRun row : tests.findAll()) {
      ObjectNode run = (ObjectNode) json.readTree(row.data);
      if ("running".equals(run.path("status").asText())) {
        run.put("status", "interrupted")
            .put("finishedAt", now)
            .put(
                "error", "Test run interrupted by application restart; not resumed automatically.");
        row.data = json.writeValueAsString(run);
      }
    }
    for (Rows.Snapshot row : snapshots.findAll()) {
      ObjectNode state = (ObjectNode) json.readTree(row.state);
      if ("running".equals(state.path("analysisStatus").asText())) {
        state
            .put("analysisStatus", "interrupted")
            .put("analysisError", "Analysis interrupted by application restart.");
        row.state = json.writeValueAsString(state);
        sessions.findById(row.sessionId).orElseThrow().updatedAt = now;
      }
    }
  }
}
