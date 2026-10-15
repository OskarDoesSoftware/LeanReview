package dev.leanreview.github;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.api.WireInput;
import dev.leanreview.storage.*;
import java.io.IOException;
import java.util.*;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/** Remote reads and writes stay outside database transactions; publication has a durable outbox. */
@Service
public class GitHubFeedback {
  private final GitHubCli cli;
  private final GitHubReviews github;
  private final CoreSnapshots snapshots;
  private final ReviewStore reviews;
  private final ObjectMapper json;

  public GitHubFeedback(
      GitHubCli cli,
      GitHubReviews github,
      CoreSnapshots snapshots,
      ReviewStore reviews,
      ObjectMapper json) {
    this.cli = cli;
    this.github = github;
    this.snapshots = snapshots;
    this.reviews = reviews;
    this.json = json;
  }

  private JsonNode source(JsonNode review) {
    JsonNode source = review.path("snapshot").path("source");
    if (!source.path("provider").asText().equals("github"))
      throw new IllegalArgumentException("This review is not a GitHub pull request.");
    return source;
  }

  private String target(JsonNode source) {
    return "repos/"
        + source.path("fullName").asText()
        + "/pulls/"
        + source.path("pullNumber").asInt();
  }

  private JsonNode graphql(String query, ObjectNode variables) throws IOException {
    ObjectNode request = json.createObjectNode().put("query", query);
    request.set("variables", variables);
    JsonNode result = cli.api("POST", "graphql", request);
    if (result.has("errors"))
      throw new IOException(
          "GitHub could not complete the discussion request. Check permissions and retry.");
    return result.path("data");
  }

  public ObjectNode status(String id) throws IOException {
    JsonNode review = reviews.review(id, null),
        source = source(review),
        latest = github.latest(source);
    return json.createObjectNode()
        .put(
            "newCommits",
            !latest.path("head").path("sha").asText().equals(source.path("headSha").asText())
                || !latest
                    .path("base")
                    .path("sha")
                    .asText()
                    .equals(source.path("baseSha").asText()));
  }

  public ObjectNode discussions(String id) throws IOException {
    JsonNode source = source(reviews.review(id, null));
    String[] repo = source.path("fullName").asText().split("/");
    ObjectNode vars =
        json.createObjectNode()
            .put("owner", repo[0])
            .put("repo", repo[1])
            .put("number", source.path("pullNumber").asInt());
    ObjectNode result = json.createObjectNode();
    ArrayNode threads = result.putArray("threads");
    for (int page = 0; page < 100; page++) {
      JsonNode connection =
          graphql(
                  "query($owner:String!,$repo:String!,$number:Int!,$cursor:String){"
                      + " repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id"
                      + " isResolved isOutdated path line comments(first:100){nodes{databaseId body"
                      + " author{login}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage"
                      + " endCursor}}}}}",
                  vars)
              .path("repository")
              .path("pullRequest")
              .path("reviewThreads");
      if (!connection.path("nodes").isArray())
        throw new IOException("GitHub discussions are unavailable.");
      for (JsonNode thread : connection.path("nodes")) {
        ObjectNode copy = thread.deepCopy();
        ArrayNode comments = ((ArrayNode) copy.path("comments").path("nodes")).deepCopy();
        JsonNode info = thread.path("comments").path("pageInfo");
        int commentPages = 0;
        while (info.path("hasNextPage").asBoolean()) {
          if (++commentPages > 100)
            throw new IOException("Discussion exceeds the supported page limit.");
          ObjectNode next =
              json.createObjectNode()
                  .put("id", thread.path("id").asText())
                  .put("cursor", info.path("endCursor").asText());
          JsonNode more =
              graphql(
                      "query($id:ID!,$cursor:String!){node(id:$id){... on"
                          + " PullRequestReviewThread{comments(first:100,after:$cursor){nodes{databaseId"
                          + " body author{login}} pageInfo{hasNextPage endCursor}}}}}",
                      next)
                  .path("node")
                  .path("comments");
          if (!more.path("nodes").isArray()) throw new IOException("Discussion pagination failed.");
          comments.addAll((ArrayNode) more.path("nodes"));
          info = more.path("pageInfo");
        }
        copy.set("comments", comments);
        threads.add(copy);
      }
      if (!connection.path("pageInfo").path("hasNextPage").asBoolean()) break;
      if (page == 99) throw new IOException("Discussion listing exceeds the supported page limit.");
      vars.put("cursor", connection.path("pageInfo").path("endCursor").asText());
    }
    result.set("reviews", cli.pages(target(source) + "/reviews"));
    result.set(
        "comments",
        cli.pages(
            "repos/"
                + source.path("fullName").asText()
                + "/issues/"
                + source.path("pullNumber").asInt()
                + "/comments"));
    return result;
  }

