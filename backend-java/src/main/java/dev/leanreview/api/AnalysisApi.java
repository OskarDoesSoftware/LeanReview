package dev.leanreview.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.leanreview.review.ReviewAnalysis;
import dev.leanreview.storage.CoreSnapshots;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class AnalysisApi {
  private final ReviewAnalysis analysis;
  private final CoreSnapshots snapshots;
  private final ObjectMapper json;

  public AnalysisApi(ReviewAnalysis analysis, CoreSnapshots snapshots, ObjectMapper json) {
    this.analysis = analysis;
    this.snapshots = snapshots;
    this.json = json;
  }

  private ResponseEntity<String> reply(Object value, int status) throws Exception {
    return ResponseEntity.status(status)
        .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
        .body(json.writeValueAsString(value));
  }

  @PostMapping("/provider")
  public ResponseEntity<String> provider(HttpServletRequest request) throws Exception {
    return reply(analysis.configure(WireInput.body(request)), 200);
  }

  @GetMapping("/sessions/{id}/manifest")
  public ResponseEntity<String> manifest(@PathVariable String id) throws Exception {
    return reply(analysis.manifest(id), 200);
  }

  @PostMapping("/sessions/{id}/analysis")
  public ResponseEntity<String> start(@PathVariable String id, HttpServletRequest request)
      throws Exception {
    return reply(analysis.start(id, WireInput.body(request)), 202);
  }

  @PostMapping("/sessions/{id}/cancel")
  public ResponseEntity<String> cancel(@PathVariable String id, HttpServletRequest request)
      throws Exception {
    var body = WireInput.body(request);
    WireInput.object(body);
    String snapshot = WireInput.text(body, "snapshotId");
    snapshots.current(id, snapshot);
    analysis.cancel(snapshot);
    return reply(java.util.Map.of("ok", true), 200);
  }
}
