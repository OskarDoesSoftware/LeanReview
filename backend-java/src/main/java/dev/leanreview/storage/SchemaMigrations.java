package dev.leanreview.storage;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.UUID;
import org.springframework.core.io.ClassPathResource;

public final class SchemaMigrations {
  public static final int CURRENT_VERSION = 3;

  @FunctionalInterface
  interface ScriptSource {
    String read(int version) throws IOException;
  }

  private SchemaMigrations() {}

  public static void migrate(Connection connection, Path directory)
      throws SQLException, IOException {
    migrate(
        connection,
        directory,
        version ->
            new ClassPathResource("db/migrations/%03d.sql".formatted(version))
                .getContentAsString(StandardCharsets.UTF_8));
  }

  // The script source lets the failure test inject an invalid migration without altering shipped
  // SQL.
  static void migrate(Connection connection, Path directory, ScriptSource scripts)
      throws SQLException, IOException {
    int original;
    try (var statement = connection.createStatement();
        var rows = statement.executeQuery("PRAGMA user_version")) {
      if (!rows.next()) throw new SQLException("SQLite schema version is unavailable.");
      original = rows.getInt(1);
    }
    if (original > CURRENT_VERSION)
      throw new SQLException("Database is newer than this application; use the newer version.");
    if (original == CURRENT_VERSION) return;
    if (original > 0) {
      Path backup =
          directory.resolve(
              "leanreview.pre-v%d.%s.sqlite".formatted(original + 1, UUID.randomUUID()));
      try (var statement = connection.prepareStatement("VACUUM INTO ?")) {
        statement.setString(1, backup.toString());
        statement.execute();
      }
    }
    connection.setAutoCommit(false);
    try {
      for (int version = original + 1; version <= CURRENT_VERSION; version++) {
        String sql = scripts.read(version);
        try (var statement = connection.createStatement()) {
          for (String command : sql.split(";")) if (!command.isBlank()) statement.execute(command);
          statement.execute("PRAGMA user_version=" + version);
        }
      }
      connection.commit();
    } catch (SQLException | IOException | RuntimeException error) {
      connection.rollback();
      throw new SQLException(
          "Database migration failed and was rolled back. Keep the database and its pre-migration"
              + " backup for recovery.",
          error);
    } finally {
      connection.setAutoCommit(true);
    }
  }
}