  public JsonNode resolve(String id, JsonNode body) throws IOException {
    try (var lease = cli.writeLease()) {
      return resolveOwned(id, body);
    }
  }

  private JsonNode resolveOwned(String id, JsonNode body) throws IOException {
    snapshots.current(id, WireInput.text(body, "snapshotId"));
    String threadId = WireInput.text(body, "threadId", 1, 200, false);
    boolean found = false;
    for (JsonNode thread : discussions(id).path("threads"))
      if (thread.path("id").asText().equals(threadId)) found = true;
    if (!found)
      throw new IllegalArgumentException("Discussion does not belong to this pull request.");
    if (!body.path("resolved").isBoolean())
      throw new IllegalArgumentException("Choose resolve or reopen.");
    String action =
        body.path("resolved").asBoolean() ? "resolveReviewThread" : "unresolveReviewThread";
    return graphql(
        "mutation($id:ID!){" + action + "(input:{threadId:$id}){thread{id isResolved}}}",
        json.createObjectNode().put("id", threadId));
  }

  public ObjectNode replyDraft(String id, JsonNode body) throws IOException {
    String expected = WireInput.text(body, "snapshotId"),
        text = WireInput.text(body, "text", 1, 10000, true);
    long reply = body.path("replyTo").asLong();
    boolean found = false;
    for (JsonNode thread : discussions(id).path("threads"))
      for (JsonNode comment : thread.path("comments"))
        if (comment.path("databaseId").asLong() == reply) found = true;
    if (!found || reply <= 0)
      throw new IllegalArgumentException("Reply target is not in this pull request.");
    return reviews.updateCurrentState(
        id,
        expected,
        state ->
            state
                .withArray("drafts")
                .addObject()
                .put("id", UUID.randomUUID().toString())
                .put("replyTo", reply)
                .put("text", text)
                .put("fileId", "")
                .put("path", "")
                .put("side", "after")
                .put("line", 1)
                .put("needsReattachment", false));
  }

  private boolean lineInDiff(JsonNode file, String side, int requested) {
    int before = 0, after = 0;
    var header = Pattern.compile("^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@.*");
    boolean hunk = false;
    for (String line : file.path("patch").asText().split("\n")) {
      var match = header.matcher(line);
      if (match.matches()) {
        before = Integer.parseInt(match.group(1));
        after = Integer.parseInt(match.group(2));
        hunk = true;
        continue;
      }
      if (!hunk || line.isEmpty() || line.startsWith("\\")) continue;
      char prefix = line.charAt(0);
      if (side.equals("before") && prefix != '+' && requested == before) return true;
      if (side.equals("after") && prefix != '-' && requested == after) return true;
      if (prefix != '+') before++;
      if (prefix != '-') after++;
    }
    return false;
  }

  public ObjectNode checkDraft(String id, JsonNode body) throws IOException {
    String expected = WireInput.text(body, "snapshotId"), draftId = WireInput.text(body, "draftId");
    JsonNode review = snapshots.current(id, expected);
    source(review);
    for (JsonNode submission : review.path("state").path("githubSubmissions"))
      if (Set.of("sending", "uncertain").contains(submission.path("status").asText()))
        throw new IllegalArgumentException(
            "Reconcile the pending submission before changing draft positions.");
    JsonNode selected = null;
    for (JsonNode draft : review.path("state").path("drafts"))
      if (draft.path("id").asText().equals(draftId)) selected = draft;
    if (selected == null) throw new IllegalArgumentException("Draft no longer exists.");
    JsonNode draft = selected;
    if (draft.has("replyTo")) {
      boolean found = false;
      for (JsonNode thread : discussions(id).path("threads"))
        for (JsonNode comment : thread.path("comments"))
          if (comment.path("databaseId").equals(draft.path("replyTo"))) found = true;
      if (!found) throw new IllegalArgumentException("The reply target is no longer available.");
      return reviews.updateCurrentState(
          id,
          expected,
          state -> {
            for (JsonNode entry : state.path("drafts"))
              if (entry.path("id").asText().equals(draftId))
                ((ObjectNode) entry).put("needsReattachment", false);
          });
    }
    String fileId = WireInput.text(body, "fileId"),
        side = WireInput.choice(body, "side", "before", "after");
    int line = WireInput.positive(body, "line", 0);
    JsonNode file = null;
    for (JsonNode item : review.path("snapshot").path("files"))
      if (item.path("id").asText().equals(fileId)) file = item;
    if (file == null || !lineInDiff(file, side, line))
      throw new IllegalArgumentException("Choose a line in the current captured diff.");
    String path = file.path("path").asText();
    return reviews.updateCurrentState(
        id,
        expected,
        state -> {
          for (JsonNode entry : state.path("drafts"))
            if (entry.path("id").asText().equals(draftId))
              ((ObjectNode) entry)
                  .put("fileId", fileId)
                  .put("path", path)
                  .put("side", side)
                  .put("line", line)
                  .put("needsReattachment", false);
        });
  }

