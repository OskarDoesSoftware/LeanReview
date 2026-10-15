package dev.leanreview.api;

import com.fasterxml.jackson.databind.*;
import dev.leanreview.git.LocalSnapshots;
import dev.leanreview.github.*;
import dev.leanreview.storage.*;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.UUID;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class GitHubApi {
  private final GitHubCli cli;
  private final GitHubReviews github;
  private final ObjectMapper json;
  private final CoreSnapshots snapshots;
  private final LocalSnapshots local;
  private final GitHubFeedback feedback;

  public GitHubApi(
      GitHubCli cli,
      GitHubReviews github,
      ObjectMapper json,
      CoreSnapshots snapshots,
      LocalSnapshots local,
      GitHubFeedback feedback) {
    this.cli = cli;
    this.github = github;
    this.json = json;
    this.snapshots = snapshots;
    this.local = local;
    this.feedback = feedback;
  }

  private ResponseEntity<String> reply(Object value) throws IOException {
    return ResponseEntity.ok()
        .contentType(MediaType.APPLICATION_JSON)
        .body(json.writeValueAsString(value));
  }

  @GetMapping("/capabilities")
  public ResponseEntity<String> capabilities() throws IOException {
    return reply(json.createObjectNode().put("github", true).put("backend", "java"));
  }

  @GetMapping("/github/status")
  public ResponseEntity<String> status() throws IOException {
    return reply(cli.status());
  }

  @PostMapping("/github/login")
  public ResponseEntity<String> login() throws IOException {
    return reply(cli.login());
  }

  @PostMapping("/github/cancel-login")
  public ResponseEntity<String> cancel() throws IOException {
    cli.cancel();
    return reply(cli.status());
  }

  @PostMapping("/github/disconnect")
  public ResponseEntity<String> disconnect() throws IOException {
    cli.disconnect();
    return reply(cli.status());
  }

  @GetMapping("/github/repositories")
  public ResponseEntity<String> repositories() throws IOException {
    return reply(github.repositories());
  }

  @GetMapping("/github/repositories/{repo}/pulls")
  public ResponseEntity<String> pulls(@PathVariable long repo) throws IOException {
    return reply(github.pulls(repo));
  }

  @PostMapping("/github/repositories/{repo}/pulls/{number}/open")
  public ResponseEntity<String> open(@PathVariable long repo, @PathVariable int number)
      throws IOException {
    return reply(github.open(repo, number));
  }

  @GetMapping("/github/repositories/{repo}/context")
  public ResponseEntity<String> context(@PathVariable long repo) throws IOException {
    return reply(snapshots.setting("github.context:" + repo));
  }

  @PostMapping("/github/repositories/{repo}/context")
  public ResponseEntity<String> context(@PathVariable long repo, HttpServletRequest request)
      throws IOException {
    JsonNode body = WireInput.body(request);
    WireInput.object(body);
    var context = json.createObjectNode();
    context.put("tab", WireInput.choice(body, "tab", "pulls", "local"));
    if (body.hasNonNull("localPath"))
      context.put("localPath", local.select(WireInput.text(body, "localPath")).toString());
    else {
      JsonNode prior = snapshots.setting("github.context:" + repo);
      if (prior != null && prior.has("localPath"))
        context.set("localPath", prior.path("localPath"));
    }
    return reply(snapshots.setting("github.context:" + repo, context));
  }

  @PostMapping("/repositories/local-count")
  public ResponseEntity<String> count(HttpServletRequest request) throws IOException {
    JsonNode body = WireInput.body(request);
    WireInput.object(body);
    var captured =
        local.capture(
            local.select(WireInput.text(body, "root")),
            WireInput.comparison(body.path("comparison")),
            UUID.randomUUID().toString());
    return reply(
        json.createObjectNode()
            .put("count", captured.path("files").size())
            .put("complete", captured.path("complete").asBoolean()));
  }

  @PostMapping("/repositories/browse")
  public ResponseEntity<String> browse() throws Exception {
    if (java.awt.GraphicsEnvironment.isHeadless())
      throw new IOException(
          "Folder browsing is unavailable on this host. Enter a local repository path.");
    var result = json.createObjectNode();
    javax.swing.SwingUtilities.invokeAndWait(
        () -> {
          var chooser = new javax.swing.JFileChooser();
          chooser.setDialogTitle("Choose a Git repository");
          chooser.setFileSelectionMode(javax.swing.JFileChooser.DIRECTORIES_ONLY);
          if (chooser.showOpenDialog(null) == javax.swing.JFileChooser.APPROVE_OPTION)
            result.put("root", chooser.getSelectedFile().getAbsolutePath());
        });
    return reply(result);
  }

  @GetMapping("/sessions/{id}/github/status")
  public ResponseEntity<String> pullStatus(@PathVariable String id) throws IOException {
    return reply(feedback.status(id));
  }

  @GetMapping("/sessions/{id}/github/discussions")
  public ResponseEntity<String> discussions(@PathVariable String id) throws IOException {
    return reply(feedback.discussions(id));
  }

  @PostMapping("/sessions/{id}/github/reply-draft")
  public ResponseEntity<String> replyDraft(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    return reply(feedback.replyDraft(id, WireInput.body(request)));
  }

  @PostMapping("/sessions/{id}/github/resolve")
  public ResponseEntity<String> resolve(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    return reply(feedback.resolve(id, WireInput.body(request)));
  }

  @PostMapping("/sessions/{id}/github/check-draft")
  public ResponseEntity<String> checkDraft(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    return reply(feedback.checkDraft(id, WireInput.body(request)));
  }

  @PostMapping("/sessions/{id}/github/preview")
  public ResponseEntity<String> preview(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    return reply(feedback.preview(id, WireInput.body(request)));
  }

  @PostMapping("/sessions/{id}/github/publish")
  public ResponseEntity<String> publish(@PathVariable String id, HttpServletRequest request)
      throws IOException {
    return reply(feedback.publish(id, WireInput.body(request)));
  }
}
