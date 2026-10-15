package dev.leanreview.storage;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.time.Instant;
import java.time.format.DateTimeFormatterBuilder;
import java.util.Objects;
import java.util.function.Consumer;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Maps persisted JSON to the existing API shape without exposing JPA entities. */
@Service
public class ReviewStore {
  private final Repositories.Sessions sessions;
  private final Repositories.Snapshots snapshots;
  private final CapturedArtifacts artifacts;
  private final ObjectMapper json;

  public ReviewStore(
      Repositories.Sessions sessions,
      Repositories.Snapshots snapshots,
      CapturedArtifacts artifacts,
      ObjectMapper json) {
    this.sessions = sessions;
    this.snapshots = snapshots;
    this.artifacts = artifacts;
    this.json = json;
  }

  /** Validate and mutate within one transaction, preserving unknown state fields. */
  @Transactional(rollbackFor = Exception.class)
  public ObjectNode updateCurrentState(
      String sessionId, String snapshotId, Consumer<ObjectNode> update) throws IOException {
    Rows.Session session =
        sessions
            .findById(sessionId)
            .orElseThrow(() -> new IllegalArgumentException("Review session not found."));
    if (!Objects.equals(session.activeSnapshot, snapshotId)) {
      throw new IllegalArgumentException("Snapshot changed. Reload this review before editing.");
    }
    Rows.Snapshot row =
        snapshots
            .findByIdAndSessionId(snapshotId, sessionId)
            .orElseThrow(() -> new IllegalArgumentException("Snapshot not found."));
    ObjectNode state = (ObjectNode) json.readTree(row.state);
    update.accept(state);
    row.state = json.writeValueAsString(state);
    session.updatedAt =
        new DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.now());
    snapshots.flush();
    return review(sessionId, null);
  }

  @Transactional(readOnly = true)
  public ObjectNode review(String sessionId, String snapshotId) throws IOException {
    Rows.Session session =
        sessions
            .findById(sessionId)
            .orElseThrow(() -> new IllegalArgumentException("Review session not found."));
    Rows.Snapshot row =
        snapshots
            .findByIdAndSessionId(
                snapshotId == null ? session.activeSnapshot : snapshotId, sessionId)
            .orElseThrow(() -> new IllegalArgumentException("Snapshot not found."));
    ObjectNode snapshot = (ObjectNode) json.readTree(row.data);
    for (JsonNode value : snapshot.withArray("files")) {
      ObjectNode file = (ObjectNode) value;
      for (String side : new String[] {"before", "after"}) {
        JsonNode content = file.get(side);
        if ("text".equals(content.path("kind").asText()))
          file.set(
              side,
              json.createObjectNode()
                  .put("kind", "text")
                  .put("text", artifacts.read(content.path("hash").asText())));
      }
      file.put("patch", artifacts.read(file.path("patchHash").asText()));
    }
    ObjectNode result = json.createObjectNode();
    result.set("snapshot", snapshot);
    result.set("state", json.readTree(row.state));
    var history = result.putArray("history");
    for (Rows.Snapshot previous : snapshots.history(sessionId))
      history
          .addObject()
          .put("id", previous.id)
          .set("capturedAt", json.readTree(previous.data).get("capturedAt"));
    return result;
  }
}
