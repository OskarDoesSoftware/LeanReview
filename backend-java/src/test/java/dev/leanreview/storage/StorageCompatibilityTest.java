package dev.leanreview.storage;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zaxxer.hikari.HikariDataSource;
import dev.leanreview.LeanReviewApplication;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.hibernate.Version;
import org.hibernate.community.dialect.SQLiteDialect;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.transaction.support.TransactionTemplate;

class StorageCompatibilityTest {
  @TempDir Path temporary;
  private final ObjectMapper json = new ObjectMapper();
  private final Path fixtures =
      Path.of("../tests/fixtures/backend-compatibility").toAbsolutePath().normalize();

  private Path copy(int version) throws IOException {
    Path destination = temporary.resolve("data-v" + version);
    try (var files = Files.walk(fixtures.resolve("databases/v" + version))) {
      for (Path file : files.toList()) {
        Path target =
            destination.resolve(fixtures.resolve("databases/v" + version).relativize(file));
        if (Files.isDirectory(file)) Files.createDirectories(target);
        else Files.copy(file, target);
      }
    }
    return destination;
  }

  private ConfigurableApplicationContext start(Path directory) {
    return new SpringApplicationBuilder(LeanReviewApplication.class)
        .run(
            "--leanreview.data-directory=" + directory,
            "--logging.level.root=ERROR",
            "--spring.main.banner-mode=off");
  }

  private Connection direct(Path directory) throws SQLException {
    return DriverManager.getConnection("jdbc:sqlite:" + directory.resolve("leanreview.sqlite"));
  }

  private long scalar(Connection connection, String sql) throws SQLException {
    try (var statement = connection.createStatement();
        var rows = statement.executeQuery(sql)) {
      assertThat(rows.next()).isTrue();
      return rows.getLong(1);
    }
  }

  private JsonNode normalized(JsonNode value, String key) {
    if (value.isObject()) {
      ObjectNode result = json.createObjectNode();
      value
          .fields()
          .forEachRemaining(
              entry -> result.set(entry.getKey(), normalized(entry.getValue(), entry.getKey())));
      return result;
    }
    if (value.isArray()) {
      var result = json.createArrayNode();
      value.forEach(item -> result.add(normalized(item, "")));
      return result;
    }
    if (value.isTextual() && key.endsWith("At"))
      return json.getNodeFactory().textNode("<timestamp>");
    if (value.isTextual() && value.asText().equals("/fixture/leanreview"))
      return json.getNodeFactory().textNode("<repository>");
    return value;
  }

