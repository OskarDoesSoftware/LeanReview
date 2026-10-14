# LeanReview

A local-first human code review workspace. The initial vertical slice connects local Git snapshots to AI cohort/layer proposals, Monaco diffs, local comments, and SQLite-backed progress. It implements the selected cohort-sidebar layout with React, Tailwind, and an owned shadcn/ui-style Button component using Radix Slot and CVA.

## Run

Install Node **24.21.0** (see `.nvmrc`) and Git, then:

```sh
npm ci
npm run dev
```

One command starts the Vite UI and Express backend and opens the browser with a single-use authorization link. The UI is at `http://127.0.0.1:5173`; opening that address in a fresh browser without the startup link does not authorize access. Restart the application for a new link. Reloading an authorized browser retains its per-launch session.

For built startup:

```sh
npm run build
npm start
```

The built application serves the UI at `http://127.0.0.1:4318`. Monaco and its workers are bundled locally; there is no editor CDN dependency. `npm` scripts use the pinned workspace Node executable when installed. Installation itself should use Node 24 to avoid engine warnings. Native SQLite/keyring dependencies must install successfully on your platform.

If machine-wide npm registry configuration is incompatible with public dependencies, supply your own isolated npm configuration or use `--registry=https://registry.npmjs.org`. LeanReview does not modify global npm credentials.

## Review flow

1. Enter the absolute root of a local Git repository and choose all uncommitted, unstaged/untracked, staged, or merge-base branch comparison.
2. Open the review to capture a fixed snapshot. Ungrouped diff inspection works without AI.
3. Configure Ollama, OpenAI API, or Anthropic API in AI settings. Choose a compatible model and its context/output limits. For offline Ollama use an already installed local model and disable Ollama cloud features. A localhost URL alone does not establish offline inference.
4. Preview and authorize the analysis manifest. Filenames and metadata for code-omitted files remain included and are shown in the manifest. No provider fallback or silent model download occurs.
5. Inspect the proposed cohorts/layers and explicitly accept them. Rename cohorts, move files, and reorder layers as needed. AI findings are suggestions, not verified static results.
6. Review split/unified diffs, mark files/layers reviewed, and click a gutter line number to save a local draft comment.
7. Reopen sessions using Saved reviews. Refresh creates a new snapshot and preserves history, carries forward only unchanged-file progress, and flags changed-file drafts for reattachment. Previous snapshots are read-only in the UI.

API keys are stored through the OS credential manager or explicitly in backend session memory. Stored keys are never returned to the frontend. Linux uses Secret Service explicitly, with no automatic kernel-keyring fallback. Session-only keys require re-entry after restart.

SQLite lives in the OS user's application-data directory, with hashed source/diff blobs in a separate cache. On Windows the default is `%LOCALAPPDATA%/LeanReview`; macOS uses `~/Library/Application Support/LeanReview`; Linux uses `$XDG_DATA_HOME/LeanReview` or `~/.local/share/LeanReview`. These files include private code. Tokens do not belong in these stores. Set `LEANREVIEW_DATA_DIR` for a separate data directory, and `LEANREVIEW_NO_OPEN=1` to display the startup link instead of opening a browser. Do not share the one-time link.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm exec -- playwright install chromium
npm run test:browser
```

Integration tests create isolated fixture repositories/databases under ignored `.leanreview-test/`. Browser verification runs the built UI with a **fixture LLM response server**, not real inference. It exercises actual Git capture, AI input authorization/result validation, Monaco, draft comments, progress, reload, explicit proposal acceptance, refresh, and read-only history. It does not establish model grouping quality or cloud API account access.

## Current scope

This is the **core Phase 1 vertical slice**, not the completed Phase 1 contract or MVP. It supports local comparisons and local drafts, three foreground LLM HTTP adapters, bounded sequential batches, explicit proposal acceptance, immediate SQLite progress, immutable source caching, refresh/history, and protected loopback access.

Remaining Phase 1 work includes measured CRAP with aligned report imports/explicit test collection, TS/JS and Java module graphs, richer related-file context/dependency evidence and cross-batch semantic reconciliation, transient retry policy, draft editing/reattachment UX, full backup/restore and cache deletion, and broad quality/platform acceptance. Snapshot capture currently rejects unsupported/conflicted/submodule changes rather than silently showing a complete result. Content over 2 MiB or non-UTF-8/binary/symlink files is metadata-only. Byte-based token estimates are deliberately conservative, not exact token counts.

GitHub and Azure DevOps repository/PR adapters and tested publication are later phases. No remote publishing, PR verdicts, test execution, coverage collection, or graph extraction is wired into this slice. Live Ollama/cloud model quality and macOS/Linux acceptance still need verification. The MVP requires all three sources and the remaining features in the [approved contract](https://github.com/OskarDoesSoftware/LeanReview/issues/10).

## Structure

- `backend/src/api`: protected Express routes and per-launch session handshake.
- `backend/src/git`: argument-based Git capture and selected-root containment.
- `backend/src/review`: analysis manifests and semantic validation.
- `backend/src/llm`: Ollama/OpenAI/Anthropic structured-result adapters.
- `backend/src/credentials`: OS/session credential storage.
- `backend/src/storage`: SQLite migration, progress/state and content cache.
- `frontend/src`: selected review workspace and local Monaco lifecycle.
- `packages/contracts`: shared normalized types and Zod schemas.

The canonical [decision map](https://github.com/OskarDoesSoftware/LeanReview/issues/1) contains the implementation-ready product contracts. Planning completion is separate from implementation acceptance.
