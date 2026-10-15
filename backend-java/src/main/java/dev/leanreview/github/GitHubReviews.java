package dev.leanreview.github;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import com.github.difflib.DiffUtils;
import com.github.difflib.UnifiedDiffUtils;
import dev.leanreview.storage.*;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;

/** GitHub source adapter. Capture never clones or reads mutable local working files. */
@Service
public class GitHubReviews {
  private final GitHubCli github;
  private final ObjectMapper json;
  private final CoreSnapshots snapshots;
  private final ReviewStore reviews;

  public GitHubReviews(
      GitHubCli github, ObjectMapper json, CoreSnapshots snapshots, ReviewStore reviews) {
    this.github = github;
    this.json = json;
    this.snapshots = snapshots;
    this.reviews = reviews;
  }

  public JsonNode repositories() throws IOException {
    return github.pages(
        "user/repos?sort=pushed&affiliation=owner,collaborator,organization_member");
  }

  public JsonNode repository(long id) throws IOException {
    if (id <= 0) throw new IllegalArgumentException("Invalid repository.");
    JsonNode repo = github.api("GET", "repositories/" + id, null);
    if (!repo.path("full_name").asText().matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
        || repo.path("id").asLong() != id)
      throw new IOException("GitHub repository identity could not be verified.");
    return repo;
  }

  public JsonNode pulls(long repo) throws IOException {
    ArrayNode pulls =
        github.pages(
            "repos/"
                + repository(repo).path("full_name").asText()
                + "/pulls?state=open&sort=updated");
    String login = github.status().path("login").asText();
    var teams = new HashSet<Long>();
    for (JsonNode team : github.pages("user/teams")) teams.add(team.path("id").asLong());
    for (JsonNode pull : pulls) {
      boolean requested = false;
      for (JsonNode reviewer : pull.path("requested_reviewers"))
        if (reviewer.path("login").asText().equals(login)) requested = true;
      for (JsonNode team : pull.path("requested_teams"))
        if (teams.contains(team.path("id").asLong())) requested = true;
      ((ObjectNode) pull).put("needsMyReview", requested);
    }
    return pulls;
  }

  private String target(long repo, int number) throws IOException {
    if (number <= 0) throw new IllegalArgumentException("Invalid pull request.");
    return "repos/" + repository(repo).path("full_name").asText() + "/pulls/" + number;
  }

  public JsonNode latest(JsonNode source) throws IOException {
    return github.api(
        "GET",
        target(source.path("repositoryId").asLong(), source.path("pullNumber").asInt()),
        null);
  }

  public ObjectNode open(long repo, int number) throws IOException {
    String id =
        UUID.nameUUIDFromBytes(
                ("github.com:" + repo + ":" + number).getBytes(StandardCharsets.UTF_8))
            .toString();
    for (JsonNode session : snapshots.list())
      if (session.path("id").asText().equals(id)) return reviews.review(id, null);
    return snapshots.create(capture(repo, number, id));
  }

  public ObjectNode refresh(String id, String expected) throws IOException {
    JsonNode source = snapshots.current(id, expected).path("snapshot").path("source");
    return snapshots.refresh(
        id,
        expected,
        capture(source.path("repositoryId").asLong(), source.path("pullNumber").asInt(), id));
  }

  public ObjectNode capture(long repo, int number, String sessionId) throws IOException {
    String endpoint = target(repo, number);
    JsonNode pr = github.api("GET", endpoint, null);
    String base = pr.path("base").path("sha").asText(), head = pr.path("head").path("sha").asText();
    if (!base.matches("[a-f0-9]{40,64}") || !head.matches("[a-f0-9]{40,64}"))
      throw new IOException("Pull request revisions are unavailable.");
    String fullName = repository(repo).path("full_name").asText();
    JsonNode comparison =
        github.api("GET", "repos/" + fullName + "/compare/" + base + "..." + head, null);
    String mergeBase = comparison.path("merge_base_commit").path("sha").asText();
    if (!mergeBase.matches("[a-f0-9]{40,64}"))
      throw new IOException("Pull request merge base is unavailable.");
    ArrayNode listing = github.pages(endpoint + "/files");
    ObjectNode snapshot =
        json.createObjectNode()
            .put("id", UUID.randomUUID().toString())
            .put("sessionId", sessionId)
            .put("capturedAt", Instant.now().toString())
            .put("root", "github.com/" + fullName)
            .put("head", head)
            .put("base", mergeBase)
            .put("complete", listing.size() == pr.path("changed_files").asInt(-1));
    snapshot.putObject("comparison").put("mode", "branch").put("base", mergeBase);
    ObjectNode source =
        snapshot
            .putObject("source")
            .put("provider", "github")
            .put("host", "github.com")
            .put("repositoryId", repo)
            .put("fullName", fullName)
            .put("pullNumber", number)
            .put("headSha", head)
            .put("baseSha", base)
            .put("title", pr.path("title").asText())
            .put("body", pr.path("body").asText(""))
            .put("url", "https://github.com/" + fullName + "/pull/" + number);
    ArrayNode files = snapshot.putArray("files");
    var paths = new HashSet<String>();
    var trees = new HashMap<String, JsonNode>();
    for (JsonNode entry : listing) {
      String name = entry.path("filename").asText(),
          old = entry.path("previous_filename").asText(name);
      if (name.isBlank() || !paths.add(name))
        throw new IOException("Pull request file listing is invalid or duplicated.");
      String status =
          switch (entry.path("status").asText()) {
            case "added" -> "added";
            case "removed" -> "deleted";
            case "renamed" -> "renamed";
            default -> "modified";
          };
      ObjectNode before =
          status.equals("added")
              ? json.createObjectNode().put("kind", "absent")
              : content(fullName, old, mergeBase, trees);
      ObjectNode after =
          status.equals("deleted")
              ? json.createObjectNode().put("kind", "absent")
              : content(
                  pr.path("head").path("repo").path("full_name").asText(fullName),
                  name,
                  head,
                  trees);
      String patch = "";
      if ((before.path("kind").asText().equals("text")
              || before.path("kind").asText().equals("absent"))
          && (after.path("kind").asText().equals("text")
              || after.path("kind").asText().equals("absent"))) {
        var left = diffLines(before.path("text").asText(""));
        var right = diffLines(after.path("text").asText(""));
        patch =
            String.join(
                "\n",
                UnifiedDiffUtils.generateUnifiedDiff(
                    "a/" + old, "b/" + name, left, DiffUtils.diff(left, right), 3));
      }
      ObjectNode file =
          files
              .addObject()
              .put(
                  "id",
                  CapturedArtifacts.digest("github.com:" + repo + ":" + number + ":" + name)
                      .substring(0, 24))
              .put("path", name)
              .put("oldPath", old)
              .put("status", status)
              .put("patch", patch);
      file.set("before", before);
      file.set("after", after);
      file.put(
          "fingerprint",
          CapturedArtifacts.digest(
              json.writeValueAsString(json.createArrayNode().add(before).add(after).add(patch))));
    }
    JsonNode verified = github.api("GET", endpoint, null);
    if (!head.equals(verified.path("head").path("sha").asText())
        || !base.equals(verified.path("base").path("sha").asText()))
      throw new IOException(
          "The pull request changed during capture. Retry to capture a fixed revision.");
    return snapshot;
  }

