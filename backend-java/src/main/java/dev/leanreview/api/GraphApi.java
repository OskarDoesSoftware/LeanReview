package dev.leanreview.api;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.graph.GraphJobs;
import dev.leanreview.storage.ReviewStore;
import jakarta.servlet.http.HttpServletRequest;
import java.io.*;
import java.util.Map;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/sessions/{id}/graph")
public class GraphApi {
  private final ObjectMapper json;
  private final ReviewStore reviews;
  private final GraphJobs graphs;

  public GraphApi(ObjectMapper json, ReviewStore reviews, GraphJobs graphs) {
    this.json = json;
    this.reviews = reviews;
    this.graphs = graphs;
  }

  private ResponseEntity<String> reply(Object value, int status) throws IOException {
    return ResponseEntity.status(status)
        .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
        .body(json.writeValueAsString(value));
  }

  private String side(String side) {
    if (!side.equals("before") && !side.equals("after"))
      throw new IllegalArgumentException("Invalid side.");
    return side;
  }

  @GetMapping
  public ResponseEntity<String> view(
      @PathVariable String id,
      @RequestParam String snapshot,
      @RequestParam(defaultValue = "after") String side,
      @RequestParam(defaultValue = "0") String statusOnly)
      throws IOException {
    reviews.review(id, snapshot);
    return reply(graphs.view(snapshot, side(side), statusOnly.equals("1")), 200);
  }

  @PostMapping
  public ResponseEntity<String> start(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    JsonNode body = WireInput.body(request);
    String snapshot = WireInput.text(body, "snapshotId");
    JsonNode input = body.path("options");
    WireInput.object(input);
    String side = input.has("side") ? WireInput.choice(input, "side", "before", "after") : "after";
    ArrayNode errors = json.createArrayNode();
    int maxFiles = limit(input, "maxFiles", 10000, 1, 50000, errors),
        maxBytes = limit(input, "maxBytes", 20 * 1024 * 1024, 1024, 100 * 1024 * 1024, errors);
    if (!errors.isEmpty()) throw WireInput.errors(errors);
    ObjectNode options =
        json.createObjectNode()
            .put("side", side)
            .put("maxFiles", maxFiles)
            .put("maxBytes", maxBytes);
    return reply(graphs.start(reviews.review(id, snapshot).path("snapshot"), options), 202);
  }

  private int limit(JsonNode input, String key, int fallback, int min, int max, ArrayNode errors) {
    JsonNode value = input.path(key);
    if (value.isMissingNode()) return fallback;
    if (!value.isNumber()
        || !Double.isFinite(value.asDouble())
        || value.asDouble() != Math.floor(value.asDouble())) {
      errors.add(WireInput.typeError("number", value, "options", key));
      return fallback;
    }
    if (value.asDouble() < min || value.asDouble() > max) {
      boolean small = value.asDouble() < min;
      int bound = small ? min : max;
      ObjectNode error =
          json.createObjectNode()
              .put("origin", "number")
              .put("code", small ? "too_small" : "too_big")
              .put(small ? "minimum" : "maximum", bound)
              .put("inclusive", true);
      error.putArray("path").add("options").add(key);
      error.put(
          "message",
          (small ? "Too small: expected number to be >=" : "Too big: expected number to be <=")
              + bound);
      errors.add(error);
      return fallback;
    }
    return value.asInt();
  }

  @PostMapping("/cancel")
  public ResponseEntity<String> cancel(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    String snapshot = WireInput.text(WireInput.body(request), "snapshotId");
    reviews.review(id, snapshot);
    graphs.cancel(snapshot);
    return reply(Map.of("ok", true), 200);
  }

  @GetMapping("/source")
  public ResponseEntity<String> source(
      @PathVariable String id,
      @RequestParam String snapshot,
      @RequestParam String node,
      @RequestParam(defaultValue = "after") String side)
      throws IOException {
    reviews.review(id, snapshot);
    return reply(graphs.source(snapshot, side(side), node), 200);
  }
}
