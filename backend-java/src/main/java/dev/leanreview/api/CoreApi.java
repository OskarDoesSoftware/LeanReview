package dev.leanreview.api;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.git.LocalSnapshots;
import dev.leanreview.review.*;
import dev.leanreview.storage.*;
import jakarta.servlet.http.HttpServletRequest;
import java.io.*;
import java.util.*;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class CoreApi {
  private final ObjectMapper json;
  private final CoreSnapshots snapshots;
  private final ReviewStore reviews;
  private final LocalSnapshots git;
  private final CoreReview operations;
  private final dev.leanreview.editor.EditorService editors;
  private final ReviewAnalysis analysis;
  private final dev.leanreview.github.GitHubReviews github;

  public CoreApi(
      ObjectMapper json,
      CoreSnapshots snapshots,
      ReviewStore reviews,
      LocalSnapshots git,
      CoreReview operations,
      dev.leanreview.editor.EditorService editors,
      ReviewAnalysis analysis,
      dev.leanreview.github.GitHubReviews github) {
    this.json = json;
    this.snapshots = snapshots;
    this.reviews = reviews;
    this.git = git;
    this.operations = operations;
    this.editors = editors;
    this.analysis = analysis;
    this.github = github;
  }

  private ResponseEntity<String> reply(Object value) throws IOException {
    return ResponseEntity.ok()
        .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
        .body(json.writeValueAsString(value));
  }

  @GetMapping("/sessions")
  public ResponseEntity<String> sessions() throws IOException {
    return reply(snapshots.list());
  }

  @GetMapping("/sessions/{id}")
  public ResponseEntity<String> review(
      @PathVariable String id, @RequestParam(required = false) String snapshot) throws IOException {
    return reply(reviews.review(id, snapshot));
  }

  @PostMapping("/sessions")
  public ResponseEntity<String> create(HttpServletRequest request) throws IOException {
    JsonNode body = WireInput.body(request);
    WireInput.object(body);
    ArrayNode errors = json.createArrayNode();
    if (!body.path("root").isTextual())
      errors.add(WireInput.typeError("string", body.path("root"), "root"));
    if (!body.path("comparison").isObject())
      errors.add(WireInput.typeError("object", body.path("comparison"), "comparison"));
    if (!errors.isEmpty()) throw WireInput.errors(errors);
    String root = WireInput.text(body, "root", 1, Integer.MAX_VALUE, false);
    ObjectNode comparison = WireInput.comparison(body.path("comparison"));
    return reply(
        snapshots.create(git.capture(git.select(root), comparison, UUID.randomUUID().toString())));
  }

  @PostMapping("/sessions/{id}/refresh")
  public ResponseEntity<String> refresh(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    JsonNode body = WireInput.body(request);
    WireInput.object(body);
    String expected = WireInput.text(body, "snapshotId");
    JsonNode previous = snapshots.current(id, expected).path("snapshot");
    for (JsonNode submission :
        snapshots.current(id, expected).path("state").path("githubSubmissions"))
      if (Set.of("sending", "uncertain").contains(submission.path("status").asText()))
        throw new IllegalArgumentException(
            "Reconcile the pending GitHub submission before refreshing.");
    analysis.cancel(expected);
    if (previous.path("source").path("provider").asText().equals("github"))
      return reply(github.refresh(id, expected));
    // No connection is held during Git capture; refresh rechecks the current ID transactionally.
    ObjectNode next =
        git.capture(git.select(previous.path("root").asText()), previous.path("comparison"), id);
    return reply(snapshots.refresh(id, expected, next));
  }

  @PostMapping("/sessions/{id}/{operation:progress|grouping|drafts}")
  public ResponseEntity<String> mutate(
      @PathVariable String id, @PathVariable String operation, HttpServletRequest request)
      throws IOException {
    JsonNode body = WireInput.body(request);
    WireInput.object(body);
    return reply(operations.mutate(id, body, operation, null));
  }

  @DeleteMapping("/sessions/{id}/drafts/{draft}")
  public ResponseEntity<String> delete(
      @PathVariable String id, @PathVariable String draft, HttpServletRequest request)
      throws IOException {
    JsonNode body = WireInput.body(request);
    WireInput.object(body);
    return reply(operations.mutate(id, body, "delete-draft", draft));
  }

  @GetMapping("/provider")
  public ResponseEntity<String> provider() throws IOException {
    return reply(snapshots.setting("provider"));
  }

  @GetMapping("/editor")
  public ResponseEntity<String> editor() throws IOException {
    return reply(editors.view());
  }

  @PostMapping("/editor")
  public ResponseEntity<String> editor(HttpServletRequest request) throws IOException {
    return reply(editors.configure(WireInput.body(request)));
  }

  @PostMapping("/sessions/{id}/open-editor")
  public ResponseEntity<String> open(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    JsonNode body = WireInput.body(request);
    WireInput.object(body);
    return reply(editors.open(id, body));
  }

  @RequestMapping("/**")
  public ResponseEntity<String> missing() throws IOException {
    return ResponseEntity.status(404)
        .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
        .body(json.writeValueAsString(Map.of("error", "API endpoint not found.")));
  }
}
