# Java backend migration

This module implements the storage foundation for [#23](https://github.com/OskarDoesSoftware/LeanReview/issues/23), the local HTTP API and manual review flow for [#24](https://github.com/OskarDoesSoftware/LeanReview/issues/24), and credentials/review analysis for [#25](https://github.com/OskarDoesSoftware/LeanReview/issues/25). The application launcher still uses the Node backend. Java HTTP startup is opt-in while graph, coverage, packaging, platform acceptance, and cutover work continues in later migration issues.

## Try the React UI with Java

Build the frontend with `npm run build` from the repository root. In this directory, set `JAVA_HOME` to JDK 25, then run:

```powershell
.\mvnw.cmd verify
java --enable-native-access=ALL-UNNAMED -jar target/leanreview-backend-0.1.0-SNAPSHOT.jar --spring.profiles.active=web --server.port=4324 --leanreview.origin=http://127.0.0.1:4324 --leanreview.data-directory=../.leanreview-test/java-manual
```

Open the startup link printed by Java. It expires after five minutes and works once; the browser then uses an HttpOnly cookie for that launch. The server always binds to loopback. Host and Origin checks protect API requests, mutations require the configured origin, responses use `no-store`, and JSON bodies are capped at 1 MiB.

Use an isolated data directory. To test existing reviews, stop the original backend and copy its database and entire cache together into that directory first. Do not let Node and Java write the same database concurrently. Java's ownership lock only coordinates Java processes.

The web profile serves the built frontend from `../frontend/dist`; override `--leanreview.frontend-directory` with an absolute directory when launching elsewhere. Git capture runs outside database transactions, uses argument-only subprocesses with time/output bounds, and rejects a capture when consecutive reads disagree. Refresh checks the current snapshot again in its write transaction. Progress, manual grouping, draft comments, historical snapshots, and editor settings retain the existing JSON format.

After `verify` and the frontend build, run the browser acceptance test from the repository root with `npx playwright test --config playwright.java.config.ts`. It starts an isolated Java server on port 4324 and uses temporary fixture data and a local fixture provider. It covers migrated/new reviews, manifest authorization, inference, proposal acceptance, manual edits, refresh, and history. It does not call live models or the graph APIs that belong to subsequent issues.

## Credentials and analysis

Java supports Ollama, OpenAI Responses, and Anthropic Messages through the existing provider settings and manifest flow. An explicit authorization is required before sending captured diffs. Generated/vendor files and over-budget diffs are omitted with reasons. One application-wide slot covers credential lookup and all sequential batches; cancellation keeps that slot until the owned work settles. Invalid, incomplete, oversized, or failed provider output preserves accepted grouping and manual edits.

Session-only keys live in backend memory. Persistent keys use Windows Credential Manager through JNA, macOS Keychain through java-keyring, or explicitly Linux Secret Service through java-keyring. There is no plaintext or automatic session-storage fallback. The API never returns keys. Windows read/write interoperability with the existing Node binding is verified using a temporary credential; macOS/Linux interoperability still needs platform acceptance. If lookup is unavailable, re-enter the key in settings and explicitly choose its storage mode.

The Node Codex subscription feature is tracked separately for Java in [#36](https://github.com/OskarDoesSoftware/LeanReview/issues/36), which blocks final platform acceptance. Java currently rejects that provider explicitly. See `docs/migration/java-review-analysis.md` for the evidence and scope limits.

## Toolchain

The tested JDK distribution is Eclipse Temurin 25.0.4.1+1. Set `JAVA_HOME` to that JDK. The Maven Wrapper pins Maven 3.9.11 and verifies the distribution SHA-256. Spring Boot 4.1.1 manages Spring Data JPA and Hibernate; `hibernate-community-dialects` uses the same managed version as Hibernate core. SQLite JDBC is pinned to 3.53.4.0.

From this directory:

```powershell
.\mvnw.cmd test
```

On macOS or Linux, run `sh ./mvnw test`. Tests use temporary copies of the frozen databases and cache files under `../tests/fixtures/backend-compatibility`. They never open the default user database. Maven needs network access on its first run. Use `verify` instead of `test` to also build the executable JAR.

For a storage-only startup, set `LEANREVIEW_JAVA_DATA_DIR` to an isolated directory and run `mvnw.cmd spring-boot:run`. After `verify`, the equivalent packaged smoke command is `java --enable-native-access=ALL-UNNAMED -jar target/leanreview-backend-0.1.0-SNAPSHOT.jar --leanreview.data-directory=../.leanreview-test/java-smoke`. Without the web profile, Java initializes storage and exits cleanly.

## Persistence behavior

Numbered SQL migrations and `PRAGMA user_version` own the schema. Hibernate validates mappings and never creates or updates tables. The existing TEXT JSON, assigned identifiers, composite keys, table names, and artifact hashes remain compatible. History explicitly orders by SQLite rowid.

Every physical connection enables foreign keys, WAL, and a 5,000 ms busy timeout. A single-connection Hikari pool serializes transactions. Startup holds an exclusive file lock through migration and application shutdown. Running graph, test, and analysis records become interrupted on restart; their other JSON fields remain intact.

Before migrating an existing database, `VACUUM INTO` creates a consistent `leanreview.pre-vN.<uuid>.sqlite` backup including committed WAL data. All pending migration statements run in one transaction. Failure rolls back the schema and preserves the backup. A newer schema version is rejected.

Captured artifacts remain SHA-256-addressed UTF-8 files in `cache/`. Writes use an atomic move before any database reference can be committed. Reads reject invalid identities, missing files, malformed UTF-8, and hash mismatches. They never substitute working-tree content.

The tested SQLite dialect reports foreign-key rejection through Spring's generic DataAccessException/JpaSystemException path rather than consistently through DataIntegrityViolationException. The constraint still rejects the write. The HTTP migration must translate storage failures without relying solely on that exception subtype.

## Recovery and evidence

Stop the application before recovery. Keep the original database, any WAL/SHM sidecars, and the entire cache together. To restore a pre-migration database, copy its backup and the matching cache into a separate data directory, name the database `leanreview.sqlite`, and verify that copy before replacing application data. Database migration backups do not include the cache and are not a replacement for a paired database/cache backup before production cutover.

Verified on Windows x64 with the toolchain above on 2026-10-15: all 11 `StorageCompatibilityTest` cases pass. These cover schema versions 1, 2, and 3, exact recovered review JSON, schema validation, read/write/reopen, composite keys, rollback, cascades, connection replacement, concurrent transactions, exclusive ownership, failed startup, artifacts, failed migration recovery, and committed WAL backup contents. The complete suite now has 45 cases: 44 pass and one skips symlink creation because this Windows account lacks permission. React browser acceptance against the packaged Java backend also passes. See `docs/migration/java-core-api.md` and `docs/migration/java-review-analysis.md` for API/analysis evidence and remaining platform limits.
