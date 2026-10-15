# Review analysis with a ChatGPT subscription

LeanReview can run review analysis through a local Codex app-server signed in with ChatGPT. The existing OpenAI provider uses API-key billing; choose **Codex · ChatGPT subscription** to use your account's Codex allowance.

## Connect

1. Install the [Codex CLI](https://learn.chatgpt.com/docs/cli) if it is not already available. For an npm installation, run `npm install -g @openai/codex`.
2. Restart LeanReview so it sees the updated executable search path. If needed, set `LEANREVIEW_CODEX_PATH` to the absolute path of the native Codex executable. The adapter also recognizes npm's standard Windows installation without executing its command shim in a shell.
3. Open **Settings → AI**, select **Codex · ChatGPT subscription**, and click **Sign in with ChatGPT**. Complete login in the browser. If the browser blocks the new tab, use **Continue sign-in in your browser**.
4. Wait for the connected account and model list, or click **Refresh connection and usage**. Pick a model and save the configuration. Context window and output reservation control LeanReview's conservative input batching; they do not establish the model's advertised limits.
5. Open a review and authorize its analysis manifest. Login and usage checks do not send a review snapshot. As with other providers, proposals require explicit acceptance.

The connection panel displays the account, plan, available model catalog, and quota windows when supplied by Codex. A model appearing in the catalog does not guarantee access until inference succeeds. Missing usage data is shown as unavailable, rather than zero consumption. **Cancel sign-in** cancels the pending browser flow. **Sign out of LeanReview** signs out this app's profile.

## Credentials and execution

LeanReview starts Codex with an isolated `CODEX_HOME` at `<LeanReview data directory>/codex`, using a separate empty working directory rather than the reviewed repository. It does not copy or reuse credentials from `~/.codex`. Codex owns token renewal and credential storage using `cli_auth_credentials_store="auto"`, preferring the OS credential store and falling back to its `auth.json` file. Treat this folder as private credentials and exclude it from shared backups. Credentials are never saved in LeanReview's SQLite settings or returned to the frontend.

The child process has inherited OpenAI API keys and Codex access tokens removed, forces ChatGPT login, and uses the OpenAI provider. Review threads are ephemeral, with shell, browser, image, connector, and multi-agent features disabled. A named `leanreview_analysis` permission profile grants read access only to the empty working directory and disables command networking. LeanReview verifies the active profile before starting a turn. On Windows, the adapter selects MXC because the legacy restricted-token sandbox cannot enforce these file-read limits. A compatible Codex/Windows installation is required; the adapter does not fall back to unrestricted file access. Only the authorized batch is provided as input. Unexpected tool operations stop analysis. JSON results pass the same shape, file-ID, and line-coordinate validation as the other providers.

Canceling analysis terminates its Codex connection. A failed connection can restart on the next request. Shutting down LeanReview closes the connection. Existing accepted groups and review progress survive failed, canceled, or incomplete results.

Codex returns a required `fileAssignments` entry for each supplied file ID, choosing its cohort, layer, explanation, and reading-order rank. LeanReview builds the groups from those assignments. This prevents the model from assigning the same file to multiple layers or inventing IDs in grouping arrays. The schema restricts finding references to the supplied IDs as well; existing line-coordinate and full-snapshot validation still applies. Equal reading-order ranks use stable input order.

## Allowance and failures

Allowance is shared with other Codex sessions on the account. LeanReview checks before every batch and stops for reported exhaustion or blocked included usage. Unverifiable usage blocks inference until a successful refresh. Reset times are informational; the app checks fresh server state before retrying. A request that fails because another session consumed the allowance remains a failed proposal, without changing accepted review work.

There is no automatic switch to API billing, another model, or another provider, and LeanReview does not purchase or redeem credits. Account-level Codex billing and credit policies still apply within Codex itself. LeanReview does not replace those policies.

Both the default Node backend and the opt-in Java backend support this adapter. The original migration compatibility fixtures remain frozen. See [Java Codex analysis](migration/java-codex.md) for Java verification and the live platform acceptance still required before switching runtimes.

## Verification

Protocol fixtures cover login completion/cancellation/logout, isolated credentials, model pagination, quota exhaustion, unsupported account types, process failure, invalid JSON, cancellation, unexpected tools, and the absence of HTTP fallback. API tests cover session protection, manifest authorization, key-free review execution, and preservation of accepted reviews after quota failures. Browser tests cover settings, login links, usage display, and configuration saving.

The installed `codex-cli 0.162.0-alpha.17.2` was tested with a fresh unsigned-in profile and then with the user's signed-in subscription using a tiny synthetic diff. The live synthetic request returned valid structured analysis. This verifies protocol compatibility and subscription inference on this Windows installation, rather than review quality for a real repository. Regression fixtures explicitly reject the obsolete `sandboxPolicy.readOnly.access` request shape that the installed runtime no longer supports, even though it still appears in its generated stable schema.

Protocol and authentication follow the official [app-server documentation](https://learn.chatgpt.com/docs/app-server), [authentication documentation](https://learn.chatgpt.com/docs/auth), and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
