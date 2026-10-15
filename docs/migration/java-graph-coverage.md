# Java graphs, coverage, and explicit tests

Implementation for [Port graph, coverage, and explicit test execution](https://github.com/OskarDoesSoftware/LeanReview/issues/26), under the [Java migration](https://github.com/OskarDoesSoftware/LeanReview/issues/21).

Java owns the graph and coverage HTTP routes, jobs, SQLite rows, captured artifacts, Git inventory reads, cycle detection, JaCoCo XML parsing, Istanbul mapping, CRAP calculation, and approved test execution. These services release the database connection before parsing or running processes. Existing schema versions and artifact hashes are retained.

## Parser boundary

Run `npm run build:analysis-helper` from the repository root before Java verification or startup. The helper is built from `backend-java/helper/index.ts`; generated output is ignored. Node 24 and the installed, pinned parser dependencies are required. Java defaults to `node` and `helper/dist/index.js` relative to the Java working directory. Set `--leanreview.analysis.node` and `--leanreview.analysis.helper` to absolute paths when launching elsewhere. Runtime distribution belongs to #27.

Each owned helper process accepts one JSON request on stdin, then closes. Requests and replies contain `version: 1` and a unique request ID. Stdout contains only the protocol reply. The Java boundary rejects mismatched IDs, trailing JSON, failed processes, excessive output, and requests exceeding 256 MiB. Stderr is capped at 64 KiB and never returned to the browser. At most two parser processes run at once, with a bounded wait for a slot. Requests time out after two minutes; cancellation and shutdown kill the helper and its descendants, including parsers started by ordinary coverage reads. Provider credentials, Node preload options, and repository Git overrides are removed from its environment.

The helper receives captured text, virtual source names, configuration text, and a source inventory. TypeScript 6.0.3 module resolution uses a virtual filesystem. It cannot read repository files through its compiler host. Source extraction and complexity are batched to avoid starting a process for each source file.

Java extraction temporarily remains in this helper using the existing web-tree-sitter 0.20.8 runtime and tree-sitter-wasms 0.1.13 Java 0.20.2 grammar. This is the transitional option explicitly allowed by #21. The frozen declaration/reference fixture gates the binding and grammar at verification time. A JVM parser replacement must pass the same fixtures before replacing this boundary. No compiler, classpath inspection, generated-code completeness, or richer Java semantics are claimed.

## Pinned graphs

Both snapshot sides use captured blob inventories and captured changed-file overlays. A single bounded Git `cat-file --batch-command` stream supplies unmodified blobs. Reads validate object IDs, regular-file modes, the 2 MiB per-file cap, binary content, and UTF-8. A changed working tree is never a fallback for unavailable pinned sources.

Graph limits, unresolved/external distinctions, source coordinates, evidence IDs, package/class nodes, cycle ordering, configuration warnings, omissions, and completeness retain the Node contract. Graphs and source text are content-addressed before references are saved. Reruns reuse saved source artifacts. One graph slot remains occupied until its worker finishes; progress is throttled, cancellation stops owned processes, and failures preserve the previous graph. Status-only polling does not reopen graph artifacts. Historical snapshot graphs remain available.

## Coverage and test execution

Istanbul statement spans use UTF-16 source offsets and the pinned function/complexity extractor. The smallest containing function owns each statement. JaCoCo uses method complexity and instruction coverage. Invalid mappings, missing counters, ambiguous source identities, stale provenance, and missing reports retain explicit unavailable reasons. CRAP is `c²(1-q)³+c`; it is computed only for aligned sources and valid executable denominators.

JaCoCo parsing strips only the recognized standard declaration. Custom entities and internal DTDs are rejected. JAXP external DTD/schema access, entity expansion, and XInclude are disabled. Coverage import uses the existing coverage MIME type and a separate authenticated 20 MiB request limit; other mutations retain their 1 MiB limit. Saved reports and provenance can be exported through the existing artifact route.

Repository commands run only after saving a configuration, previewing it, and explicitly confirming the preview. A preview expires after five minutes, is single-use, and binds configuration, snapshot, matching checkout sources and HEAD, working directory, and prior report identity. Paths must remain in the selected repository. Shell interpretation requires the saved `shell` flag shown in the preview.

One test slot owns sequential steps and their descendants. The configured timeout covers the entire run. Logs retain at most 65,536 characters with token/password redaction; provider credentials are excluded from the subprocess environment. On success, sources are checked again and a newly generated bounded report is required. Measurements are saved before attempting the provenance sidecar export. Failure, timeout, and cancellation preserve previous coverage. Shutdown cancels owned jobs; existing restart recovery marks unfinished graph/test rows interrupted without executing them again.

## Verification

`tests/fixtures/backend-compatibility/parsers.json` remains the frozen #22 parser gate. `tests/fixtures/java-analysis.json` adds full Node-reference graph and coverage results, including partial scans, cycles, unresolved Java/TypeScript references, syntax failures, and aligned/stale Istanbul and JaCoCo reports. Regenerate only deliberately with `node --import tsx scripts/freeze-java-analysis.ts`.

Java tests replay these results, check XML entity rejection and malformed counters, exercise pinned Git reads after working-tree edits, and run explicit fixture commands to verify preview binding, result preservation, child-process cancellation, quoted shell commands, and timeout handling. Helper process tests check cancellation, request identity, and excessive diagnostics. The frozen HTTP replay includes graph startup progress, completion, captured sources, coverage import/export, configuration, cancellation, and validation errors.

The primary UI is concurrently parking graph and coverage controls. Browser acceptance leaves those edits intact: the current review flow runs through the main UI, and an isolated test harness renders the retained React components against the same authenticated Java server. The harness scans a graph, previews and confirms fixture tests, renders measured functions, and exports the report. It is built only by `tests/java-browser-server.mjs` into ignored frontend build output.

Verified on Windows x64 on 2026-10-15: the final shared-checkout Maven suite ran 53 cases, with 52 passing and one symlink-permission skip. The final millisecond-timestamp fixture replay passed after formatting was aligned with Node. Frontend typecheck/build and the packaged Java Playwright flow passed; the browser test took 25.8 seconds. Evidence logs are in ignored `.leanreview-test/migration-26-complete.log`, `migration-26-timestamps.log`, and `migration-26-browser.log`.

Cross-platform runtime distribution, macOS/Linux process acceptance, large-repository performance acceptance, and default-backend cutover remain in #27/#28. This change makes no performance improvement claim. Codex subscription parity is tracked separately in #36.
