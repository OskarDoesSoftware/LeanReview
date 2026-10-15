package dev.leanreview.storage;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.io.IOException;
import java.nio.file.Path;
import java.sql.SQLException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.sqlite.SQLiteConfig;
import org.sqlite.SQLiteDataSource;

@Configuration
@EnableJpaRepositories(basePackageClasses = Repositories.class, considerNestedRepositories = true)
public class StorageConfiguration {
  private static Path directory(String configured) {
    if (configured.isBlank())
      throw new IllegalArgumentException(
          "Set LEANREVIEW_JAVA_DATA_DIR to an isolated data directory. The Java backend is not the"
              + " default application yet.");
    return Path.of(configured).toAbsolutePath().normalize();
  }

  @Bean(destroyMethod = "close")
  DatabaseOwner databaseOwner(@Value("${leanreview.data-directory}") String configured)
      throws IOException {
    return new DatabaseOwner(directory(configured));
  }

  @Bean(destroyMethod = "close")
  HikariDataSource dataSource(
      DatabaseOwner owner, @Value("${leanreview.data-directory}") String configured)
      throws SQLException, IOException {
    Path directory = directory(configured);
    SQLiteConfig sqlite = new SQLiteConfig();
    sqlite.enforceForeignKeys(true);
    sqlite.setBusyTimeout(5000);
    sqlite.setJournalMode(SQLiteConfig.JournalMode.WAL);
    SQLiteDataSource source = new SQLiteDataSource(sqlite);
    source.setUrl("jdbc:sqlite:" + directory.resolve("leanreview.sqlite"));
    try (var connection = source.getConnection()) {
      SchemaMigrations.migrate(connection, directory);
    }
    HikariConfig pool = new HikariConfig();
    pool.setDataSource(source);
    pool.setMaximumPoolSize(1);
    pool.setMinimumIdle(1);
    pool.setConnectionTimeout(10000);
    pool.setPoolName("leanreview-sqlite");
    return new HikariDataSource(pool);
  }

  @Bean
  ObjectMapper storageJson() {
    return new ObjectMapper()
        .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
  }
}