  public ObjectNode preview(String id, JsonNode body) throws IOException {
    ObjectNode review = snapshots.current(id, WireInput.text(body, "snapshotId"));
    JsonNode source = source(review);
    if (!review.path("snapshot").path("complete").asBoolean())
      throw new IllegalArgumentException(
          "The change set is incomplete. Publication is unavailable.");
    JsonNode latest = github.latest(source);
    if (!latest.path("head").path("sha").asText().equals(source.path("headSha").asText())
        || !latest.path("base").path("sha").asText().equals(source.path("baseSha").asText()))
      throw new IllegalArgumentException(
          "New commits are available. Refresh and check draft positions before publishing.");
    Set<String> ids = new LinkedHashSet<>();
    for (JsonNode item : WireInput.strings(body, "draftIds")) ids.add(item.asText());
    String decision = WireInput.choice(body, "decision", "COMMENT", "APPROVE", "REQUEST_CHANGES");
    ObjectNode result =
        json.createObjectNode()
            .put("decision", decision)
            .put("headSha", source.path("headSha").asText());
    ArrayNode selected = result.putArray("drafts");
    for (JsonNode draft : review.path("state").path("drafts"))
      if (ids.remove(draft.path("id").asText())) {
        if (draft.path("needsReattachment").asBoolean())
          throw new IllegalArgumentException("Check outdated draft positions before publishing.");
        if (!draft.has("replyTo")) {
          JsonNode file = null;
          for (JsonNode entry : review.path("snapshot").path("files"))
            if (entry.path("id").equals(draft.path("fileId"))) file = entry;
          if (file == null
              || !lineInDiff(file, draft.path("side").asText(), draft.path("line").asInt()))
            throw new IllegalArgumentException(
                "A selected draft is outside the captured diff. Choose a changed or context line.");
        }
        selected.add(draft);
      }
    if (!ids.isEmpty()) throw new IllegalArgumentException("A selected draft no longer exists.");
    return result;
  }

  public synchronized ObjectNode publish(String id, JsonNode body) throws IOException {
    try (var lease = cli.writeLease()) {
      return publishOwned(id, body);
    }
  }

  private ObjectNode publishOwned(String id, JsonNode body) throws IOException {
    String expected = WireInput.text(body, "snapshotId"),
        submission = WireInput.text(body, "submissionId", 36, 36, false);
    try {
      UUID.fromString(submission);
    } catch (Exception invalid) {
      throw new IllegalArgumentException("Invalid submission identity.");
    }
    ObjectNode review = snapshots.current(id, expected);
    JsonNode source = source(review);
    for (JsonNode prior : review.path("state").path("githubSubmissions")) {
      if (prior.path("id").asText().equals(submission))
        return reconcile(id, expected, prior, source);
      if (prior.path("status").asText().equals("uncertain")
          || prior.path("status").asText().equals("sending"))
        throw new IllegalArgumentException(
            "An earlier submission needs reconciliation before more feedback can be published.");
    }
    ObjectNode prepared = preview(id, body);
    String message = WireInput.text(body, "message", 0, 10000, true);
    ObjectNode record =
        prepared.deepCopy().put("id", submission).put("status", "sending").put("message", message);
    record.put("actor", cli.status().path("login").asText());
    record.putArray("confirmedDraftIds");
    reviews.updateCurrentState(
        id, expected, state -> state.withArray("githubSubmissions").add(record));
    try {
      ArrayNode inline = json.createArrayNode();
      for (JsonNode draft : prepared.path("drafts"))
        if (!draft.has("replyTo"))
          inline
              .addObject()
              .put("path", draft.path("path").asText())
              .put("line", draft.path("line").asInt())
              .put("side", draft.path("side").asText().equals("before") ? "LEFT" : "RIGHT")
              .put(
                  "body",
                  draft.path("text").asText()
                      + "\n\n<!-- leanreview:"
                      + submission
                      + ":"
                      + draft.path("id").asText()
                      + " -->");
      if (!inline.isEmpty()
          || !prepared.path("decision").asText().equals("COMMENT")
          || !message.isBlank()) {
        ObjectNode request =
            json.createObjectNode()
                .put("commit_id", source.path("headSha").asText())
                .put("event", prepared.path("decision").asText())
                .put("body", message + "\n\n<!-- leanreview:" + submission + " -->");
        request.set("comments", inline);
        JsonNode posted = cli.api("POST", target(source) + "/reviews", request);
        if (posted.path("id").asLong() <= 0
            || !posted.path("body").equals(request.path("body"))
            || !posted.path("user").path("login").equals(record.path("actor")))
          throw new IOException("GitHub publication confirmation is unavailable.");
        record.put("reviewConfirmed", true);
        for (JsonNode draft : prepared.path("drafts"))
          if (!draft.has("replyTo")) record.withArray("confirmedDraftIds").add(draft.path("id"));
        saveOutcome(id, expected, record);
      }
      for (JsonNode draft : prepared.path("drafts"))
        if (draft.has("replyTo")) {
          ObjectNode request =
              json.createObjectNode()
                  .put(
                      "body",
                      draft.path("text").asText()
                          + "\n\n<!-- leanreview:"
                          + submission
                          + ":"
                          + draft.path("id").asText()
                          + " -->");
          JsonNode posted =
              cli.api(
                  "POST",
                  target(source) + "/comments/" + draft.path("replyTo").asLong() + "/replies",
                  request);
          if (posted.path("id").asLong() <= 0
              || !posted.path("body").equals(request.path("body"))
              || !posted.path("user").path("login").equals(record.path("actor")))
            throw new IOException("GitHub reply confirmation is unavailable.");
          record.withArray("confirmedDraftIds").add(draft.path("id"));
          saveOutcome(id, expected, record);
        }
      record.put("status", "complete");
      saveOutcome(id, expected, record);
    } catch (IOException failure) {
      record.put(
          "status",
          failure instanceof GitHubCli.RequestFailure response && response.definite
              ? "failed"
              : "uncertain");
      saveOutcome(id, expected, record);
    }
    return record;
  }

