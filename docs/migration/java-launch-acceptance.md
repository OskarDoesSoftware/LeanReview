# Java launch and acceptance

Java remains opt-in until issue [27](https://github.com/OskarDoesSoftware/LeanReview/issues/27) passes and the cutover in [28](https://github.com/OskarDoesSoftware/LeanReview/issues/28) is authorized by that evidence.

Set `JAVA_HOME` to JDK 25 and install workspace dependencies with Node 24. From the repository root:

```text
npm run build:java
npm run start:java
npm run dev:java
```

The build command builds React and the pinned parser helper and runs Maven Wrapper verification. Start uses the packaged JAR, absolute asset/helper paths, the pinned workspace Node process for the helper, loopback port 4318, and automatic browser opening. Development runs Vite on 5173 with the Java API proxy on 4318. Stop either existing backend before using that port.

The default preview data directory is `LeanReview-JavaPreview` under the platform application-data directory. It deliberately differs from the existing Node data directory. Set `LEANREVIEW_JAVA_DATA_DIR` to a separate absolute directory to test a restored copy. `LEANREVIEW_JAVA_PORT` can select a different packaged-preview port; the development proxy requires 4318. `LEANREVIEW_NO_OPEN=1` displays the one-time startup link instead of opening the browser. Do not publish this link or its launch cookie.

Shutdown terminates owned processes. Windows uses the owned process subtree because terminating a JVM from Node does not reliably run Java shutdown hooks. Unix requests shutdown and bounds its wait before terminating the owned process group. Existing SQLite transaction recovery and exclusive Java ownership remain in effect.

## Paired backup and recovery

Use the workspace Node runtime. Stop the application before a release restore or cutover. These commands require a new destination and never overwrite existing user data:

```text
node scripts/data-backup.mjs backup ABSOLUTE_DATA_DIRECTORY NEW_BACKUP_DIRECTORY
node scripts/data-backup.mjs restore BACKUP_DIRECTORY NEW_RESTORE_DIRECTORY
```

Backup uses SQLite's online backup API, which includes committed WAL contents, and copies SHA-256-verified immutable cache artifacts. It checks SQLite integrity and the snapshot artifact references before writing its completion manifest. Credentials and CLI account profiles are excluded. Restore checks every manifest digest before creating a fresh directory. A failed or interrupted backup without a valid completion manifest must not be used for recovery.

The recovery regression restores the frozen version-3 fixture, reopens the exact saved review, refuses an existing destination, and rejects a modified database. This is a recovery drill on fixture data, not a backup of the user's active workspace.

## Acceptance evidence

The Windows source build and fixture suites are executable locally. `tests/java-browser-setup.mjs` consumes the isolated fixture's launch nonce once and supplies authenticated browser contexts without sharing a user's login. The Java browser suite covers the local review, synthetic Codex sign-in/inference, parser/coverage harness, repository picker, and fixture GitHub review cycle.

An explicit live Codex test uses only a one-file synthetic diff and the existing CLI-owned login. Set `LEANREVIEW_LIVE_CODEX_DATA` to the parent application data directory and run Maven with `-Dtest=LiveCodexAcceptanceTest`. It does not open a database or read/copy authentication files. The test passed on Windows on 2026-10-15 in 18.46 seconds.

The [Windows/macOS/Linux matrix on 8d68c7b](https://github.com/OskarDoesSoftware/LeanReview/actions/runs/38741049550) passed on all three platforms. It covers Java verification, native credential interoperability, packaged startup/shutdown, paired backup recovery, and both Java browser journeys. macOS uses a disposable fixture keychain with access scoped to the synthetic test executables; Linux uses an unlocked fixture Secret Service session. This does not establish interactive desktop prompt behavior for every credential-store configuration.

The user approved numeric budgets, and all nine optimized Windows runs pass them. See [performance acceptance](java-performance-acceptance.md) for the approved ceilings, exact artifact identities, process-tree memory method, retained failing report, and narrow startup/warm-scan margins. The original JVM-only report remains historical evidence and cannot satisfy the process-memory gate. CI validates the recorded Windows report; it does not run fresh performance measurements on every platform.

Live GitHub verification remains read-only at the user's request. Fixtures exercise publication and reconciliation, while actual shared comment/review/thread writes remain unperformed. That limitation belongs to the separate GitHub review feature acceptance in issue [30](https://github.com/OskarDoesSoftware/LeanReview/issues/30).
