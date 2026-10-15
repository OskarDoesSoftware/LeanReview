package dev.leanreview.storage;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.io.IOException;
import java.nio.file.Path;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Transactional snapshot writes. Git capture is completed before entering this service. */
@Service
public class CoreSnapshots {
  private final Repositories.Sessions sessions;
  private final Repositories.Snapshots snapshots;
  private final Repositories.Settings settings;
  private final CapturedArtifacts artifacts;
  private final ReviewStore reviews;
  private final ObjectMapper json;

  public CoreSnapshots(
      Repositories.Sessions sessions,
      Repositories.Snapshots snapshots,
      Repositories.Settings settings,
      CapturedArtifacts artifacts,
      ReviewStore reviews,
      ObjectMapper json) {
    this.sessions = sessions;
    this.snapshots = snapshots;
    this.settings = settings;
    this.artifacts = artifacts;
    this.reviews = reviews;
    this.json = json;
  }

  public ObjectNode emptyState() {
    ObjectNode state = json.createObjectNode();
    state.putArray("reviewed");
    state.putNull("accepted");
    state.putNull("proposal");
    state.putArray("drafts");
    state.put("analysisStatus", "idle");
    return state;
  }

  private String encode(ObjectNode snapshot) throws IOException {
    ObjectNode data = snapshot.deepCopy();
    for (JsonNode node : data.withArray("files")) {
      ObjectNode file = (ObjectNode) node;
      for (String side : List.of("before", "after"))
        if (file.path(side).path("kind").asText().equals("text"))
          file.set(
              side,
              json.createObjectNode()
                  .put("kind", "text")
                  .put("hash", artifacts.write(file.path(side).path("text").asText())));
      file.put("patchHash", artifacts.write(file.path("patch").asText()));
      file.remove("patch");
    }
    return json.writeValueAsString(data);
  }

  @Transactional(rollbackFor = Exception.class)
  public ObjectNode create(ObjectNode snapshot) throws IOException {
    Rows.Session session = new Rows.Session();
    session.id = snapshot.path("sessionId").asText();
    session.name = Path.of(snapshot.path("root").asText()).getFileName().toString();
    session.root = snapshot.path("root").asText();
    session.activeSnapshot = snapshot.path("id").asText();
    session.updatedAt = snapshot.path("capturedAt").asText();
    String encoded = encode(snapshot);
    sessions.saveAndFlush(session);
    saveSnapshot(snapshot, encoded, emptyState());
    return reviews.review(session.id, null);
  }

  private void saveSnapshot(ObjectNode snapshot, String encoded, ObjectNode state)
      throws IOException {
    Rows.Snapshot row = new Rows.Snapshot();
    row.id = snapshot.path("id").asText();
    row.sessionId = snapshot.path("sessionId").asText();
    row.data = encoded;
    row.state = json.writeValueAsString(state);
    snapshots.saveAndFlush(row);
  }

  @Transactional(rollbackFor = Exception.class)
  public ObjectNode refresh(String sessionId, String expected, ObjectNode snapshot)
      throws IOException {
    ObjectNode previous = current(sessionId, expected);
    if (!snapshot.path("sessionId").asText().equals(sessionId))
      throw new IllegalArgumentException("Snapshot belongs to another review.");
    if (snapshots.existsById(snapshot.path("id").asText()))
      throw new IllegalArgumentException("Snapshot already exists.");
    var unchanged = new HashSet<String>();
    var old = new HashMap<String, JsonNode>();
    for (JsonNode file : previous.path("snapshot").path("files"))
      old.put(file.path("id").asText(), file);
    for (JsonNode file : snapshot.path("files")) {
      JsonNode prior = old.get(file.path("id").asText());
      if (prior != null
          && prior.path("fingerprint").equals(file.path("fingerprint"))
          && prior.path("before").equals(file.path("before"))
          && prior.path("after").equals(file.path("after"))
          && prior.path("patch").equals(file.path("patch")))
        unchanged.add(file.path("id").asText());
    }
    ObjectNode state = emptyState();
    for (JsonNode id : previous.path("state").path("reviewed"))
      if (unchanged.contains(id.asText())) state.withArray("reviewed").add(id);
    for (JsonNode draft : previous.path("state").path("drafts")) {
      ObjectNode copy = draft.deepCopy();
      copy.put(
          "needsReattachment",
          copy.path("needsReattachment").asBoolean()
              || !unchanged.contains(copy.path("fileId").asText()));
      state.withArray("drafts").add(copy);
    }
    saveSnapshot(snapshot, encode(snapshot), state);
    Rows.Session session = sessions.findById(sessionId).orElseThrow();
    session.activeSnapshot = snapshot.path("id").asText();
    session.updatedAt = snapshot.path("capturedAt").asText();
    sessions.flush();
    return reviews.review(sessionId, null);
  }

  @Transactional(readOnly = true)
  public ObjectNode current(String id, String expected) throws IOException {
    ObjectNode review = reviews.review(id, null);
    if (!review.path("snapshot").path("id").asText().equals(expected))
      throw new IllegalArgumentException("Snapshot changed. Reload this review before editing.");
    return review;
  }

  @Transactional(readOnly = true)
  public ArrayNode list() {
    ArrayNode result = json.createArrayNode();
    var ordered = new ArrayList<>(sessions.findAll());
    ordered.sort(Comparator.comparing((Rows.Session s) -> s.updatedAt).reversed());
    for (Rows.Session row : ordered)
      result
          .addObject()
          .put("id", row.id)
          .put("name", row.name)
          .put("root", row.root)
          .put("updatedAt", row.updatedAt);
    return result;
  }

  @Transactional(readOnly = true)
  public JsonNode setting(String key) throws IOException {
    var row = settings.findById(key);
    return row.isPresent() ? json.readTree(row.get().value) : json.nullNode();
  }

  @Transactional(rollbackFor = Exception.class)
  public JsonNode setting(String key, JsonNode value) throws IOException {
    var row = settings.findById(key).orElseGet(Rows.Setting::new);
    row.key = key;
    row.value = json.writeValueAsString(value);
    settings.saveAndFlush(row);
    return value;
  }
}
