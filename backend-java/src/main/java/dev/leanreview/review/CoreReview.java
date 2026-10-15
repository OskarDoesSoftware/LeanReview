package dev.leanreview.review;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.api.WireInput;
import dev.leanreview.storage.*;
import java.io.*;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class CoreReview {
  private final ReviewStore reviews;
  private final CoreSnapshots snapshots;
  private final ObjectMapper json;

  public CoreReview(ReviewStore reviews, CoreSnapshots snapshots, ObjectMapper json) {
    this.reviews = reviews;
    this.snapshots = snapshots;
    this.json = json;
  }

  @Transactional(rollbackFor = Exception.class)
  public ObjectNode mutate(String id, JsonNode body, String action, String draftId)
      throws IOException {
    String expected = WireInput.text(body, "snapshotId");
    ObjectNode review = snapshots.current(id, expected);
    JsonNode snapshot = review.path("snapshot");
    if (action.equals("drafts") || action.equals("delete-draft"))
      for (JsonNode submission : review.path("state").path("githubSubmissions"))
        if (Set.of("sending", "uncertain").contains(submission.path("status").asText()))
          throw new IllegalArgumentException(
              "Reconcile the pending GitHub submission before editing drafts.");
    var files = new HashMap<String, JsonNode>();
    snapshot.path("files").forEach(file -> files.put(file.path("id").asText(), file));
    return reviews.updateCurrentState(
        id,
        expected,
        state -> {
          switch (action) {
            case "progress" -> {
              ArrayNode ids = WireInput.strings(body, "fileIds");
              if (!body.path("reviewed").isBoolean())
                throw WireInput.invalid("boolean", body.path("reviewed"), "reviewed");
              for (JsonNode file : ids)
                if (!files.containsKey(file.asText()))
                  throw new IllegalArgumentException("Unknown file in progress update.");
              var reviewed = new LinkedHashSet<String>();
              state.path("reviewed").forEach(node -> reviewed.add(node.asText()));
              for (JsonNode file : ids)
                if (body.path("reviewed").asBoolean()) reviewed.add(file.asText());
                else reviewed.remove(file.asText());
              ArrayNode result = state.putArray("reviewed");
              reviewed.forEach(result::add);
            }
            case "grouping" -> {
              state.set("accepted", grouping(body.path("analysis"), files));
              if (body.path("acceptProposal").asBoolean()) {
                state.putNull("proposal");
                state.remove("groupingCarriedForward");
              }
            }
            case "drafts" -> {
              String fileId = WireInput.text(body, "fileId"),
                  side = WireInput.choice(body, "side", "before", "after"),
                  text = WireInput.text(body, "text", 1, 10000, true);
              int line = WireInput.positive(body, "line", 0);
              JsonNode file = files.get(fileId), content = file == null ? null : file.path(side);
              if (content == null
                  || !content.path("kind").asText().equals("text")
                  || line > content.path("text").asText().split("\n", -1).length)
                throw new IllegalArgumentException("Comment location is outside captured text.");
              state
                  .withArray("drafts")
                  .addObject()
                  .put("fileId", fileId)
                  .put("side", side)
                  .put("line", line)
                  .put("text", text)
                  .put("id", UUID.randomUUID().toString())
                  .put("path", file.path("path").asText())
                  .put("needsReattachment", false);
            }
            case "delete-draft" -> {
              ArrayNode drafts = json.createArrayNode();
              state
                  .path("drafts")
                  .forEach(
                      draft -> {
                        if (!draft.path("id").asText().equals(draftId)) drafts.add(draft);
                      });
              state.set("drafts", drafts);
            }
            default -> throw new IllegalArgumentException("Unknown review operation.");
          }
        });
  }

  public JsonNode validateAnalysis(JsonNode input, JsonNode snapshot) {
    var files = new HashMap<String, JsonNode>();
    snapshot.path("files").forEach(file -> files.put(file.path("id").asText(), file));
    return grouping(input, files);
  }

  private JsonNode grouping(JsonNode input, Map<String, JsonNode> files) {
    WireInput.object(input);
    JsonNode cohorts = input.path("cohorts");
    if (!cohorts.isArray()) throw WireInput.invalid("array", cohorts, "cohorts");
    if (cohorts.isEmpty()) {
      ObjectNode issue =
          json.createObjectNode()
              .put("origin", "array")
              .put("code", "too_small")
              .put("minimum", 1)
              .put("inclusive", true);
      issue.putArray("path").add("cohorts");
      issue.put("message", "Too small: expected array to have >=1 items");
      throw WireInput.errors(json.createArrayNode().add(issue));
    }
    ObjectNode result = json.createObjectNode();
    ArrayNode output = result.putArray("cohorts");
    var seen = new HashSet<String>();
    for (JsonNode cohort : cohorts) {
      ObjectNode c =
          output
              .addObject()
              .put("name", WireInput.text(cohort, "name", 1, 100, false))
              .put("explanation", WireInput.text(cohort, "explanation", 0, 2000, false));
      JsonNode layers = cohort.path("layers");
      if (!layers.isArray() || layers.isEmpty())
        throw new IllegalArgumentException("Analysis contains an empty cohort.");
      ArrayNode ls = c.putArray("layers");
      for (JsonNode layer : layers) {
        ObjectNode l =
            ls.addObject()
                .put("name", WireInput.text(layer, "name", 1, 100, false))
                .put("explanation", WireInput.text(layer, "explanation", 0, 2000, false));
        ArrayNode ids = WireInput.strings(layer, "fileIds");
        if (ids.isEmpty()) throw new IllegalArgumentException("Analysis contains an empty layer.");
        for (JsonNode file : ids)
          if (!files.containsKey(file.asText()) || !seen.add(file.asText()))
            throw new IllegalArgumentException("Analysis contains an invented or duplicated file.");
        l.set("fileIds", ids.deepCopy());
      }
    }
    if (seen.size() != files.size())
      throw new IllegalArgumentException("Analysis omitted a changed file.");
    JsonNode findings = input.path("findings");
    if (!findings.isArray()) throw WireInput.invalid("array", findings, "findings");
    ArrayNode fs = result.putArray("findings");
    for (JsonNode finding : findings) {
      String id = WireInput.text(finding, "fileId");
      JsonNode file = files.get(id);
      if (file == null) throw new IllegalArgumentException("Finding references an invented file.");
      JsonNode line = finding.path("line");
      if (!line.isNull()
          && (!line.isIntegralNumber()
              || line.asLong() < 1
              || !file.path("after").path("kind").asText().equals("text")
              || line.asLong() > file.path("after").path("text").asText().split("\n", -1).length))
        throw new IllegalArgumentException("Finding line is outside the captured file.");
      ObjectNode f =
          fs.addObject()
              .put("fileId", id)
              .put(
                  "kind",
                  WireInput.choice(
                      finding, "kind", "bug", "security", "performance", "improvement"))
              .put("message", WireInput.text(finding, "message", 1, 4000, false));
      f.set("line", line.deepCopy());
    }
    return result;
  }
}
