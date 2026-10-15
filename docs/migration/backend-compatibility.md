# Backend compatibility baseline

This is historical evidence from the retired Node backend. The commands below belong to the pre-cutover revision `77df360`. Current verification uses `npm test`, `npm run build`, and `npm run test:browser` against Java. Frozen fixture files remain unchanged and are replayed by the Java suite and helper parity test. Node capture/regeneration tools were retired with Express; use the historical revision in a separate checkout if a deliberate baseline comparison is needed.

This freezes the Node backend before the Java migration in [the baseline ticket](https://github.com/OskarDoesSoftware/LeanReview/issues/22). It adds no Java implementation and changes no application behavior. All fixtures contain synthetic source, identifiers, comments, and settings. No user database, private repository, OS credential store, or external model is read.

## Reproduce

Use the pinned Node 24 runtime through npm scripts after `npm ci`:

```sh
npm run test:compatibility
npm run typecheck
npm test
npm run benchmark:backend
```

Tests compare the running backend against checked-in expectations. They never update them. `npm run compatibility:freeze` is an explicit regeneration command for deliberate contract changes; review its JSON and database changes before accepting them. A Java harness should consume the same frozen requests, response JSON, parser outputs, SQLite files, cache blobs, and schema/row dumps. Run each backend on its own copy of a fixture database.

## Frozen files

`tests/fixtures/backend-compatibility/` contains:

| File | Purpose |
| --- | --- |
| `routes.json` | Every explicit method/path registered in app.ts, coverage.ts, and graph.ts. The inventory test detects additions/removals. |
| `http.json` | Ordered replay scenarios including request bodies, status codes, error text, response bodies, content type, cache headers, and bootstrap cookie requirements. |
| `schemas.json` | Input JSON Schema exported from the actual Zod contracts, including defaults, bounds, and unions. Cross-field business validation remains in HTTP scenarios and existing tests. |
| `parsers.json` | TS import forms, alias/relative resolution, Java nested/generic extraction, and function coordinate/complexity outputs. |
| `storage.json` | Exact table DDL, user_version, ordered rows including rowid, and encoded JSON strings for each database version. |
| `databases/v1`, `v2`, `v3` | Real SQLite databases with matching hash-addressed cache files. Files use rollback-journal mode for portable copying; Store enables WAL on open. |
| `manifest.json` | SHA-256 for every frozen JSON/database/cache file and the baseline commit. Tests verify every listed file. |

HTTP replay replaces the temporary repository root with `<repository>`, ISO values in `*At` properties with `<timestamp>`, and generated UUIDs with stable encounter-order placeholders. Equality of repeated UUIDs remains checked. IDs derived from content, fingerprints, revision/blob identities, omitted fields, nulls, numeric values, source text, and error messages remain intact. The common request context is same-origin loopback access; after `bootstrap`, requests use its cookie. Explicit headers in a case override that context. Host validation uses raw HTTP requests because fetch does not reliably override Host.

Cookie values and expiry dates are intentionally nondeterministic. The fixture records HttpOnly, Strict SameSite, path, name, and max age. The test derives cookie flags from actual headers. It does not freeze Date, Content-Length, ETag, or transport chunking. Source coordinates are one-based lines and existing column conventions.

Every route receives an unauthenticated request. Positive/rejection scenarios additionally cover bootstrap/reuse, host/origin checks, saved/current/historical reviews, missing sessions/snapshots, four Git comparison modes, refresh, stale updates, grouping, progress, draft creation/deletion, provider configuration restrictions, manifests/authorization, coverage/provenance, explicit test configuration, test confirmation rejection, capped graph scans, source retrieval, and restart recovery. Real external editor launches, real test commands, OS credential prompts, and model calls remain in the existing adapter/browser tests rather than being executed by the capture command. GET editor presets is inventoried and authorization-tested; platform-dependent preset discovery is covered by editor tests.

## Storage contract

| Version | Tables added | Compatibility requirements |
| --- | --- | --- |
| 1 | sessions, snapshots, settings | Assigned text IDs; sessions reference an active snapshot; snapshots reference sessions with ON DELETE CASCADE. Snapshot/state/config values are JSON TEXT. |
| 2 | coverage_reports, test_runs | Coverage key is snapshot_id + format. Test runs have assigned text IDs. Both reference snapshots with ON DELETE CASCADE. Coverage/report provenance and runs retain JSON text and artifact hashes. |
| 3 | graphs | Key is snapshot_id + side. Graph/source/run references persist separately, including partial results and running state. |

Version 1 retains settings, two snapshots, progress, a Unicode draft, text/renamed/deleted/metadata-only files, and cache. Version 2 adds coverage and a running test; version 3 adds a partial graph and running scan. Earlier versions cannot contain tables introduced later. Extra unreferenced cache files are harmless and intentionally retained in all three exports.

The test checks exported DDL/rows before migration, then opens the copied database through Store and checks version 3, foreign-key/integrity checks, original file content, history order, progress, drafts, settings, measured coverage, recovery of running jobs, and backup creation. SaveState updates session timestamps. History and latest test selection use rowid descending; JPA must preserve those ordering semantics. Snapshot file source/diff text is stored as hash references and expanded on read; returned snapshots currently also retain patchHash. Do not silently remove that field during migration.

Store enables `foreign_keys=ON`, `journal_mode=WAL`, and `busy_timeout=5000`. Versions newer than 3 are rejected. Migration 1->2 and 2->3 use consistent `VACUUM INTO` backups of the entry database version. A fresh database builds all tables. Existing tests cover unsupported schema rejection, missing/corrupt artifacts, pinned Git sources, cancellation, and additional recovery cases.

## Credentials and launcher inventory

OS keyring service is `LeanReview`. Account is SHA-256 of JSON.stringify(provider configuration), using the existing field order. SQLite stores the `provider` configuration and `credential-mode:<config-hash>` value of `os` or `session`. Coverage configuration key is `coverage-test:<sha256(repository-root)>:<format>`. Platform path spelling and provider JSON serialization therefore affect existing key lookup. Java must prove compatible lookup or explicitly request credential re-entry; no token export is part of these fixtures.

CredentialVault uses Windows Credential Manager, macOS Keychain, and explicitly Linux Secret Service through @napi-rs/keyring. Persistent-store failure requires explicit session-only selection. Tokens stay in the OS store or backend memory and are never returned by GET provider.

`npm run dev` runs Vite and the backend with frontend origin `http://127.0.0.1:5173`. Production serves built React assets from frontend/dist on loopback port 4318. The backend enforces Node major 24. It opens a browser with a single-use bootstrap fragment, or prints that link when LEANREVIEW_NO_OPEN=1. Bootstrap lasts five minutes; the per-launch cookie lasts twelve hours. The port remains 4318 even if LEANREVIEW_ORIGIN changes. SIGINT/SIGTERM abort owned jobs and close the store/server.

LEANREVIEW_DATA_DIR overrides the data directory. Defaults are LOCALAPPDATA/LeanReview on Windows, ~/Library/Application Support/LeanReview on macOS, and XDG_DATA_HOME/LeanReview or ~/.local/share/LeanReview on Linux. The directory contains leanreview.sqlite and cache/. Keep this layout and local-access protection through migration.

## Performance measurements

`npm run benchmark:backend` generates 1,000-file TS, Java, and mixed Git repositories with deterministic content and eight functions/methods per source file. It runs three fresh backend processes per dataset, each with an empty-cache scan followed by a reused-cache scan. GraphService runs with the same storage/cache work as the application. The benchmark rejects incomplete scans and parser failures.

The default report is `docs/migration/backend-baseline.json`. It includes environment details, commit, dirty-worktree paths, SHA-256 for every backend/contract input and the lockfile/benchmark script, dataset content hashes/Git identities, raw runs, capture time, cold/warm scan times, startup, process peak RSS, and authenticated API latency during scans. Startup includes Node/tsx imports and Store/createApp initialization up to HTTP listening; it excludes opening a browser and serving production assets. Capture time is measured separately before scanning.

Cold means an empty application cache in a fresh process. OS caches are not flushed. Warm is the second scan using persisted source artifacts, not simply returning an existing graph. High-water RSS includes the whole worker lifetime and excludes Git child processes. API latency samples use GET /api/provider with sequential requests separated by 10ms; scan elapsed includes 10ms completion polling and the last sample. Peak RSS on the warm pass is cumulative, not an independent allocation measurement. Fixed 120-second scan and five-minute worker limits prevent runaway benchmark runs.

Override dataset size/repeats with LEANREVIEW_BASELINE_FILES and LEANREVIEW_BASELINE_REPEATS, and the report path with LEANREVIEW_BASELINE_OUTPUT. Use the same size, generator version, content hash, scan limits, Node/build mode, machine, and background workload when comparing Java. Run benchmarks alone, after verification, to reduce test/build interference. Results describe synthetic workload shapes on this machine; production repositories, cross-platform performance, model latency, and numeric release budgets require separate evidence.
