package dev.leanreview.storage;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
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