  private List<String> diffLines(String text) {
    if (text.isEmpty()) return List.of();
    var lines = new ArrayList<>(Arrays.asList(text.split("\n", -1)));
    if (text.endsWith("\n")) lines.removeLast();
    return lines;
  }

  private JsonNode tree(String repo, String sha, Map<String, JsonNode> cache) throws IOException {
    String key = repo + ":" + sha;
    if (!cache.containsKey(key))
      cache.put(key, github.api("GET", "repos/" + repo + "/git/trees/" + sha, null));
    JsonNode tree = cache.get(key);
    if (!tree.path("tree").isArray() || tree.path("truncated").asBoolean())
      throw new IOException("GitHub tree is incomplete.");
    return tree;
  }

  private ObjectNode content(String repo, String name, String sha, Map<String, JsonNode> cache) {
    ObjectNode result = json.createObjectNode();
    try {
      if (!repo.matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")) throw new IOException();
      String commitKey = repo + ":commit:" + sha;
      if (!cache.containsKey(commitKey))
        cache.put(commitKey, github.api("GET", "repos/" + repo + "/git/commits/" + sha, null));
      String treeSha = cache.get(commitKey).path("tree").path("sha").asText();
      JsonNode entry = null;
      String[] segments = name.split("/");
      for (int index = 0; index < segments.length; index++) {
        if (!treeSha.matches("[a-f0-9]{40,64}")) throw new IOException();
        entry = null;
        for (JsonNode child : tree(repo, treeSha, cache).path("tree"))
          if (child.path("path").asText().equals(segments[index])) {
            entry = child;
            break;
          }
        if (entry == null) throw new IOException();
        if (index < segments.length - 1 && !entry.path("type").asText().equals("tree"))
          throw new IOException();
        treeSha = entry.path("sha").asText();
      }
      if (entry == null
          || !Set.of("100644", "100755").contains(entry.path("mode").asText())
          || !entry.path("type").asText().equals("blob"))
        return result
            .put("kind", "unavailable")
            .put("reason", "Symbolic links and submodules require metadata review.");
      if (entry.path("size").asLong() > 512 * 1024)
        return result.put("kind", "oversized").put("reason", "Content exceeds the display limit.");
      JsonNode value = github.api("GET", "repos/" + repo + "/git/blobs/" + treeSha, null);
      if (value.path("size").asLong() > 512 * 1024
          || !value.path("encoding").asText().equals("base64"))
        return result.put("kind", "oversized").put("reason", "Content exceeds the display limit.");
      byte[] bytes = Base64.getMimeDecoder().decode(value.path("content").asText());
      if (bytes.length > 512 * 1024)
        return result.put("kind", "oversized").put("reason", "Content exceeds the display limit.");
      var digest =
          java.security.MessageDigest.getInstance(treeSha.length() == 40 ? "SHA-1" : "SHA-256");
      digest.update(("blob " + bytes.length + "\0").getBytes(StandardCharsets.US_ASCII));
      if (!HexFormat.of().formatHex(digest.digest(bytes)).equals(treeSha))
        throw new IOException("GitHub blob identity mismatch.");
      for (byte b : bytes) if (b == 0) return result.put("kind", "binary");
      String text =
          StandardCharsets.UTF_8
              .newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .decode(ByteBuffer.wrap(bytes))
              .toString();
      return result.put("kind", "text").put("text", text);
    } catch (CharacterCodingException binary) {
      return result.put("kind", "binary");
    } catch (Exception unavailable) {
      return result
          .put("kind", "unavailable")
          .put("reason", "Captured GitHub content could not be fetched at this revision.");
    }
  }
}
