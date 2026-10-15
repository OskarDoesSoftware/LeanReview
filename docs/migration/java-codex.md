# Codex subscription analysis in Java

Issue [#36](https://github.com/OskarDoesSoftware/LeanReview/issues/36) ports the Codex app-server adapter to Spring. Java is now the default backend after platform/performance acceptance and cutover. This document records the adapter verification performed during that migration.

## Credentials and input

Select Codex in AI provider settings, sign in with ChatGPT, choose an advertised model, and save. The Java routes support status, login, cancel-login, and logout under the existing local browser authentication and origin checks. LeanReview returns public account metadata, model choices, and reported allowance. Missing usage stays unavailable rather than becoming zero usage.

The installed Codex CLI owns credentials under the application's isolated `codex` profile. Java does not read, export, or copy authentication files into SQLite, source caches, logs, or API responses. Subscription mode rejects API keys and never falls back to API billing. Signing out affects this profile.

Java discovers an installed native executable or the installed npm CLI entry point. `LEANREVIEW_CODEX_PATH` can select an executable. Missing CLI installations produce an actionable error; the application never downloads one. The startup-only `leanreview.codex.command` JSON array supports controlled launcher and synthetic test integration. Do not expose it as a browser setting.

Each analysis requires the existing manifest authorization. Only its bounded batch is sent. The app-server starts in an empty directory with an explicit read-only permission profile, disabled network access and tools, no approvals, ephemeral threads, and disabled history persistence. Java verifies the selected permission profile and provider before starting a turn. These controls constrain the model's tools; the CLI still needs its own service connection for inference.

## Protocol and shutdown

The adapter follows the [Codex app-server protocol](https://developers.openai.com/codex/app-server). It checks subscription allowance before each batch, validates the model catalog, requires structured output for every supplied file ID, and rejects unexpected tool execution. Account operations cannot race an active analysis.

Protocol frames are limited to 4 MiB, agent output to 2 MiB, pending requests to 128, ordinary requests to 30 seconds, initialization to 35 seconds, and each turn to 180 seconds. Requests use a bounded asynchronous writer so blocked stdin cannot bypass the deadline. Upstream stderr is drained and discarded. Upstream errors become fixed application messages without credential details.

Cancellation, timeouts, and application shutdown terminate only the owned app-server and its descendants. Process cleanup waits for their exit within a shared deadline. Snapshot and configuration checks prevent obsolete proposals from replacing current work; progress updates preserve accepted grouping, review marks, drafts, and unknown human state.

## Verification and remaining acceptance

Synthetic Java tests cover schema parity with Node for 1, 2, and 49 files, account lifecycle, allowance and model failures, protocol limits, tool rejection, cancellation, reconnection, subprocess cleanup, protected HTTP routes, stale jobs, and secret exclusion from application storage. The React browser acceptance uses a local synthetic app-server and covers canceled and completed sign-in, provider configuration, explicit input authorization, automatic grouping, retained progress, and logout.

These checks do not establish live subscription entitlement, model quality, or macOS/Linux sandbox compatibility. Live account and platform acceptance remains required before the default backend cutover in #27 and #28. Tests never perform a real account login or inference.

Verified on Windows on 2026-10-15 from an isolated copy of the staged sources: Maven `verify` passed 80 tests with one existing symlink-permission skip; 31 Node Codex/progress tests and seven frozen compatibility checks passed; frontend typecheck/build and four frontend browser checks passed. The packaged-Java React acceptance passed in 46 seconds, including the synthetic Codex account flow and automatic grouping. Native Git compatibility used a 120-second test deadline on this host.
