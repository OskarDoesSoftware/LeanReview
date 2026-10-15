# Spring Data JPA and SQLite compatibility evidence

Verified on 2026-10-15 for [migration step 2](https://github.com/OskarDoesSoftware/LeanReview/issues/23). This is a storage milestone; the React/Node launcher remains the application entry point.

## Verified stack

| Component | Version |
| --- | --- |
| Eclipse Temurin JDK | 25.0.4.1+1 |
| Maven Wrapper / Maven | 3.3.4 / 3.9.11 |
| Spring Boot | 4.1.1 |
| Spring Data JPA | 4.1.1 |
| Hibernate core and community dialect | 7.4.5.Final |
| SQLite JDBC | 3.53.4.0 |
| HikariCP | 7.0.2 |
| Jackson storage JSON trees | 2.21.5 |

The wrapper pins the Maven distribution URL and SHA-256. Boot manages matching Hibernate versions; an integration assertion checks their runtime version equality. Java compilation targets 25 and Maven rejects other Java major versions. The tested JDK patch is recorded in backend-java/.java-version. Local tool downloads are isolated under .leanreview-test/java-tools; the system Java installation was not changed.

## Results

`mvnw verify` passes all 14 integration cases, including the 11 storage compatibility cases and three state-mutation checks added concurrently, and builds the executable Spring Boot JAR. The packaged non-web application also initializes a fresh isolated database and exits successfully. No user database or credential store was opened.

The cases establish:

- Frozen v1, v2, and v3 SQLite files migrate, validate under Hibernate, and reopen twice. Exact current table DDL remains identical to the frozen schema.
- The JPA/artifact reader produces the frozen Node recovered-review JSON after documented timestamp/root normalization. Progress, Unicode drafts, file kinds, patchHash, nulls, and history order remain compatible.
- Every stored row type is mapped, including assigned IDs and coverage/graph composite keys. JPA writes, updates, rollback, database foreign keys, and cascading deletes work on real SQLite files.
- A one-connection pool supports 40 simultaneous read-modify-write increments without lost updates. Replacement physical connections retain foreign keys, WAL, and the 5,000ms busy timeout.
- A second Java owner is rejected. Normal shutdown and failed startup release ownership. The existing Node backend does not honor this lock and must use a different data directory during migration.
- Numbered SQL runs before Hibernate and commits all pending migrations atomically. Injected migration failure rolls back DDL/user_version, preserves readable backup data, and permits a later successful retry.
- VACUUM INTO includes committed WAL data. Newer schema versions abort startup. Fresh initialization and reopening are repeatable.
- Running jobs recover as interrupted. Unknown JSON properties and explicit nulls survive edits and recovery.
- Artifact hashes and UTF-8 content survive reuse; invalid IDs and missing/corrupt content fail without working-tree fallback. File contents are forced before atomic rename.

The SQLite community dialect does not consistently classify foreign-key failures as Spring DataIntegrityViolationException in this dependency set. Tests verify the actual constraint rejection through DataAccessException and the SQLite error. API error translation must account for that behavior in the next milestone.

## Reproduce

Set JAVA_HOME to the tested JDK and run from backend-java/:

```powershell
.\mvnw.cmd verify
```

On macOS/Linux, use `sh ./mvnw verify`. Cross-platform execution has not been established by this Windows run. See [the module README](../../backend-java/README.md) for isolated startup and backup recovery instructions.

## Node regression status

The existing Node compatibility suite was also attempted. Five of seven checks passed. The schema check detected a concurrent addition of `codex` to the provider enum; the HTTP replay timed out during capture and also timed out in a separate rerun. Frozen expectations were preserved. These results do not establish a clean current Node regression run and require follow-up with the concurrent backend work. The Java storage suite independently continues to consume the original frozen fixture files.
