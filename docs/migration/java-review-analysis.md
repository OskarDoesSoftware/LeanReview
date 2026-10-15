# Java credentials and review analysis

Implementation for [Port credentials and review analysis](https://github.com/OskarDoesSoftware/LeanReview/issues/25), following the existing Node contracts and [migration map](https://github.com/OskarDoesSoftware/LeanReview/issues/21).

## Provider and input behavior

The Java API implements provider configuration, manifest preview, explicit analysis authorization, cancellation, and proposal generation. Ollama uses `/api/chat`, OpenAI uses `/responses`, and Anthropic uses `/messages`, retaining the existing structured-output envelopes, system instructions, model/context/output limits, and response-completion checks. The output schema is derived from the frozen shared contract; cohort/layer/file coverage and finding coordinates use the same validation as manual grouping.

Manifest IDs and credential account keys retain the Node JSON field order and SHA-256 identities. The frozen Node manifest compares exactly. Generated/vendor files, files without text diffs, per-file/total context limits, model-budget omissions, conservative UTF-8 byte estimates, and ordered batches capped at 20 files retain their existing behavior. Batch results are validated against their own file subset before the combined result is validated against the whole snapshot.

Every network request follows explicit authorization of the current manifest. Provider endpoint validation rejects embedded credentials, query/fragment secrets, and remote cleartext HTTP. Local-only mode requires loopback Ollama and rejects cloud-tagged models. Redirects are refused. HTTP responses are capped at 8 MiB, extracted structured output at 2 MiB characters, and requests at two minutes or five minutes for local-only Ollama. Errors never echo raw provider bodies or arbitrary exception text.

## Lifecycle and persistence

One application-wide analysis slot is reserved before reading credentials and remains occupied until canceled work settles. Network and OS credential operations run outside database transactions. Snapshot and provider configuration are checked after credential lookup and between batches. Snapshot checks query the current identifier without reopening every captured artifact. The worker publishes only a validated proposal. Following the user's updated review flow, the frontend applies it automatically to the current snapshot's grouping after analysis authorization.

State changes read the latest persisted JSON within their transaction, preserving progress, draft comments, accepted grouping, and unknown fields. Failure/cancellation updates the job's own snapshot even after refresh. Refresh cancels the old analysis, retains immutable history, and leaves the new snapshot idle. Provider configuration changes cancel active work. Shutdown cancels owned work and waits with a bound; startup recovery marks crash-interrupted runs as interrupted without resuming them.

The worker uses a single bounded executor. HTTP cancellation cancels the underlying async request, including a request waiting for its body. A late provider result cannot publish after cancellation or refresh. Arbitrary exception messages are replaced with a fixed error before persistence, so they cannot carry source or tokens into the database or UI.

## Credential binding

The application service is `LeanReview`; the account is the existing configuration hash. Session-only keys remain in memory. SQLite stores only provider configuration and `credential-mode:<hash>`, never a token. Persistent-store failure requires explicit session-only selection.

Windows uses the [native Credential Manager API](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw) through pinned JNA 5.18.1. The existing Node binding names its generic credential `<account>.LeanReview` and encodes its password as UTF-16LE. The Java implementation retains that identity, encoding, and enterprise persistence setting. A test creates a synthetic temporary credential with installed `@napi-rs/keyring` 2.1.1, reads it with Java, writes it with Java, verifies it with Node, reopens it with a new Java store instance, and removes it. No user credential is enumerated or exported.

macOS and Linux use pinned [java-keyring 1.0.4](https://github.com/javakeyring/java-keyring), selecting Keychain or Secret Service explicitly. There is no KWallet, file-store, or session fallback. Native interoperability on those platforms has not been exercised on this Windows host. If lookup is unavailable or legacy entry naming differs, the existing API-key-unavailable path requires key re-entry. Cross-platform runtime and credential tests remain in #27.

## Verification

Verified on Windows x64 on 2026-10-15 with the pinned JDK/Maven stack: full Maven `verify` succeeds with 45 cases, 44 passed and one skipped for unavailable Windows symlink-creation permission. The skip is the existing #24 platform case. The 16 added cases cover credential storage, input preparation, provider settings/transports, and analysis lifecycle. The packaged-Java React authorization/analysis/acceptance flow passes; frontend typecheck and production build pass. No live model account was used.

Tests use local HTTP fixture providers and synthetic temporary secrets, never live model accounts. They cover the three request/response adapters, refusal/truncation, malformed and oversized output, redirect rejection, actual in-flight HTTP cancellation, manifest/configuration hashes, omissions and batch sizes, pending credential reservations, stale snapshots/configuration, late results, preserved human edits, and token absence from the stopped database/cache.

The React browser fixture configures Java's Ollama adapter against a local HTTP fixture, authorizes its manifest, accepts the proposal, preserves progress/comments, edits grouping, refreshes, and reopens history. Existing frozen HTTP cases additionally check provider restrictions, authorization, stale manifests, and idle cancellation.

Run `mvnw.cmd verify` under JDK 25 in `backend-java`, then `npm run typecheck`, `npm run build`, and `npx playwright test --config playwright.java.config.ts` at the repository root. The default launcher still uses Node.

## Remaining migration scope

Live model quality is separate from adapter parity. Windows is the tested runtime; macOS/Linux acceptance, graph/coverage/test execution, launch packaging, performance budgets, and final cutover remain later migration work. The Node Codex subscription mode shipped in #34 after the frozen baseline and is outside #25's Ollama/OpenAI/Anthropic scope. Its Java port is tracked in [#36](https://github.com/OskarDoesSoftware/LeanReview/issues/36), linked to the migration map and blocking #27 final platform acceptance. The Java port is now implemented; see [Java Codex analysis](java-codex.md) for verification and remaining live acceptance. No API-key substitution or silent provider fallback is introduced.
