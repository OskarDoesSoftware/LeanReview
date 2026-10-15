# LLM structured output, privacy, and offline operation

Research for [issue 4](https://github.com/OskarDoesSoftware/LeanReview/issues/4), checked 2026-10-14. This records provider facts and engineering implications. It does not choose the user's privacy policy, supported model list, or resource limits.

## Findings

All three providers have schema-based output mechanisms, but they use different request fields and support different schema subsets. Valid JSON does not establish that a proposed cohort is sensible or that a dependency exists. LeanReview must validate those facts against its own snapshot.

| Provider | Structured result | Practical limits |
| --- | --- | --- |
| Ollama local API | Send a JSON Schema in `format`. The official examples validate the returned text with Pydantic or Zod. | Ollama cloud currently does not support structured outputs. Local model capability and classification quality need tests. [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs) |
| OpenAI Responses API | Use `text.format` with `type: json_schema` and strict schema settings on compatible models. JSON mode guarantees JSON rather than schema adherence. | Only a JSON Schema subset is supported. Handle refusals and incomplete responses before parsing a result. [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) |
| Anthropic Messages API | Use `output_config.format` with `type: json_schema`. Current documentation uses this field instead of the older beta `output_format`. | Numerical bounds, string lengths, recursive schemas, and several array constraints are unsupported. Refusal and `max_tokens` can break schema compliance. Schema compilation adds initial latency and has complexity limits. [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) |

Use simple, static schemas shared across providers. Keep file IDs and other private repository values in message content rather than constructing schema enums from them. Anthropic caches schemas for up to 24 hours; OpenAI classifies structured-output schemas as system data. [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

## Context budgets

OpenAI documents context limits as model-specific and including input, output, and reasoning tokens. Reserve output and reasoning capacity instead of filling the entire window with diffs. [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

Anthropic exposes token counting before generation. Token counts can include provider-added system material and can differ slightly from generation usage. Calling a cloud token-count endpoint also transmits the supplied content to that provider. [Claude token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)

Ollama lets callers set `options.num_ctx`; its FAQ currently gives 4096 as the default. Larger context and parallel requests consume more memory. Treat the running server's configuration as distinct from a model's advertised maximum. [Ollama FAQ](https://docs.ollama.com/faq)

Engineering implication: record model ID, configured context limit, reserved output limit, estimated input usage, and included snapshot files for each run. Split oversized changes into bounded batches and report omitted context. Never silently classify files whose changes were dropped. Exact token estimation for arbitrary local model tokenizers remains an implementation question.

## Cancellation and failures

OpenAI supports a server-side cancel operation for background Responses. Background mode temporarily stores response data for polling and is incompatible with Zero Data Retention. A cancellable background job therefore has a privacy consequence. [OpenAI background mode](https://developers.openai.com/api/docs/guides/background), [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

The Ollama JavaScript client's `abort()` aborts all active streamed generations on that client instance. Its documentation recommends one client per stream when independent timeouts are needed. [Ollama JavaScript client](https://raw.githubusercontent.com/ollama/ollama-js/main/README.md)

For foreground HTTP calls, cancellation should abort the local transport and discard later results. This research did not establish a general Anthropic server-side cancellation endpoint or a guarantee that dropping a cloud connection prevents further billing. Do not promise either. A user cancellation must stop queued retries and must never save a partial cohort result as successful.

Handle authentication failures, provider rate limits, local overload, timeouts, refusal, truncation, invalid schemas, and invalid semantic results separately. Retry policies should be bounded and preserve the selected provider and privacy settings. A failure must not trigger an automatic switch to another provider.

## Privacy facts

OpenAI API content is not used for training by default. Standard abuse monitoring can retain content for up to 30 days, with exceptions. Responses defaults to stored application state; use `store: false` when that storage is unwanted. This flag does not disable abuse monitoring. Zero Data Retention and Modified Abuse Monitoring require approval and have endpoint and feature exceptions. Background mode has temporary storage even with `store: false`. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

Anthropic's commercial privacy article gives deletion within 30 days with contract, feature, safety, and legal exceptions. Its newer API retention page says eligible features do not retain conversation content by default, except Covered Models, and describes per-organization ZDR arrangements. The structured-output page specifically says prompts and responses receive ZDR processing, with schema caching. These pages have different levels of specificity. LeanReview should display model- and feature-specific information and link the sources, rather than claim every Anthropic request has identical retention. Safety and legal exceptions still apply. [Commercial retention policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [API retention controls](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), [Structured-output retention](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

An application checkbox cannot create a cloud provider's contractual ZDR entitlement. Keep user-declared account controls separate from request parameters the adapter can enforce. Source-code content in prompts, summaries, filenames, schemas, diagnostic logs, and cached responses all needs consideration.

## What offline Ollama means

Ollama's default listener is `127.0.0.1:11434`. Its FAQ says local prompts are not sent to Ollama, and cloud models process remotely. `OLLAMA_NO_CLOUD=1` or `disable_ollama_cloud: true` disables cloud models and web search after restart. Models must already be available locally; model pulls need internet access, and desktop versions can download updates. [Ollama FAQ](https://docs.ollama.com/faq)

A localhost URL alone is insufficient evidence of local inference because the local Ollama server can use cloud models. For an offline claim, verify a locally installed model, cloud-disabled operation, no external tools, and an analysis run with network access blocked. Test startup and failure behavior without connectivity. A custom Ollama URL might address another machine and therefore must not inherit the local-only label.

## API credentials and subscription access

OpenAI's developer quickstart uses an API key created in the API platform. This establishes the API adapter's credential path; it does not establish that a user's ChatGPT login or subscription credential can be passed to this API. [OpenAI developer quickstart](https://developers.openai.com/api/docs/quickstart)

Claude's paid chat plans and Console/API access are separate products. Current help documentation says Max and Team can include monthly API credits, claimed through Console access. LeanReview still needs API credentials; a subscription login is not the Messages API credential. Avoid hard-coded claims that no subscription ever includes API credits. [Claude subscription and API access](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-is-claude-api-usage-billed-separately-from-my-paid-claude-plan)

Store API credentials in the OS secure store, following the project requirement. Keep only references to those entries in SQLite. Provider connection tests should omit repository code.

## Proposed pipeline checks

These are engineering recommendations, not settled policy decisions.

1. Treat repository text as untrusted input. Supply it as data and never give the analysis model tools to run repository commands, read credentials, publish comments, or fetch arbitrary URLs.
2. Construct an explicit input manifest after exclusions and context budgeting. Freeze the snapshot and selected endpoint, model, and privacy settings for the run.
3. Request cohort memberships and dependency suggestions using stable internal IDs. Require short explanations, without requesting hidden reasoning.
4. Validate schema, referenced IDs, exactly one cohort membership per changed file, no missing files, and dependency graph rules. Reject invented file IDs. Detect cycles and distinguish suggestions from confirmed dependencies.
5. Save results transactionally only after validation. Preserve the previous successful analysis if a rerun fails or is canceled.
6. Test deterministic fixtures for malformed output, valid JSON with invalid membership, duplicated or missing files, cycles, refusal, truncation, oversized input, cancellation, and privacy-preserving failure. Test selected real model versions for quality separately.

Endpoint policy, allowed custom endpoints, exclusion defaults, cloud confirmation rules, budgets, cycle handling, and minimum local model quality remain decisions for the map. Any custom endpoint needs an explicit trust classification; schema compatibility alone says nothing about retention or where computation occurs.
