package dev.leanreview.storage;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Paired rollback checkpoint, made before migrations or interrupted-job recovery. */
final class CutoverBackup {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final String MARKER = "java-cutover.json";

  private CutoverBackup() {}

  static Path prepare(Connection connection, Path directory) throws IOException, SQLException {
    Path marker = directory.resolve(MARKER);
    if (Files.exists(marker)) {
      if (JSON.readTree(marker.toFile()).path("version").asInt() != 1)
        throw new IOException(
            "Unrecognized Java cutover marker. Preserve the existing backup before retrying.");
      return null;
    }
    try (var statement = connection.createStatement();
        var rows = statement.executeQuery("PRAGMA user_version")) {
      if (!rows.next() || rows.getInt(1) == 0) return null;
    }
    Path destination = directory.resolve("backups").resolve("pre-java-" + UUID.randomUUID());
    Files.createDirectories(destination.resolve("cache"));
    Path database = destination.resolve("leanreview.sqlite");
    try (var statement = connection.prepareStatement("VACUUM INTO ?")) {
      statement.setString(1, database.toString());
      statement.execute();
    }
    var files = new LinkedHashMap<String, String>();
    Path cache = directory.resolve("cache");
    if (Files.isDirectory(cache))
      try (var entries = Files.list(cache)) {
        for (Path file : entries.toList()) {
          String name = file.getFileName().toString();
          if (!name.matches("[a-f0-9]{64}")) continue;
          if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS))
            throw new IOException("Unexpected captured artifact type in cutover backup.");
          byte[] bytes = Files.readAllBytes(file);
          if (!digest(bytes).equals(name))
            throw new IOException("Captured artifact is corrupt. Java cutover was not started.");
          Files.write(
              destination.resolve("cache").resolve(name), bytes, StandardOpenOption.CREATE_NEW);
          files.put("cache/" + name, name);
        }
      }
    try (var backup = DriverManager.getConnection("jdbc:sqlite:" + database)) {
      try (var statement = backup.createStatement();
          var rows = statement.executeQuery("PRAGMA integrity_check")) {
        if (!rows.next() || !rows.getString(1).equals("ok"))
          throw new IOException("Cutover backup failed database integrity verification.");
      }
      try (var statement = backup.createStatement();
          var rows = statement.executeQuery("SELECT data FROM snapshots")) {
        while (rows.next())
          for (JsonNode file : JSON.readTree(rows.getString(1)).path("files")) {
            for (String side : new String[] {"before", "after"}) {
              JsonNode content = file.path(side);
              if (content.path("kind").asText().equals("text"))
                require(files, content.path("hash").asText());
            }
            require(files, file.path("patchHash").asText());
          }
      }
      if (hasTable(backup, "coverage_reports"))
        try (var statement = backup.createStatement();
            var rows = statement.executeQuery("SELECT raw_hash FROM coverage_reports")) {
          while (rows.next()) require(files, rows.getString(1));
        }
      if (hasTable(backup, "graphs"))
        try (var statement = backup.createStatement();
            var rows = statement.executeQuery("SELECT artifact,sources FROM graphs")) {
          while (rows.next()) {
            if (rows.getString(1) != null) require(files, rows.getString(1));
            for (JsonNode hash : JSON.readTree(rows.getString(2))) require(files, hash.asText());
          }
        }
    }
    files.put("leanreview.sqlite", digest(Files.readAllBytes(database)));
    JSON.writeValue(
        destination.resolve("backup.json").toFile(),
        Map.of("version", 1, "createdAt", Instant.now().toString(), "files", files));
    // A marker is written only after all references and schema initialization succeed.
    return destination;
  }

  static void complete(Path directory, Path backup) throws IOException {
    if (Files.exists(directory.resolve(MARKER))) return;
    Files.writeString(
        directory.resolve(MARKER),
        JSON.writeValueAsString(
            Map.of(
                "version",
                1,
                "createdAt",
                Instant.now().toString(),
                "backup",
                backup == null ? "fresh-database" : backup.toString())),
        StandardOpenOption.CREATE_NEW);
  }

  private static boolean hasTable(Connection connection, String name) throws SQLException {
    try (var query =
        connection.prepareStatement("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")) {
      query.setString(1, name);
      try (var rows = query.executeQuery()) {
        return rows.next();
      }
    }
  }

  private static void require(Map<String, String> files, String hash) throws IOException {
    if (hash == null || !hash.matches("[a-f0-9]{64}") || !files.containsKey("cache/" + hash))
      throw new IOException(
          "Cutover backup is missing a referenced captured artifact. Java was not started.");
  }

  private static String digest(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
