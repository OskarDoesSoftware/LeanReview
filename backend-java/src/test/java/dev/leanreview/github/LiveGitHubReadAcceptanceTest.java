package dev.leanreview.github;

import static org.assertj.core.api.Assertions.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/** A read-only CLI wrapper must be explicitly supplied. This test never performs remote writes. */
@EnabledIfEnvironmentVariable(named = "LEANREVIEW_LIVE_GITHUB_READ_COMMAND", matches = ".+")
class LiveGitHubReadAcceptanceTest {
  @TempDir Path directory;
  @Test void existingKeyringAccountCanReadTheProjectThroughTheJavaAdapter() throws Exception {
    var json = new ObjectMapper();
    var cli = new GitHubCli(json, directory.toString(), System.getenv("LEANREVIEW_LIVE_GITHUB_READ_COMMAND"));
    try {
      assertThat(cli.status().path("connected").asBoolean()).isTrue();
      var repository = cli.api("GET", "repos/OskarDoesSoftware/LeanReview", null);
      assertThat(repository.path("id").asLong()).isPositive();
      assertThat(repository.path("full_name").asText()).isEqualToIgnoringCase("OskarDoesSoftware/LeanReview");
      assertThat(cli.pages("repos/OskarDoesSoftware/LeanReview/pulls?state=open").isArray()).isTrue();
    } finally { cli.close(); }
  }
}