  private ObjectNode reconcile(String id, String expected, JsonNode prior, JsonNode source)
      throws IOException {
    if (prior.path("status").asText().equals("complete")) return prior.deepCopy();
    ObjectNode record = prior.deepCopy();
    String marker = "<!-- leanreview:" + record.path("id").asText();
    ArrayNode comments = cli.pages(target(source) + "/comments");
    ArrayNode confirmed = record.withArray("confirmedDraftIds");
    var seen = new HashSet<String>();
    confirmed.forEach(v -> seen.add(v.asText()));
    for (JsonNode draft : record.path("drafts"))
      for (JsonNode comment : comments) {
        String expectedBody =
            draft.path("text").asText()
                + "\n\n"
                + marker
                + ":"
                + draft.path("id").asText()
                + " -->";
        if (comment.path("body").asText().equals(expectedBody)
            && comment.path("user").path("login").equals(record.path("actor"))
            && (draft.has("replyTo")
                ? comment.path("in_reply_to_id").equals(draft.path("replyTo"))
                : comment.path("path").equals(draft.path("path")))
            && seen.add(draft.path("id").asText())) confirmed.add(draft.path("id"));
      }
    for (JsonNode item : cli.pages(target(source) + "/reviews"))
      if (item.path("body")
              .asText()
              .equals(record.path("message").asText() + "\n\n" + marker + " -->")
          && item.path("user").path("login").equals(record.path("actor"))
          && item.path("commit_id").equals(record.path("headSha")))
        record.put("reviewConfirmed", true);
    boolean reviewNeeded =
        !record.path("decision").asText().equals("COMMENT")
            || !record.path("message").asText().isBlank();
    if (confirmed.size() == record.path("drafts").size()
        && (!reviewNeeded || record.path("reviewConfirmed").asBoolean()))
      record.put("status", "complete");
    // Absence after a network failure is not proof a write failed. Never automatically resend.
    saveOutcome(id, expected, record);
    return record;
  }

  private void saveOutcome(String id, String expected, ObjectNode record) throws IOException {
    reviews.updateCurrentState(
        id,
        expected,
        state -> {
          ArrayNode outbox = json.createArrayNode();
          for (JsonNode item : state.path("githubSubmissions"))
            outbox.add(item.path("id").equals(record.path("id")) ? record : item);
          state.set("githubSubmissions", outbox);
          Set<String> sent = new HashSet<>();
          record.path("confirmedDraftIds").forEach(v -> sent.add(v.asText()));
          ArrayNode drafts = json.createArrayNode();
          for (JsonNode draft : state.path("drafts"))
            if (!sent.contains(draft.path("id").asText())) drafts.add(draft);
          state.set("drafts", drafts);
        });
  }
}
