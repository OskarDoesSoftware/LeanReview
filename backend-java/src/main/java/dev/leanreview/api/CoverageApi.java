package dev.leanreview.api;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.analysis.*;
import dev.leanreview.coverage.*;
import dev.leanreview.llm.Cancellation;
import dev.leanreview.storage.*;
import jakarta.servlet.http.HttpServletRequest;
import java.io.*;
import java.util.*;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/sessions/{id}/coverage")
public class CoverageApi {
  private final ObjectMapper json;
  private final ReviewStore reviews;
  private final CoreSnapshots snapshots;
  private final AnalysisStore store;
  private final CoverageMetrics metrics;
  private final TestJobs tests;
  private final CapturedArtifacts artifacts;

  public CoverageApi(
      ObjectMapper json,
      ReviewStore reviews,
      CoreSnapshots snapshots,
      AnalysisStore store,
      CoverageMetrics metrics,
      TestJobs tests,
      CapturedArtifacts artifacts) {
    this.json = json;
    this.reviews = reviews;
    this.snapshots = snapshots;
    this.store = store;
    this.metrics = metrics;
    this.tests = tests;
    this.artifacts = artifacts;
  }

  private ResponseEntity<String> reply(Object value, int status) throws IOException {
    return ResponseEntity.status(status)
        .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
        .body(json.writeValueAsString(value));
  }

  private static String format(String value) {
    if (!value.equals("istanbul") && !value.equals("jacoco"))
      throw new IllegalArgumentException("Invalid coverage format.");
    return value;
  }

  private JsonNode current(String id, JsonNode body) throws IOException {
    return snapshots.current(id, WireInput.text(body, "snapshotId")).path("snapshot");
  }

  private static double threshold(JsonNode body) {
    JsonNode n = body.path("threshold");
    if (n.isMissingNode()) return 8;
    if (!n.isNumber() || !Double.isFinite(n.asDouble()) || n.asDouble() < 0 || n.asDouble() > 1e6)
      throw new IllegalArgumentException("Invalid threshold.");
    return n.asDouble();
  }

  @GetMapping
  public ResponseEntity<String> view(
      @PathVariable String id,
      @RequestParam(required = false) String snapshot,
      @RequestParam(defaultValue = "istanbul") String format)
      throws IOException {
    format = format(format);
    JsonNode snap = reviews.review(id, snapshot).path("snapshot"),
        config = tests.config(snap.path("root").asText(), format),
        saved = store.coverage(snap.path("id").asText(), format);
    if (saved == null)
      saved =
          metrics.measure(
              snap,
              format,
              null,
              null,
              config == null ? 8 : config.path("threshold").asDouble(8),
              new Cancellation());
    ObjectNode result = json.createObjectNode();
    result.set("config", config == null ? NullNode.instance : config);
    result.set("metrics", saved);
    result.set("run", store.latestTest(snap.path("id").asText()));
    return reply(result, 200);
  }

  @PostMapping("/config")
  public ResponseEntity<String> config(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    JsonNode body = WireInput.body(request), snap = current(id, body), input = body.path("config");
    WireInput.object(input);
    ObjectNode config =
        json.createObjectNode()
            .put("format", WireInput.choice(input, "format", "istanbul", "jacoco"));
    config
        .put("cwd", input.has("cwd") ? WireInput.text(input, "cwd", 1, 1000, false) : ".")
        .put("reportPath", WireInput.text(input, "reportPath", 1, 1000, false));
    int timeout = WireInput.positive(input, "timeoutSeconds", 600);
    if (timeout > 3600) throw new IllegalArgumentException("Invalid timeoutSeconds.");
    config.put("timeoutSeconds", timeout).put("threshold", threshold(input));
    JsonNode steps = input.path("steps");
    if (!steps.isArray() || steps.isEmpty() || steps.size() > 6)
      throw new IllegalArgumentException("Invalid test steps.");
    ArrayNode clean = config.putArray("steps");
    for (JsonNode step : steps) {
      ObjectNode entry =
          json.createObjectNode()
              .put("executable", WireInput.text(step, "executable", 1, 2000, true));
      ArrayNode args = WireInput.strings(step, "args");
      if (args.size() > 100) throw new IllegalArgumentException("Invalid test arguments.");
      for (JsonNode arg : args)
        if (arg.asText().length() > 4000)
          throw new IllegalArgumentException("Invalid test argument length.");
      entry.set("args", args.deepCopy());
      if (step.has("shell") && !step.path("shell").isBoolean())
        throw new IllegalArgumentException("Invalid shell flag.");
      entry.put("shell", step.path("shell").asBoolean(false));
      clean.add(entry);
    }
    tests.config(snap.path("root").asText(), config);
    return reply(config, 200);
  }

  @PostMapping("/import")
  public ResponseEntity<String> importReport(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    String mime =
        Objects.toString(request.getContentType(), "")
            .split(";", 2)[0]
            .strip()
            .toLowerCase(Locale.ROOT);
    if (!Set.of("application/vnd.leanreview.coverage+json", "application/json").contains(mime))
      throw new IllegalArgumentException("Expected coverage report content type.");
    JsonNode body = WireInput.body(request, 20 * 1024 * 1024), snap = current(id, body);
    String format = WireInput.choice(body, "format", "istanbul", "jacoco"),
        raw = WireInput.text(body, "report", 1, Integer.MAX_VALUE, false);
    JsonNode provenance = body.get("provenance");
    ObjectNode measured =
        metrics.measure(snap, format, raw, provenance, threshold(body), new Cancellation());
    String hash = artifacts.write(raw);
    store.saveCoverage(measured, hash, provenance);
    return reply(measured, 200);
  }

  @GetMapping("/artifact")
  public ResponseEntity<String> artifact(
      @PathVariable String id,
      @RequestParam(required = false) String snapshot,
      @RequestParam String format)
      throws IOException {
    JsonNode snap = reviews.review(id, snapshot).path("snapshot");
    ObjectNode stored = store.coverageArtifact(snap.path("id").asText(), format(format));
    stored.put("report", artifacts.read(stored.path("hash").asText()));
    stored.remove("hash");
    return reply(stored, 200);
  }

  @PostMapping("/preview")
  public ResponseEntity<String> preview(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    JsonNode body = WireInput.body(request);
    return reply(
        tests.prepare(current(id, body), WireInput.choice(body, "format", "istanbul", "jacoco")),
        200);
  }

  @PostMapping("/run")
  public ResponseEntity<String> run(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    JsonNode body = WireInput.body(request), snap = current(id, body);
    if (!body.path("confirmed").isBoolean() || !body.path("confirmed").asBoolean()) {
      ObjectNode error = json.createObjectNode().put("code", "invalid_value");
      error.putArray("values").add(true);
      error.putArray("path").add("confirmed");
      error.put("message", "Invalid input: expected true");
      throw WireInput.errors(json.createArrayNode().add(error));
    }
    return reply(tests.start(snap, WireInput.text(body, "previewId")), 202);
  }

  @PostMapping("/cancel")
  public ResponseEntity<String> cancel(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    JsonNode body = WireInput.body(request), snap = current(id, body);
    String runId = WireInput.text(body, "runId");
    if (!store.test(runId).path("snapshotId").equals(snap.path("id")))
      throw new IllegalArgumentException("Test run does not belong to this snapshot.");
    tests.cancel(runId);
    return reply(Map.of("ok", true), 200);
  }
}
