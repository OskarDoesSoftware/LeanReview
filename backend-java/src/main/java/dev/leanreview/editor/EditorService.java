package dev.leanreview.editor;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.leanreview.api.WireInput;
import dev.leanreview.git.LocalSnapshots;
import dev.leanreview.storage.CoreSnapshots;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

@Service
public class EditorService {
  private final CoreSnapshots snapshots;
  private final ObjectMapper json;
  private static final Pattern PLACEHOLDER = Pattern.compile("\\{(file|line|column)\\}");

  public EditorService(CoreSnapshots snapshots, ObjectMapper json) {
    this.snapshots = snapshots;
    this.json = json;
  }

  public ObjectNode view() throws IOException {
    ObjectNode result = json.createObjectNode();
    result.set("config", snapshots.setting("editor"));
    ArrayNode presets = result.putArray("presets");
    String os = System.getProperty("os.name").toLowerCase(Locale.ROOT);
    boolean windows = os.contains("win"), mac = os.contains("mac");
    String code = "code";
    if (windows) {
      Path installed =
          Path.of(
              System.getenv().getOrDefault("LOCALAPPDATA", ""),
              "Programs",
              "Microsoft VS Code",
              "Code.exe");
      code = Files.isRegularFile(installed) ? installed.toString() : "Code.exe";
    }
    preset(presets, "VS Code", code, "--goto", "{file}:{line}:{column}");
    preset(presets, "IntelliJ IDEA", windows ? "idea64.exe" : "idea", "--line", "{line}", "{file}");
    if (windows) preset(presets, "Neovim", "wt.exe", "new-tab", "nvim", "+{line}", "{file}");
    else if (mac) preset(presets, "Neovim", "nvim", "+{line}", "{file}");
    else preset(presets, "Neovim", "x-terminal-emulator", "-e", "nvim", "+{line}", "{file}");
    return result;
  }

  private void preset(ArrayNode presets, String name, String executable, String... arguments) {
    ObjectNode value = presets.addObject().put("name", name).put("executable", executable);
    ArrayNode args = value.putArray("args");
    for (String argument : arguments) args.add(argument);
  }

  public JsonNode configure(JsonNode input) throws IOException {
    WireInput.object(input);
    ObjectNode config =
        json.createObjectNode()
            .put("name", WireInput.text(input, "name", 1, 80, true))
            .put("executable", WireInput.text(input, "executable", 1, 1000, true));
    ArrayNode args = WireInput.strings(input, "args");
    if (args.size() > 32) throw new IllegalArgumentException("Invalid args length.");
    for (JsonNode arg : args)
      if (arg.asText().length() > 2000) throw new IllegalArgumentException("Invalid args length.");
    config.set("args", args.deepCopy());
    return snapshots.setting("editor", config);
  }

  public ObjectNode open(String sessionId, JsonNode input) throws IOException {
    String snapshotId = WireInput.text(input, "snapshotId");
    JsonNode snapshot = snapshots.current(sessionId, snapshotId).path("snapshot");
    JsonNode config = snapshots.setting("editor");
    if (config.isNull()) throw new IllegalArgumentException("Configure a default editor first.");
    String id = WireInput.text(input, "fileId");
    String side = WireInput.choice(input, "side", "before", "after");
    int requestedLine = WireInput.positive(input, "line", 0);
    int column = WireInput.positive(input, "column", 1);
    JsonNode file = null;
    for (JsonNode candidate : snapshot.path("files"))
      if (candidate.path("id").asText().equals(id)) file = candidate;
    if (file == null || !file.path("after").path("kind").asText().equals("text"))
      throw new IllegalArgumentException("This snapshot has no editable working-file text.");
    Path root = Path.of(snapshot.path("root").asText());
    Path target = LocalSnapshots.contained(root, file.path("path").asText());
    byte[] bytes;
    try (var stream = Files.newInputStream(target)) {
      bytes = stream.readNBytes(2 * 1024 * 1024 + 1);
    }
    if (bytes.length > 2 * 1024 * 1024)
      throw new IllegalArgumentException(
          "Working file differs from this snapshot. Refresh the review before opening a line in the"
              + " editor.");
    String text =
        StandardCharsets.UTF_8
            .newDecoder()
            .decode(java.nio.ByteBuffer.wrap(bytes))
            .toString()
            .replaceFirst("^\\ufeff", "");
    if (!text.equals(file.path("after").path("text").asText()))
      throw new IllegalArgumentException(
          "Working file differs from this snapshot. Refresh the review before opening a line in the"
              + " editor.");
    int line = side.equals("before") ? 1 : requestedLine;
    if (line > text.split("\n", -1).length)
      throw new IllegalArgumentException("Line is outside the captured working file.");
    String executable = config.path("executable").asText();
    if (executable.toLowerCase(Locale.ROOT).matches(".*\\.(cmd|bat)$"))
      throw new IllegalArgumentException(
          "Use the editor executable (.exe) or a terminal launcher, not a shell script.");
    List<String> command = new ArrayList<>(List.of(executable));
    for (JsonNode argument : config.path("args")) {
      Matcher matcher = PLACEHOLDER.matcher(argument.asText());
      command.add(
          matcher.replaceAll(
              match ->
                  Matcher.quoteReplacement(
                      switch (match.group(1)) {
                        case "file" -> target.toString();
                        case "line" -> Integer.toString(line);
                        default -> Integer.toString(column);
                      })));
    }
    try {
      Process process =
          new ProcessBuilder(command)
              .directory(root.toFile())
              .redirectOutput(ProcessBuilder.Redirect.DISCARD)
              .redirectError(ProcessBuilder.Redirect.DISCARD)
              .start();
      process.getOutputStream().close();
    } catch (IOException failure) {
      throw new IllegalArgumentException(
          "Editor could not start. Configure its executable path and arguments in Editor"
              + " settings.");
    }
    return json.createObjectNode()
        .put("ok", true)
        .put("line", line)
        .put("historicalLine", side.equals("before"));
  }
}
