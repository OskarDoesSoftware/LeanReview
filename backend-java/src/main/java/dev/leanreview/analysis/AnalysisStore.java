package dev.leanreview.analysis;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.storage.*;
import java.io.IOException;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Only short database work; process execution and captured artifact writes happen outside. */
@Service
public class AnalysisStore {
  private final Repositories.Graphs graphs;
  private final Repositories.CoverageReports coverage;
  private final Repositories.TestRuns tests;
  private final ObjectMapper json;

  public AnalysisStore(
      Repositories.Graphs graphs,
      Repositories.CoverageReports coverage,
      Repositories.TestRuns tests,
      ObjectMapper json) {
    this.graphs = graphs;
    this.coverage = coverage;
    this.tests = tests;
    this.json = json;
  }

  @Transactional(readOnly = true)
  public ObjectNode graph(String snapshot, String side) throws IOException {
    var row = graphs.findById(new Rows.GraphKey(snapshot, side));
    ObjectNode result = json.createObjectNode().putNull("artifact");
    result.set("sources", json.createObjectNode());
    result.putNull("run");
    if (row.isPresent()) {
      var value = row.get();
      result.put("artifact", value.artifact);
      result.set("sources", json.readTree(value.sources));
      result.set("run", json.readTree(value.run));
    }
    return result;
  }

  @Transactional
  public void graphRun(
      String snapshot, String side, JsonNode run, String artifact, JsonNode sources)
      throws IOException {
    var row = graphs.findById(new Rows.GraphKey(snapshot, side)).orElseGet(Rows.Graph::new);
    row.snapshotId = snapshot;
    row.side = side;
    row.run = json.writeValueAsString(run);
    if (row.sources == null) row.sources = "{}";
    if (artifact != null) {
      row.artifact = artifact;
      row.sources = json.writeValueAsString(sources);
    }
    graphs.save(row);
  }

  @Transactional(readOnly = true)
  public JsonNode coverage(String snapshot, String format) throws IOException {
    var row = coverage.findById(new Rows.CoverageKey(snapshot, format));
    return row.isEmpty() ? null : json.readTree(row.get().data);
  }

  @Transactional(readOnly = true)
  public ObjectNode coverageArtifact(String snapshot, String format) throws IOException {
    var row =
        coverage
            .findById(new Rows.CoverageKey(snapshot, format))
            .orElseThrow(() -> new IllegalArgumentException("Coverage report not found."));
    ObjectNode result = json.createObjectNode().put("hash", row.rawHash);
    result.set(
        "provenance", row.provenance == null ? NullNode.instance : json.readTree(row.provenance));
    return result;
  }

  @Transactional
  public void saveCoverage(JsonNode metrics, String hash, JsonNode provenance) throws IOException {
    var row = new Rows.Coverage();
    row.snapshotId = metrics.path("snapshotId").asText();
    row.format = metrics.path("format").asText();
    row.data = json.writeValueAsString(metrics);
    row.rawHash = hash;
    row.provenance =
        provenance == null || provenance.isNull() ? null : json.writeValueAsString(provenance);
    coverage.save(row);
  }

  @Transactional
  public void saveTest(JsonNode run) throws IOException {
    var row = new Rows.TestRun();
    row.id = run.path("id").asText();
    row.snapshotId = run.path("snapshotId").asText();
    row.data = json.writeValueAsString(run);
    tests.save(row);
  }

  @Transactional(readOnly = true)
  public JsonNode test(String id) throws IOException {
    return json.readTree(
        tests
            .findById(id)
            .orElseThrow(() -> new IllegalArgumentException("Test run not found."))
            .data);
  }

  @Transactional(readOnly = true)
  public JsonNode latestTest(String snapshot) throws IOException {
    var rows = tests.latest(snapshot);
    return rows.isEmpty() ? NullNode.instance : json.readTree(rows.getFirst().data);
  }
}
