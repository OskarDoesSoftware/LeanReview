# Git provider PR research

Resolves [Research GitHub and Azure DevOps PR normalization and comment coordinates](https://github.com/OskarDoesSoftware/LeanReview/issues/3). Checked official documentation on 2026-10-14. This records API facts and implementation implications, not product decisions. No authenticated provider fixtures or publishing experiments were run.

## Authentication and discovery

GitHub PATs act with the user's permissions. Fine-grained PATs restrict the resource owner, repositories, and permissions; organization approval and policies can further restrict access. Classic tokens remain relevant where fine-grained tokens have documented limitations, including some cross-organization and collaborator scenarios. Private repository support therefore means repositories accessible to the supplied token, not every repository visible in the user's browser. [GitHub PAT documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

`GET /user/repos` lists owned, collaborator, and organization-membership repositories with explicit access. It supports visibility and affiliation filters, `page`, and `per_page` up to 100. Fine-grained tokens require Metadata read. Discovery must use this authenticated endpoint rather than public-only user repository listing. [Repository API](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)

GitHub PR listing supports `state=open` and pagination up to 100 entries per page. PR metadata and changed-file listing require Pull requests read for fine-grained PATs; public reads can be unauthenticated. File listing has a documented maximum of 3,000 files despite pagination. A successful final page does not prove that an arbitrarily large PR was fully retrieved. [Pull request API](https://docs.github.com/en/rest/pulls/pulls)

Azure accepts PATs through HTTP Basic authentication with Base64 encoding of `:{PAT}`. PATs have scopes, expiration, user permissions, and organization policy constraints. The adapter must distinguish expired or revoked credentials from inaccessible repositories. [Azure PAT documentation](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops)

For organization browsing, enumerate projects accessible to the identity using Projects List and its continuation token. Repositories List supports a project route and optional project parameter; the endpoint documents no repository pagination parameters. Do not apply GitHub page conventions to it. [Projects List](https://learn.microsoft.com/en-us/rest/api/azure/devops/core/projects/list?view=azure-devops-rest-7.1), [Repositories List](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/repositories/list?view=azure-devops-rest-7.1)

Azure PR listing filters `searchCriteria.status=active`, supports `$top` and `$skip`, and truncates descriptions to 400 characters. A detail fetch is needed when full descriptions contribute to AI context. [PR listing](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests?view=azure-devops-rest-7.1)

## Immutable changes and content

GitHub PRs show a three-dot diff from the merge base to the head commit. Comparing current target and head blobs directly can show changes outside the PR. Capture target SHA, source SHA, merge-base SHA, and source repository identity, particularly for fork PRs. [GitHub comparison semantics](https://docs.github.com/en/pull-requests/reference/branches#comparing-branches-in-pull-requests)

GitHub Compare supplies change status, patches, and `previous_filename` for renames. Its paginated comparison returns changed files only on the first page, capped at 300 files. Commit diff documentation also states binary files lack `patch`, and large raw diffs can time out with 5xx. Thus Compare is useful for merge-base metadata but cannot replace PR file enumeration for large PRs. Missing patches must never mean unchanged files. [Commits API](https://docs.github.com/en/rest/commits/commits#compare-two-commits)

GitHub Contents accepts a commit SHA in `ref`, with Contents read permission. Files up to 1 MB support all endpoint features; files between 1 and 100 MB require raw or object media, with object returning empty content; files over 100 MB are unsupported. Directory listing caps at 1,000 entries. Download URLs expire. Persist immutable revision identifiers and content, not download URLs as durable references. [Contents API](https://docs.github.com/en/rest/repos/contents#get-repository-content)

Azure iterations record PR updates. Their model includes source, target, and common commit references. Capture the selected iteration and commit IDs rather than relying on moving branch names. [Iterations List](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list?view=azure-devops-rest-7.1)

Azure iteration changes compare a selected iteration to `$compareTo`; zero means the common source/target commit, rather than an earlier iteration. Default page size is 100, maximum 2,000. Follow `nextSkip` and `nextTop` until zero. Changes retain `changeTrackingId`, `originalPath`, type, and item identifiers. The documented response is changed-item metadata, not unified text hunks. Inference: an API-first adapter needs immutable before/after file content and a local text diff algorithm to build interactive hunks. [Iteration changes](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get?view=azure-devops-rest-7.1)

Azure Diffs Get separately supports commit SHAs, `$top`/`$skip`, and `diffCommonCommit`. True compares common-to-target; false compares base-to-target. Preserve returned common/base/target commits and completeness information rather than treating every comparison as equivalent. [Diffs Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/diffs/get?view=azure-devops-rest-7.1)

Azure Items Get accepts `versionDescriptor.versionType=commit` with the SHA. It offers content metadata, download, and LFS resolution options, and returns text or binary media as well as JSON. Inference: distinguish text, binary, LFS pointers, missing content, and permission failures before constructing hunks. Deleted files need old-path content at the comparison revision; additions have no old-side blob. [Items Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/items/get?view=azure-devops-rest-7.1)

## Publishing coordinates

GitHub review comments require a commit SHA and path. `line` is a blob line, `LEFT` targets deletions, and `RIGHT` targets additions or context. Multiline comments add `start_line` and `start_side`; file comments use `subject_type=file`. Legacy `position` is being retired. A non-latest commit can make a comment outdated. Fine-grained tokens need Pull requests write. Publication can return 403 or 422. These comments are distinct from issue timeline comments. [Review comments API](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request)

Azure creates a thread containing comments. `threadContext` carries file path and left/right start/end positions with line and offset. `pullRequestThreadContext` carries comparing iterations and `changeTrackingId`, required for iteration-enabled PRs. The endpoint documents code-write and thread-write scopes. Its example uses offset 1 for a start position, but does not define the full indexing contract, Unicode units, or end-offset inclusivity. Those semantics remain unverified and require provider-hosted fixtures. [Threads Create](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1)

## Normalized model implications

The following are engineering implications of the documented differences, not settled design choices:

- Repository identity needs provider, host, stable repository ID, organization/project where relevant, and source versus target repository.
- A snapshot needs target/source/common commits, comparison kind, fetched time, and opaque provider context such as Azure iterations.
- A file change needs old/new paths, status, old/new blob identity, content availability, binary/LFS classification, and provider tracking ID.
- Hunks need independent old/new line coordinates. Display line indexes cannot serve as comment coordinates.
- A draft comment needs snapshot identity, file identity, side and range, optional offsets, and its provider publication state and remote IDs.
- Completeness needs explicit states for truncated listing, unavailable content, omitted patch, and failed fetch. An empty string is valid content, not a universal failure sentinel.

The supplied `getFileContent(): Promise<string>` and `createReviewComment(): Promise<void>` interfaces conceal binary/unavailable states and returned comment IDs. Adapter implementation must retain those facts through richer internal results or typed failures. Otherwise reconciliation after partial publication cannot be reliable.

## Staleness and failures

GitHub primary and secondary rate limits differ. PAT requests commonly have a 5,000-per-hour primary allowance, with exceptions; response headers describe the applicable allowance and reset. Respect `Retry-After` and rate-limit reset rather than blindly retrying. [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

Inference: read PR identity and revisions before and after multipage capture to detect intervening updates. Commit-addressed content prevents moving-branch substitution, but does not make multiple remote requests atomic. Before publishing, compare the current head/iteration with the draft snapshot. Preserve drafts when remapping cannot be verified.

The cited create endpoints do not document an idempotency key. Inference: after a timeout, the server may already have created the comment. Track success, failure, and unknown outcome separately, reconcile remote IDs where possible, and do not blindly repeat an uncertain POST. A batch may publish some comments before another fails.

## Required verification before enabling publication

Official docs resolve the listed limits and field shapes. They do not establish tested line mapping for LeanReview. Live fixtures on both providers are a required input to the publishing decision:

1. Public and private repositories; read-only credentials; insufficient write scopes; revoked and expired tokens; inaccessible fork content.
2. Multipage repositories, projects, PRs, and changes; GitHub 300-file comparison and 3,000-file PR boundary; Azure continuation fields.
3. Addition, deletion, modification, rename with edits, pure rename, binary, empty file, no-final-newline, CRLF, Unicode, LFS, oversized content, and omitted patch.
4. Single-line comments on each side, context lines, multiline ranges, file-level comments where supported, and comments after rename. Verify the resulting location in each provider's UI.
5. Azure line/offset indexing, inclusive/exclusive end, Unicode offsets, comparison zero versus prior iteration, and tracking through subsequent iterations.
6. Source updates, target updates, force pushes, stale draft publication, and a PR update between pages or between preflight and POST.
7. 403/422, throttling, partial batches, disconnect after POST, and reconciliation without duplicate comments.

No live fixture has passed yet. Provider publication must remain gated until these results establish the exact coordinates and retry behavior.