  @ParameterizedTest
  @ValueSource(ints = {1, 2, 3})
  void legacyFixturesMigrateValidateAndReopenWithoutChangingTheSchemaOrReview(int version)
      throws Exception {
    Path directory = copy(version);
    JsonNode expectedReview = null;
    for (JsonNode example : json.readTree(fixtures.resolve("http.json").toFile())) {
      if (example.path("name").asText().equals("recovered review"))
        expectedReview = example.path("response").path("body");
    }
    assertThat(expectedReview).isNotNull();
    try (var context = start(directory)) {
      var store = context.getBean(ReviewStore.class);
      assertThat(normalized(store.review("session-fixture", null), "")).isEqualTo(expectedReview);
      assertThat(context.getBean(Repositories.Snapshots.class).history("session-fixture"))
          .extracting(row -> row.id)
          .containsExactly("snapshot-current", "snapshot-history");
      assertThat(
              context.getBean(Repositories.Settings.class).findById("provider").orElseThrow().value)
          .contains("fixture");
      if (version >= 2) {
        var report =
            context
                .getBean(Repositories.CoverageReports.class)
                .findById(new Rows.CoverageKey("snapshot-current", "istanbul"))
                .orElseThrow();
        assertThat(json.readTree(report.data).path("highest").asDouble()).isEqualTo(2.5);
        assertThat(context.getBean(CapturedArtifacts.class).read(report.rawHash))
            .contains("statementMap");
        assertThat(
                json.readTree(
                        context
                            .getBean(Repositories.TestRuns.class)
                            .findById("test-running")
                            .orElseThrow()
                            .data)
                    .path("status")
                    .asText())
            .isEqualTo("interrupted");
      }
      if (version == 3) {
        var graph =
            context
                .getBean(Repositories.Graphs.class)
                .findById(new Rows.GraphKey("snapshot-current", "before"))
                .orElseThrow();
        assertThat(json.readTree(graph.run).path("status").asText()).isEqualTo("interrupted");
        assertThat(
                json.readTree(context.getBean(CapturedArtifacts.class).read(graph.artifact))
                    .path("coverage")
                    .path("complete")
                    .asBoolean())
            .isFalse();
      }
      var pool = context.getBean(HikariDataSource.class);
      assertThat(pool.getMaximumPoolSize()).isEqualTo(1);
      // Evict and replace a physical connection to prove configuration is not initialization-only.
      try (var connection = pool.getConnection()) {
        assertConnection(connection);
        pool.evictConnection(connection);
      }
      try (var connection = pool.getConnection()) {
        assertConnection(connection);
      }
      assertThat(Version.getVersionString())
          .isEqualTo(SQLiteDialect.class.getPackage().getImplementationVersion());
      try (var connection = direct(directory)) {
        assertThat(scalar(connection, "PRAGMA user_version")).isEqualTo(3);
        JsonNode expectedTables =
            json.readTree(fixtures.resolve("storage.json").toFile()).path("v3").path("tables");
        for (JsonNode table : expectedTables) {
          try (var query =
              connection.prepareStatement("SELECT sql FROM sqlite_master WHERE name=?")) {
            query.setString(1, table.path("name").asText());
            try (var rows = query.executeQuery()) {
              assertThat(rows.next()).isTrue();
              assertThat(rows.getString(1)).isEqualTo(table.path("sql").asText());
            }
          }
        }
      }
    }
    try (var context = start(directory)) {
      assertThat(normalized(context.getBean(ReviewStore.class).review("session-fixture", null), ""))
          .isEqualTo(expectedReview);
    }
    try (var files = Files.list(directory)) {
      assertThat(
              files
                  .filter(file -> file.getFileName().toString().startsWith("leanreview.pre-v"))
                  .count())
          .isEqualTo(version < 3 ? 1 : 0);
    }
  }

  private void assertConnection(Connection connection) throws SQLException {
    assertThat(scalar(connection, "PRAGMA foreign_keys")).isEqualTo(1);
    assertThat(scalar(connection, "PRAGMA busy_timeout")).isEqualTo(5000);
    try (var statement = connection.createStatement();
        var rows = statement.executeQuery("PRAGMA journal_mode")) {
      assertThat(rows.next()).isTrue();
      assertThat(rows.getString(1)).isEqualTo("wal");
    }
    try (var statement = connection.createStatement();
        var rows = statement.executeQuery("PRAGMA integrity_check")) {
      assertThat(rows.next()).isTrue();
      assertThat(rows.getString(1)).isEqualTo("ok");
    }
    try (var statement = connection.createStatement();
        var rows = statement.executeQuery("PRAGMA foreign_key_check")) {
      assertThat(rows.next()).isFalse();
    }
  }

