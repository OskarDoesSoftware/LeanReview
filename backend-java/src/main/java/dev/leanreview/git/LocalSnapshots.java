package dev.leanreview.git;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import dev.leanreview.storage.CapturedArtifacts;
import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.*;
import java.time.*;
import java.time.format.DateTimeFormatterBuilder;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class LocalSnapshots {
  private final ObjectMapper json;

  public LocalSnapshots(ObjectMapper json) {
    this.json = json;
  }

  private record Content(ObjectNode value, String digest) {}

  private record Entry(String code, String oldPath, String path) {}

  public static String now() {
    return new DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.now());
  }

  public static String hash(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  private String git(Path root, String... args) throws IOException {
    return new String(GitProcess.run(root, args), StandardCharsets.UTF_8);
  }

  public Path select(String input) throws IOException {
    Path root;
    try {
      root = Path.of(input).toRealPath();
    } catch (IOException | InvalidPathException e) {
      throw new IOException("Repository root is unavailable.");
    }
    Path top = Path.of(git(root, "rev-parse", "--show-toplevel").trim()).toRealPath();
    if (!root.equals(top)) throw new IOException("Select the repository root, not a subdirectory.");
    return root;
  }

  public static Path contained(Path root, String relative) throws IOException {
    Path path = Path.of(relative);
    if (relative.isEmpty()
        || path.isAbsolute()
        || Arrays.stream(relative.split("[\\\\/]")).anyMatch(p -> p.equalsIgnoreCase(".git")))
      throw new IOException("Invalid repository path.");
    Path target = root.resolve(path).toRealPath();
    if (!target.startsWith(root.toRealPath()))
      throw new IOException("File resolves outside the selected repository.");
    return target;
  }

  private Content absent() {
    return new Content(json.createObjectNode().put("kind", "absent"), "absent");
  }

  private Content content(byte[] bytes) {
    ObjectNode value = json.createObjectNode();
    if (bytes.length > 2 * 1024 * 1024)
      value.put("kind", "oversized").put("reason", "Text display limit is 2 MiB.");
    else {
      boolean binary = false;
      for (byte b : bytes)
        if (b == 0) {
          binary = true;
          break;
        }
      if (binary) value.put("kind", "binary");
      else
        try {
          value
              .put("kind", "text")
              .put(
                  "text",
                  StandardCharsets.UTF_8
                      .newDecoder()
                      .onMalformedInput(CodingErrorAction.REPORT)
                      .decode(ByteBuffer.wrap(bytes))
                      .toString()
                      .replaceFirst("^\\ufeff", ""));
        } catch (CharacterCodingException e) {
          value.put("kind", "binary").put("reason", "Not UTF-8 text.");
        }
    }
    return new Content(value, hash(bytes));
  }

  private Content blob(Path root, String spec) throws IOException {
    if (spec == null) return absent();
    try {
      return content(GitProcess.run(root, "cat-file", "blob", spec));
    } catch (IOException e) {
      throw new IOException("Cannot read a captured Git blob. The repository may have changed.");
    }
  }

  private static String metadataMillis(BasicFileAttributes attributes) {
    double millis =
        attributes.lastModifiedTime().to(java.util.concurrent.TimeUnit.NANOSECONDS) / 1_000_000d;
    return millis == Math.rint(millis) ? Long.toString((long) millis) : Double.toString(millis);
  }

  private Content working(Path root, String name) throws IOException {
    Path file = root.resolve(name);
    BasicFileAttributes attributes;
    try {
      attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    } catch (NoSuchFileException e) {
      return absent();
    }
    if (attributes.isSymbolicLink() || !attributes.isRegularFile())
      return new Content(
          json.createObjectNode()
              .put("kind", "unavailable")
              .put("reason", "Symlink or non-regular file; not followed."),
          CapturedArtifacts.digest(Long.toString(attributes.size()) + metadataMillis(attributes)));
    Path safe = contained(root, name);
    if (attributes.size() > 2 * 1024 * 1024)
      return new Content(
          json.createObjectNode()
              .put("kind", "oversized")
              .put("reason", "Text display limit is 2 MiB."),
          CapturedArtifacts.digest(Long.toString(attributes.size()) + metadataMillis(attributes)));
    return content(Files.readAllBytes(safe));
  }

  public ObjectNode capture(Path root, JsonNode comparison, String sessionId) throws IOException {
    ObjectNode first = captureFiles(root, comparison), second = captureFiles(root, comparison);
    if (!first.equals(second))
      throw new IOException("Repository changed during capture. Retry when changes settle.");
    first.put("root", root.toString()).set("comparison", comparison.deepCopy());
    return first
        .put("sessionId", sessionId)
        .put("id", UUID.randomUUID().toString())
        .put("capturedAt", now())
        .put("complete", true);
  }

  private ObjectNode captureFiles(Path root, JsonNode comparison) throws IOException {
    String mode = comparison.path("mode").asText(), head = null, base, target = null;
    if (!mode.equals("branch") && !git(root, "ls-files", "--unmerged", "-z").isEmpty())
      throw new IOException(
          "Unsupported Git change U; resolve conflicts or submodule changes first.");
    try {
      head = git(root, "rev-parse", "--verify", "HEAD").trim();
    } catch (IOException ignored) {
    }
    base = head;
    var args = new ArrayList<String>();
    if (mode.equals("branch")) {
      if (head == null) throw new IOException("Branch comparison requires a commit.");
      String commit =
          git(
                  root,
                  "rev-parse",
                  "--verify",
                  "--end-of-options",
                  comparison.path("base").asText() + "^{commit}")
              .trim();
      base = git(root, "merge-base", commit, head).trim();
      target = head;
      args.add(base);
      args.add(head);
    } else if (mode.equals("staged")) {
      args.add("--cached");
      if (head != null) args.add(head);
    } else if (mode.equals("all") && head != null) args.add(head);
    var command =
        new ArrayList<>(
            List.of(
                "diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames"));
    command.addAll(args);
    command.add("--");
    String[] tokens = git(root, command.toArray(String[]::new)).split("\0");
    var entries = new ArrayList<Entry>();
    var known = new HashSet<String>();
    for (int i = 0; i < tokens.length && !tokens[i].isEmpty(); ) {
      String code = tokens[i++],
          old = tokens[i++],
          name = code.startsWith("R") || code.startsWith("C") ? tokens[i++] : old;
      entries.add(new Entry(code, old, name));
      known.add(name);
    }
    if (mode.equals("all") && head == null) {
      entries.replaceAll(entry -> new Entry("A", entry.oldPath, entry.path));
      for (String name : git(root, "ls-files", "-z").split("\0"))
        if (!name.isEmpty() && known.add(name)) entries.add(new Entry("A", name, name));
    }
    if (mode.equals("unstaged") || mode.equals("all"))
      for (String name : git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0"))
        if (!name.isEmpty() && known.add(name)) entries.add(new Entry("A", name, name));
    ArrayNode files = json.createArrayNode();
    for (Entry entry : entries) {
      if (!entry.code.matches("[AMDR].*"))
        throw new IOException(
            "Unsupported Git change "
                + entry.code
                + "; resolve conflicts or submodule changes first.");
      String status =
          switch (entry.code.charAt(0)) {
            case 'A' -> "added";
            case 'D' -> "deleted";
            case 'R' -> "renamed";
            default -> "modified";
          };
      String oldSpec =
          status.equals("added")
              ? null
              : mode.equals("unstaged")
                  ? ":" + entry.oldPath
                  : base == null ? null : base + ":" + entry.oldPath;
      Content before = blob(root, oldSpec),
          after =
              status.equals("deleted")
                  ? absent()
                  : mode.equals("staged")
                      ? blob(root, ":" + entry.path)
                      : target != null
                          ? blob(root, target + ":" + entry.path)
                          : working(root, entry.path);
      String fingerprint =
          CapturedArtifacts.digest(
              json.writeValueAsString(
                  List.of(status, entry.oldPath, entry.path, before.digest, after.digest)));
      ObjectNode file =
          json.createObjectNode()
              .put(
                  "id",
                  CapturedArtifacts.digest(entry.oldPath + "\0" + entry.path).substring(0, 24))
              .put("oldPath", entry.oldPath)
              .put("path", entry.path)
              .put("status", status)
              .put("fingerprint", fingerprint);
      file.set("before", before.value);
      file.set("after", after.value);
      file.put(
          "patch",
          Set.of("text", "absent").contains(before.value.path("kind").asText())
                  && Set.of("text", "absent").contains(after.value.path("kind").asText())
              ? TextPatch.create(
                  entry.oldPath,
                  entry.path,
                  before.value.path("text").asText(""),
                  after.value.path("text").asText(""))
              : "");
      files.add(file);
    }
    ObjectNode result = json.createObjectNode();
    result.set("files", files);
    result.put("head", head).put("base", base);
    ObjectNode context = result.putObject("graphContext");
    context.set("before", inventory(root, base, mode.equals("unstaged")));
    context.set(
        "after",
        inventory(
            root,
            target != null ? target : head,
            mode.equals("staged") || mode.equals("unstaged")));
    return result;
  }

  private ObjectNode inventory(Path root, String revision, boolean index) throws IOException {
    String raw =
        index
            ? git(root, "ls-files", "--stage", "-z")
            : revision == null ? "" : git(root, "ls-tree", "-r", "-z", revision);
    ObjectNode result =
        json.createObjectNode()
            .put("revision", index ? "captured-index" : revision == null ? "empty" : revision);
    ArrayNode entries = result.putArray("entries");
    int count = 0;
    for (String record : raw.split("\0")) {
      if (record.isEmpty()) continue;
      int tab = record.indexOf('\t');
      String[] meta = record.substring(0, tab).split(" ");
      if (index && !meta[2].equals("0"))
        throw new IOException("Resolve index conflicts before graph capture.");
      if (count++ < 100000)
        entries
            .addObject()
            .put("path", record.substring(tab + 1))
            .put("mode", meta[0])
            .put("oid", meta[index ? 1 : 2]);
    }
    return result.put("complete", count <= 100000);
  }
}
