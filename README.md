# LeanReview

A local-first human code review workspace focused on AI-assisted cohorts, ordered reading layers, Monaco diffs, and SQLite-backed review progress. The interface has a scrolling cohort/file sidebar, a diff, and one AI review guide, with a neutral theme that follows system appearance.

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
3. Configure Codex with your ChatGPT subscription, Ollama, OpenAI API, or Anthropic API in Settings → AI. For Codex, select **Codex · ChatGPT subscription**, click **Sign in with ChatGPT**, finish the browser login, choose a model, and save. This requires the Codex CLI and uses your account's Codex allowance. See [subscription setup](docs/codex-subscription.md). For other providers, choose a compatible model and its context/output limits. For offline Ollama use an already installed local model and disable Ollama cloud features. A localhost URL alone does not establish offline inference.
4. Preview and authorize the analysis manifest. Filenames and metadata for code-omitted files remain included and are shown in the manifest. No provider fallback or silent model download occurs.
5. Inspect the proposed cohorts/layers and explicitly accept them. Rename cohorts, move files, and reorder layers as needed. AI findings are suggestions, not verified static results.
6. Review split/unified diffs, follow findings with **Go to finding**, and mark files/layers reviewed.
   Marking a file reviewed advances to the next unreviewed file in the accepted reading order. Undoing reviewed status keeps your current file selected.
   Clicking a code line offers an external-editor action. Configure the default under Settings → Editor, or choose one when prompted on first use. Presets cover VS Code, IntelliJ IDEA and terminal-launched Neovim, with configurable executable/argument templates. Working files must match the snapshot before opening line coordinates; historical before-side selection opens the current file at its start rather than pretending old coordinates are current. No in-app source editing is enabled.
7. Reopen sessions using Saved reviews. Refresh creates a new snapshot, preserves history, and carries forward only unchanged-file progress. Previous snapshots are read-only, with a direct button back to the current snapshot.

Analysis reports its current phase, validated batches/files, and the current batch's filenames. Elapsed time uses the backend's run timestamp and survives page reload. A wait estimate appears after the first checked batch, using average completed-batch time for the remaining batches. The UI shows a range, acknowledges overruns, and never invents token-level completion percentages. Model latency and batch sizes vary.

API keys are stored through the OS credential manager or explicitly in backend session memory. Stored keys are never returned to the frontend. Linux uses Secret Service explicitly, with no automatic kernel-keyring fallback. Session-only keys require re-entry after restart.

Codex manages subscription credentials in a separate profile under the LeanReview data directory's `codex/` folder, preferring its OS credential store and falling back to its credential file when needed. Subscription credentials never enter LeanReview's database or frontend. Signing out in LeanReview affects this profile only. Usage is shared with your other Codex sessions; LeanReview checks allowance before each batch and never switches to API billing.

SQLite lives in the OS user's application-data directory, with hashed source/diff blobs in a separate cache. On Windows the default is `%LOCALAPPDATA%/LeanReview`; macOS uses `~/Library/Application Support/LeanReview`; Linux uses `$XDG_DATA_HOME/LeanReview` or `~/.local/share/LeanReview`. These files include private code. Tokens do not belong in these stores. Set `LEANREVIEW_DATA_DIR` for a separate data directory, and `LEANREVIEW_NO_OPEN=1` to display the startup link instead of opening a browser. Do not share the one-time link.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm exec -- playwright install chromium
npm run test:browser
```

Integration tests create isolated fixture repositories/databases under ignored `.leanreview-test/`. Browser verification runs the built UI with a **fixture LLM response server**, not real inference. It exercises actual Git capture, AI input authorization/result validation, Monaco, cohort editing, progress, reload, explicit proposal acceptance, refresh, and read-only history. It does not establish model grouping quality or cloud API account access.

The Java backend migration uses [frozen compatibility fixtures and baseline measurements](docs/migration/backend-compatibility.md). Run `npm run test:compatibility` to verify the current backend and `npm run benchmark:backend` to reproduce the synthetic performance baseline.

The [Java persistence foundation](backend-java/README.md) now validates the existing SQLite databases through Spring Data JPA. Its README records the pinned toolchain, isolated test command, migration behavior, and recovery limits. The default launcher remains the Node backend until the later migration acceptance gates pass.

## Deferred features

The graph viewer, CRAP/coverage meter, and comment controls are removed from the current interface so development can focus on cohorts and AI-assisted review. Existing stored data and backend APIs remain intact. Their previous documentation remains in [coverage](docs/coverage.md) and [module graphs](docs/module-graphs.md); those documents describe parked functionality rather than current UI entry points. The graph browser fixture is retained under `tests/parked-browser/`, outside the active browser suite.

## Current scope

This is the **core Phase 1 vertical slice**, not the completed Phase 1 contract or MVP. It supports local comparisons and human review progress, three foreground LLM HTTP adapters plus a Codex subscription adapter, bounded sequential batches, explicit proposal acceptance, immediate SQLite progress, immutable source caching, refresh/history, and protected loopback access.

Remaining Phase 1 work includes richer related-file context/dependency evidence and cross-batch semantic reconciliation, transient retry policy, full backup/restore and cache deletion, and broad quality/platform acceptance. Snapshot capture currently rejects unsupported/conflicted/submodule changes rather than silently showing a complete result. Content over 2 MiB or non-UTF-8/binary/symlink files is metadata-only. Byte-based token estimates are deliberately conservative, not exact token counts.

GitHub and Azure DevOps repository/PR adapters and tested publication are later phases. Remote publishing and PR verdicts are not wired into this slice. Live Ollama/cloud model quality and macOS/Linux acceptance still need verification. The MVP requires all three sources and the remaining features in the [approved contract](https://github.com/OskarDoesSoftware/LeanReview/issues/10).

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

## UI components

Owned shadcn/ui source lives in `frontend/src/components/ui`. Registry configuration is in `components.json`; the `@/` alias resolves to `frontend/src`. Use these components for forms, badges, cards, tabs, and dialogs. `ReviewDialog` adds the shared scrollable layout and restores focus to the opening control. Native selects preserve platform keyboard behavior.

## License

LeanReview is licensed under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full terms. Third-party dependencies retain their own licenses.

Accepted cohorts show why their files belong together, the purpose of each reading layer, and a Start/Continue review action for the first unreviewed file in the suggested order. Snapshot refresh keeps surviving file assignments and places new files under "New files to organize". Carried grouping is labelled for reconsideration, and AI findings carry forward only for unchanged files. Generate a new proposal when the changes need regrouping.

The Java preview now has root-level `build:java`, `start:java`, and `dev:java` commands, paired backup/restore tooling, and a platform acceptance workflow. See [Java launch and acceptance](docs/migration/java-launch-acceptance.md). The Java repository picker supports the [GitHub PR review workflow](docs/github-review.md). Java remains opt-in until platform and live-provider acceptance is complete.