  @Test
  void jpaWritesCompositeKeysRollbackForeignKeysAndDatabaseCascades() throws Exception {
    Path directory = copy(3);
    try (var context = start(directory)) {
      var sessions = context.getBean(Repositories.Sessions.class);
      var snapshots = context.getBean(Repositories.Snapshots.class);
      var graphs = context.getBean(Repositories.Graphs.class);
      var reports = context.getBean(Repositories.CoverageReports.class);
      var tests = context.getBean(Repositories.TestRuns.class);
      var settings = context.getBean(Repositories.Settings.class);
      var transaction =
          new TransactionTemplate(
              context.getBean(org.springframework.transaction.PlatformTransactionManager.class));
      transaction.executeWithoutResult(
          status -> {
            Rows.Session session = new Rows.Session();
            session.id = "assigned-session";
            session.name = "Written by JPA";
            session.root = "/fixture";
            session.activeSnapshot = "assigned-snapshot";
            session.updatedAt = "2026-10-15T10:00:00.000Z";
            sessions.saveAndFlush(session);
            Rows.Snapshot snapshot = new Rows.Snapshot();
            snapshot.id = "assigned-snapshot";
            snapshot.sessionId = session.id;
            snapshot.data = "{\"unknown\":{\"keep\":true}}";
            snapshot.state = "{\"reviewed\":[],\"futureField\":123}";
            snapshots.saveAndFlush(snapshot);
            Rows.Graph graph = new Rows.Graph();
            graph.snapshotId = snapshot.id;
            graph.side = "after";
            graph.sources = "{}";
            graph.run = "{\"status\":\"succeeded\"}";
            graphs.saveAndFlush(graph);
            Rows.Coverage coverage = new Rows.Coverage();
            coverage.snapshotId = snapshot.id;
            coverage.format = "jacoco";
            coverage.data = "{}";
            coverage.rawHash = "a".repeat(64);
            reports.saveAndFlush(coverage);
            Rows.TestRun test = new Rows.TestRun();
            test.id = "assigned-test";
            test.snapshotId = snapshot.id;
            test.data = "{}";
            tests.saveAndFlush(test);
            Rows.Setting setting = new Rows.Setting();
            setting.key = "assigned-setting";
            setting.value = "{\"extra\":true}";
            settings.saveAndFlush(setting);
          });
      assertThat(snapshots.findById("assigned-snapshot").orElseThrow().state)
          .contains("futureField");
      assertThat(
              graphs
                  .findById(new Rows.GraphKey("assigned-snapshot", "after"))
                  .orElseThrow()
                  .artifact)
          .isNull();
      transaction.executeWithoutResult(
          status -> {
            var row = settings.findById("assigned-setting").orElseThrow();
            row.value = "{\"changed\":true}";
          });
      assertThat(settings.findById("assigned-setting").orElseThrow().value).contains("changed");
      assertThatThrownBy(
              () ->
                  transaction.executeWithoutResult(
                      status -> {
                        settings.deleteById("assigned-setting");
                        settings.flush();
                        throw new IllegalStateException("rollback proof");
                      }))
          .isInstanceOf(IllegalStateException.class);
      assertThat(settings.findById("assigned-setting")).isPresent();
      Rows.Snapshot orphan = new Rows.Snapshot();
      orphan.id = "orphan";
      orphan.sessionId = "missing";
      orphan.data = "{}";
      orphan.state = "{}";
      assertThatThrownBy(() -> snapshots.saveAndFlush(orphan))
          .isInstanceOf(org.springframework.dao.DataAccessException.class)
          .hasStackTraceContaining("SQLITE_CONSTRAINT_FOREIGNKEY");
      sessions.deleteById("assigned-session");
      assertThat(snapshots.findById("assigned-snapshot")).isEmpty();
      assertThat(graphs.findById(new Rows.GraphKey("assigned-snapshot", "after"))).isEmpty();
      assertThat(reports.findById(new Rows.CoverageKey("assigned-snapshot", "jacoco"))).isEmpty();
      assertThat(tests.findById("assigned-test")).isEmpty();
    }
    try (var context = start(directory)) {
      assertThat(
              context
                  .getBean(Repositories.Settings.class)
                  .findById("assigned-setting")
                  .orElseThrow()
                  .value)
          .contains("changed");
    }
  }

