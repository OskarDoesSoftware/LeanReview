package dev.leanreview.git;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.leanreview.LeanReviewApplication;
import dev.leanreview.storage.CoreSnapshots;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;

/** Replays Node-generated Git operations and compares the entire saved review JSON. */
class GitCaptureContractTest {
  @TempDir Path temporary;
  private final ObjectMapper json = new ObjectMapper();

  @Test
  void matchesNodeForIndexWorkingBranchUnbornMetadataRenamesAndNewlines() throws Exception {
    JsonNode fixture = json.readTree(Path.of("../tests/fixtures/core-git.json").toFile());
    Path emptyConfig = temporary.resolve("empty-gitconfig");
    Files.writeString(emptyConfig, "");
    try (var context =
        new SpringApplicationBuilder(LeanReviewApplication.class)
            .run(
                "--leanreview.data-directory=" + temporary.resolve("data"),
                "--spring.main.web-application-type=none",
                "--logging.level.root=OFF",
                "--spring.main.banner-mode=off")) {
      var captures = context.getBean(LocalSnapshots.class);
      var storage = context.getBean(CoreSnapshots.class);
      for (JsonNode scenario : fixture.path("scenarios")) {
        Path root = temporary.resolve(scenario.path("name").asText());
        Files.createDirectories(root);
        for (JsonNode operation : scenario.path("operations")) {
          switch (operation.path("op").asText()) {
            case "git" -> {
              List<String> command =
                  new ArrayList<>(
                      List.of(
                          "git",
                          "-c",
                          "core.hooksPath=",
                          "-c",
                          "commit.gpgsign=false",
                          "-c",
                          "core.autocrlf=false"));
              operation.path("args").forEach(argument -> command.add(argument.asText()));
              ProcessBuilder builder =
                  new ProcessBuilder(command).directory(root.toFile()).redirectErrorStream(true);
              builder.environment().keySet().removeIf(key -> key.startsWith("GIT_"));
              builder.environment().put("GIT_CONFIG_GLOBAL", emptyConfig.toString());
              builder.environment().put("GIT_CONFIG_NOSYSTEM", "1");
              fixture
                  .path("gitEnvironment")
                  .fields()
                  .forEachRemaining(
                      entry ->
                          builder.environment().put(entry.getKey(), entry.getValue().asText()));
              Process process = builder.start();
              process.getOutputStream().close();
              assertThat(process.waitFor(30, TimeUnit.SECONDS)).isTrue();
              assertThat(process.exitValue())
                  .withFailMessage(
                      new String(
                          process.getInputStream().readAllBytes(),
                          java.nio.charset.StandardCharsets.UTF_8))
                  .isZero();
            }
            case "write" -> {
              Path file = root.resolve(operation.path("path").asText());
              Files.createDirectories(file.getParent());
              byte[] bytes =
                  operation.has("repeat")
                      ? "x"
                          .repeat(operation.path("repeat").asInt())
                          .getBytes(java.nio.charset.StandardCharsets.UTF_8)
                      : operation.has("base64")
                          ? Base64.getDecoder().decode(operation.path("base64").asText())
                          : operation
                              .path("text")
                              .asText()
                              .getBytes(java.nio.charset.StandardCharsets.UTF_8);
              Files.write(file, bytes);
              if (operation.has("mtimeMillis"))
                Files.setLastModifiedTime(
                    file, FileTime.fromMillis(operation.path("mtimeMillis").asLong()));
            }
            case "capture" -> {
              ObjectNode comparison =
                  json.createObjectNode()
                      .put("mode", operation.path("mode").asText())
                      .put("base", "main");
              ObjectNode snapshot =
                  captures.capture(
                      captures.select(root.toString()), comparison, UUID.randomUUID().toString());
              JsonNode actual = normalize(storage.create(snapshot), "");
              assertThat(actual)
                  .as(scenario.path("name").asText() + ": " + operation.path("name").asText())
                  .isEqualTo(operation.path("expected"));
            }
            default -> throw new IllegalArgumentException("Unknown fixture operation");
          }
        }
      }
    }
  }

  private JsonNode normalize(JsonNode node, String key) {
    if (node.isObject()) {
      ObjectNode result = json.createObjectNode();
      node.fields()
          .forEachRemaining(
              entry -> result.set(entry.getKey(), normalize(entry.getValue(), entry.getKey())));
      return result;
    }
    if (node.isArray()) {
      var result = json.createArrayNode();
      node.forEach(item -> result.add(normalize(item, "")));
      return result;
    }
    if (node.isTextual()) {
      if (key.equals("root")) return json.getNodeFactory().textNode("<repository>");
      if (key.endsWith("At")) return json.getNodeFactory().textNode("<timestamp>");
      if (key.equals("sessionId")) return json.getNodeFactory().textNode("<session>");
      if (key.equals("id") && node.asText().matches("[a-f0-9-]{36}"))
        return json.getNodeFactory().textNode("<snapshot>");
    }
    return node;
  }
}
