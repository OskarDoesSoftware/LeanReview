# Java launch and acceptance

Java is the default backend after the completed [platform/performance gate](https://github.com/OskarDoesSoftware/LeanReview/issues/27). The [cutover](https://github.com/OskarDoesSoftware/LeanReview/issues/28) retires the Express runtime while preserving React, SQLite, and the bounded parser helper.

Set `JAVA_HOME` to JDK 25 and install workspace dependencies with Node 24. From the repository root:

```text
npm run build
npm start
```

The build command builds React and the pinned parser helper and runs Maven Wrapper verification. Start uses the packaged JAR, absolute asset/helper paths, the pinned workspace Node process for the helper, loopback port 4318, and automatic browser opening. `npm run dev` builds first, then runs Vite on 5173 with Java on 4318. Stop the previous application process before starting. The launcher checks port availability before opening application data.

The default directory is the original `LeanReview` application-data directory: `%LOCALAPPDATA%/LeanReview` on Windows, `~/Library/Application Support/LeanReview` on macOS, and `$XDG_DATA_HOME/LeanReview` or `~/.local/share/LeanReview` on Linux. Existing saved reviews reopen there. Set `LEANREVIEW_DATA_DIR` to select another directory and `LEANREVIEW_PORT` for another production port; development requires 4318. The previous `LEANREVIEW_JAVA_DATA_DIR` and `LEANREVIEW_JAVA_PORT` overrides remain supported when the standard overrides are absent. Preview data is not silently merged into production; choose its directory explicitly to continue those reviews. `LEANREVIEW_NO_OPEN=1` displays the startup link. Keep that link and its cookie private.

Before first production use of an existing database, Java creates `backups/pre-java-<uuid>/` inside the data directory. This contains a consistent SQLite database, all hash-verified captured artifacts, and a `backup.json` completion manifest. Referenced snapshot, graph, and coverage artifacts must all be present. A failed backup prevents startup. Only after backup and migration succeed is `java-cutover.json` written, so subsequent starts reuse the checkpoint. Fresh databases need no prior-data backup. Credentials and CLI login profiles are excluded. Startup never changes the configured schema to make an older backend compatible.

Shutdown terminates owned processes. Windows uses the owned process subtree because terminating a JVM from Node does not reliably run Java shutdown hooks. Unix requests shutdown and bounds its wait before terminating the owned process group. Existing SQLite transaction recovery and exclusive Java ownership remain in effect.

## Paired backup and recovery

Use the workspace Node runtime. Stop the application before a release restore or cutover. These commands require a new destination and never overwrite existing user data:

```text
node scripts/data-backup.mjs backup ABSOLUTE_DATA_DIRECTORY NEW_BACKUP_DIRECTORY
node scripts/data-backup.mjs restore BACKUP_DIRECTORY NEW_RESTORE_DIRECTORY
```

The manual tool uses Node 24's built-in SQLite online backup API, including committed WAL contents. Automatic cutover uses SQLite `VACUUM INTO` through Java JDBC. Both create the same manifest format and preserve hash-verified immutable cache artifacts. Restore checks every manifest digest before creating a fresh directory. A failed or interrupted backup without a valid completion manifest must not be used for recovery.

To roll back, stop Java and restore the paired pre-Java backup to a new directory with the command above. Use the pre-cutover revision `77df360` in a separate checkout, install its pinned dependencies, build it there, and set `LEANREVIEW_DATA_DIR` to that restored directory before running its Node launcher. Keep the current database/cache untouched for recovery. Never point the old backend at data written by Java, even when the current schema number is the same. Restore both the database and cache from the same manifest.

Recovery checks restore the frozen version-3 fixture, reopen its saved review, refuse existing destinations, and reject modified databases. Cutover tests verify that the backup precedes interrupted-job recovery, is created once, and fails without changing review data when artifacts are corrupt. The default-launcher smoke check also restores its Java-created backup with the Node recovery tool. All drills use isolated synthetic data.

## Acceptance evidence

The Windows source build and fixture suites are executable locally. `tests/java-browser-setup.mjs` consumes the isolated fixture's launch nonce once and supplies authenticated browser contexts without sharing a user's login. The Java browser suite covers the local review, synthetic Codex sign-in/inference, parser/coverage harness, repository picker, and fixture GitHub review cycle.

An explicit live Codex test uses only a one-file synthetic diff and the existing CLI-owned login. Set `LEANREVIEW_LIVE_CODEX_DATA` to the parent application data directory and run Maven with `-Dtest=LiveCodexAcceptanceTest`. It does not open a database or read/copy authentication files. The test passed on Windows on 2026-10-15 in 18.46 seconds.

The [Windows/macOS/Linux matrix on 8d68c7b](https://github.com/OskarDoesSoftware/LeanReview/actions/runs/38741049550) passed on all three platforms. It covers Java verification, native credential interoperability, packaged startup/shutdown, paired backup recovery, and both Java browser journeys. macOS uses a disposable fixture keychain with access scoped to the synthetic test executables; Linux uses an unlocked fixture Secret Service session. This does not establish interactive desktop prompt behavior for every credential-store configuration.

The user approved numeric budgets, and all nine optimized Windows runs pass them. See [performance acceptance](java-performance-acceptance.md) for the approved ceilings, exact artifact identities, process-tree memory method, retained failing report, and narrow startup/warm-scan margins. The original JVM-only report remains historical evidence and cannot satisfy the process-memory gate. CI validates the recorded Windows report; it does not run fresh performance measurements on every platform.

Live GitHub verification remains read-only at the user's request. Fixtures exercise publication and reconciliation, while actual shared comment/review/thread writes remain unperformed. That limitation belongs to the separate GitHub review feature acceptance in issue [30](https://github.com/OskarDoesSoftware/LeanReview/issues/30).

## Runtime and regression ownership after cutover

Express routes, Node storage/credentials/provider orchestration, and the old Node launcher are removed. Runtime npm dependencies no longer include Express, better-sqlite3, fast-xml-parser, open, or the Node keyring binding. `@napi-rs/keyring` remains a development-only interoperability fixture so CI can prove Java reads the previous binding's credentials. Recovery tooling uses Node's built-in SQLite API. The helper's TypeScript compiler, Tree-sitter runtime, and pinned grammar remain intentional dependencies.

The Java suite owns API/session protection, Git capture, saved reviews, state concurrency, provider/Codex adapters, credentials, graphs, coverage, test execution, and rollback compatibility. Frozen fixture data is retained unchanged. Frontend navigation, progress text, workspace memory, graph projection, helper parity, backup tooling, and performance-checker tests remain in Vitest. Node backend tests and baseline-regeneration scripts were retired with their implementation; original sources remain available at `77df360`.

`npm run test:browser` runs the Java-backed local/GitHub workflows and retained frontend browser scenarios on the same Java fixture server. `playwright.java.config.ts` forwards to the default configuration for older links. CI builds through `npm run build`, checks the launcher and restored backup, runs all Vitest tests, and exercises the default browser command on Windows, macOS, and Linux.