  @Test
  void simultaneousTransactionsDoNotLoseUpdates() throws Exception {
    Path directory = copy(3);
    try (var context = start(directory);
        var executor = Executors.newFixedThreadPool(4)) {
      var repository = context.getBean(Repositories.Settings.class);
      var transaction =
          new TransactionTemplate(
              context.getBean(org.springframework.transaction.PlatformTransactionManager.class));
      Rows.Setting counter = new Rows.Setting();
      counter.key = "counter";
      counter.value = "0";
      repository.saveAndFlush(counter);
      var ready = new CountDownLatch(4);
      var go = new CountDownLatch(1);
      var futures = new ArrayList<java.util.concurrent.Future<?>>();
      for (int i = 0; i < 4; i++)
        futures.add(
            executor.submit(
                () -> {
                  ready.countDown();
                  try {
                    if (!go.await(10, TimeUnit.SECONDS))
                      throw new IllegalStateException("No start signal");
                  } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                  }
                  for (int update = 0; update < 10; update++)
                    transaction.executeWithoutResult(
                        status -> {
                          var value = repository.findById("counter").orElseThrow();
                          value.value = Integer.toString(Integer.parseInt(value.value) + 1);
                        });
                }));
      assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
      go.countDown();
      for (var future : futures) future.get(30, TimeUnit.SECONDS);
      assertThat(repository.findById("counter").orElseThrow().value).isEqualTo("40");
    }
  }

  @Test
  void unknownJsonFieldsAndExplicitNullsSurviveUpdatesAndRecovery() throws Exception {
    Path directory = copy(3);
    try (var context = start(directory)) {
      var repository = context.getBean(Repositories.Snapshots.class);
      var transaction =
          new TransactionTemplate(
              context.getBean(org.springframework.transaction.PlatformTransactionManager.class));
      transaction.executeWithoutResult(
          status -> {
            try {
              var row = repository.findById("snapshot-current").orElseThrow();
              ObjectNode data = (ObjectNode) json.readTree(row.data);
              data.putObject("futureMetadata").put("keep", true).putNull("explicitNull");
              row.data = json.writeValueAsString(data);
              ObjectNode state = (ObjectNode) json.readTree(row.state);
              state.put("analysisStatus", "running");
              state.putObject("futureState").put("count", 42);
              state.withArray("reviewed").add("file-java");
              row.state = json.writeValueAsString(state);
            } catch (IOException error) {
              throw new IllegalStateException(error);
            }
          });
    }
    try (var context = start(directory)) {
      JsonNode review = context.getBean(ReviewStore.class).review("session-fixture", null);
      assertThat(review.path("snapshot").path("futureMetadata").path("keep").asBoolean()).isTrue();
      assertThat(review.path("snapshot").path("futureMetadata").get("explicitNull").isNull())
          .isTrue();
      assertThat(review.path("state").path("futureState").path("count").asInt()).isEqualTo(42);
      assertThat(review.path("state").path("analysisStatus").asText()).isEqualTo("interrupted");
      assertThat(review.path("state").path("reviewed").toString())
          .isEqualTo("[\"file-ts\",\"file-java\"]");
    }
  }

  @Test
  void ownershipIsExclusiveAndReleasedWhenContextCloses() throws Exception {
    Path directory = copy(3);
    try (var context = start(directory)) {
      assertThatThrownBy(() -> new DatabaseOwner(directory))
          .isInstanceOf(IOException.class)
          .hasMessageContaining("Another Java backend");
    }
    try (var owner = new DatabaseOwner(directory)) {
      assertThat(owner).isNotNull();
    }
  }

  @Test
  void artifactsPreserveUtf8HashesAndFailOnMissingOrCorruptContent() throws Exception {
    Path directory = copy(3);
    try (var context = start(directory)) {
      var artifacts = context.getBean(CapturedArtifacts.class);
      String digest = artifacts.write("café 😀\r\n");
      assertThat(artifacts.read(digest)).isEqualTo("café 😀\r\n");
      assertThat(artifacts.write("café 😀\r\n")).isEqualTo(digest);
      assertThatThrownBy(() -> artifacts.read("../outside"))
          .hasMessage("Invalid captured artifact identity.");
      Files.writeString(directory.resolve("cache").resolve(digest), "corrupted");
      assertThatThrownBy(() -> artifacts.read(digest)).hasMessageContaining("corrupt");
      assertThatThrownBy(() -> artifacts.write("café 😀\r\n")).hasMessageContaining("corrupt");
      Files.delete(directory.resolve("cache").resolve(digest));
      assertThatThrownBy(() -> artifacts.read(digest)).hasMessageContaining("missing");
      String source = "0ef4de140637e47053840361c7bdcc7d2359e6fc66de6525bfac5decb2cd6aff";
      Files.delete(directory.resolve("cache").resolve(source));
      assertThatThrownBy(() -> context.getBean(ReviewStore.class).review("session-fixture", null))
          .hasMessageContaining("Captured artifact is missing");
    }
  }

  @Test
  void newerSchemasAreRejectedAndTheOwnershipLockIsReleasedOnStartupFailure() throws Exception {
    Path directory = copy(3);
    try (var connection = direct(directory);
        var statement = connection.createStatement()) {
      statement.execute("PRAGMA user_version=4");
    }
    assertThatThrownBy(() -> start(directory))
        .hasStackTraceContaining("Database is newer than this application");
    try (var owner = new DatabaseOwner(directory);
        var connection = direct(directory)) {
      assertThat(scalar(connection, "PRAGMA user_version")).isEqualTo(4);
    }
  }

  @Test
  void migrationFailureRollsBackAllDdlAndKeepsAReadableBackup() throws Exception {
    Path directory = copy(1);
    try (var owner = new DatabaseOwner(directory);
        var connection = direct(directory)) {
      assertThatThrownBy(
              () ->
                  SchemaMigrations.migrate(
                      connection,
                      directory,
                      version ->
                          version == 2
                              ? "CREATE TABLE temporary_migration (value TEXT);"
                              : "THIS IS NOT SQL;"))
          .isInstanceOf(SQLException.class)
          .hasMessageContaining("rolled back");
      assertThat(scalar(connection, "PRAGMA user_version")).isEqualTo(1);
      assertThat(
              scalar(
                  connection,
                  "SELECT count(*) FROM sqlite_master WHERE name='temporary_migration'"))
          .isZero();
      assertThat(scalar(connection, "SELECT count(*) FROM snapshots")).isEqualTo(2);
    }
    try (var files = Files.list(directory)) {
      Path backup =
          files
              .filter(file -> file.getFileName().toString().startsWith("leanreview.pre-v2."))
              .findFirst()
              .orElseThrow();
      try (var connection = DriverManager.getConnection("jdbc:sqlite:" + backup)) {
        assertThat(scalar(connection, "SELECT count(*) FROM snapshots")).isEqualTo(2);
      }
    }
    try (var context = start(directory)) {
      assertThat(context.getBean(Repositories.Snapshots.class).count()).isEqualTo(2);
    }
  }

  @Test
  void backupIncludesCommittedWalContentAndFreshDatabaseInitializationIsRepeatable()
      throws Exception {
    Path directory = copy(2);
    try (var writer = direct(directory);
        var statement = writer.createStatement()) {
      statement.execute("PRAGMA journal_mode=WAL");
      statement.execute("PRAGMA wal_autocheckpoint=0");
      statement.execute("INSERT INTO settings VALUES ('wal-proof','123')");
      assertThat(Files.size(directory.resolve("leanreview.sqlite-wal"))).isPositive();
      try (var context = start(directory)) {
        assertThat(
                context
                    .getBean(Repositories.Settings.class)
                    .findById("wal-proof")
                    .orElseThrow()
                    .value)
            .isEqualTo("123");
      }
      try (var files = Files.list(directory)) {
        Path backup =
            files
                .filter(file -> file.getFileName().toString().startsWith("leanreview.pre-v3."))
                .findFirst()
                .orElseThrow();
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + backup)) {
          assertThat(scalar(connection, "SELECT value FROM settings WHERE key='wal-proof'"))
              .isEqualTo(123);
        }
      }
    }
    Path fresh = temporary.resolve("fresh");
    for (int i = 0; i < 2; i++)
      try (var context = start(fresh)) {
        assertThat(context.getBean(Repositories.Sessions.class).count()).isZero();
      }
    try (var files = Files.list(fresh)) {
      assertThat(
              files
                  .filter(file -> file.getFileName().toString().startsWith("leanreview.pre-v"))
                  .count())
          .isZero();
    }
  }
}
