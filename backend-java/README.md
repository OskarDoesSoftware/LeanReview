# Java backend migration

This module is the default application backend. It implements storage (#23), the local API and review flow (#24), credentials and review analysis (#25), graphs, coverage, and explicit tests (#26), plus the GitHub review workflow. Standard commands are `npm run build`, `npm start`, and `npm run dev` at the repository root. See [launch and recovery](../docs/migration/java-launch-acceptance.md) for first-start backup, supported platforms, and rollback.

## Run the application

Set `JAVA_HOME` to JDK 25, ensure Node 24 and Git are available, then run from the repository root:

```powershell
npm ci
npm run build
npm start
```

Open the startup link printed by Java. It expires after five minutes and works once; the browser then uses an HttpOnly cookie for that launch. The server always binds to loopback. Host and Origin checks protect API requests, mutations require the configured origin, and responses use `no-store`. JSON bodies are capped at 1 MiB, with a separate 20 MiB coverage-import limit.

The launcher uses the original platform `LeanReview` data directory and creates a verified paired backup before first Java use of existing data. For an isolated run, set `LEANREVIEW_DATA_DIR` to a separate absolute path. Stop any previous backend first. Java's ownership lock coordinates Java processes only. See the linked recovery guide before rollback.

The web profile serves the built frontend from `../frontend/dist`; override `--leanreview.frontend-directory` with an absolute directory when launching elsewhere. Git capture runs outside database transactions, uses argument-only subprocesses with time/output bounds, and rejects a capture when consecutive reads disagree. Refresh checks the current snapshot again in its write transaction. Progress, manual grouping, draft comments, historical snapshots, and editor settings retain the existing JSON format.

After `npm run build`, run `npm run test:browser` from the repository root. It starts an isolated Java server on port 4324 and uses temporary fixture data and a local fixture provider. The main UI test covers migrated/new reviews, manifest authorization, inference, proposal acceptance, manual edits, refresh, and history. An isolated harness exercises the retained graph/coverage components, including confirmed fixture commands, while those controls are parked in the primary UI. It does not call live models.

See [Java graphs, coverage, and explicit tests](../docs/migration/java-graph-coverage.md) for the bounded parser helper, temporary Tree-sitter Java boundary, pinned-source behavior, and process lifecycle. The helper uses captured input; ordinary scans never execute repository scripts.

## Credentials and analysis

Java supports Ollama, OpenAI Responses, and Anthropic Messages through the existing provider settings and manifest flow. An explicit authorization is required before sending captured diffs. Generated/vendor files and over-budget diffs are omitted with reasons. One application-wide slot covers credential lookup and all sequential batches; cancellation keeps that slot until the owned work settles. Invalid, incomplete, oversized, or failed provider output preserves accepted grouping and manual edits.

Session-only keys live in backend memory. Persistent keys use Windows Credential Manager through JNA, macOS Keychain through java-keyring, or explicitly Linux Secret Service through java-keyring. There is no plaintext or automatic session-storage fallback. The API never returns keys. Windows read/write interoperability with the existing Node binding is verified using a temporary credential; macOS/Linux interoperability still needs platform acceptance. If lookup is unavailable, re-enter the key in settings and explicitly choose its storage mode.

Java supports the Codex subscription provider through the installed CLI app-server in [#36](https://github.com/OskarDoesSoftware/LeanReview/issues/36). See [Java Codex analysis](../docs/migration/java-codex.md) for credential ownership, protocol limits, and verification.

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

Verified on Windows x64 with the toolchain above on 2026-10-15: all 11 `StorageCompatibilityTest` cases pass. These cover schema versions 1, 2, and 3, exact recovered review JSON, schema validation, read/write/reopen, composite keys, rollback, cascades, connection replacement, concurrent transactions, exclusive ownership, failed startup, artifacts, failed migration recovery, and committed WAL backup contents. The final shared-checkout suite has 53 cases: 52 pass and one skips symlink creation because this Windows account lacks permission. Later focused runs verify the expanded graph/coverage HTTP replay and final process changes. See `docs/migration/java-core-api.md`, `docs/migration/java-review-analysis.md`, and `docs/migration/java-graph-coverage.md` for evidence and platform limits.
