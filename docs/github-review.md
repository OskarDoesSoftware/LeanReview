# GitHub review workflow

The GitHub workflow is implemented in the default Java backend. Local Git remains available without a GitHub account. Azure DevOps remains deferred per issue [30](https://github.com/OskarDoesSoftware/LeanReview/issues/30).

Choose a repository before selecting its open pull requests or local changes. Search connected repositories or recent local folders, browse for a folder, and link a local folder to a stable GitHub repository identity. The picker remembers its last tab per GitHub repository. Open PRs can be filtered to your own requests or requests awaiting your review, including team requests.

Recent reviews reopen saved snapshots, progress, and drafts directly without recapturing the PR. A remembered Local changes tab opens without fetching remote PRs, so a denied PR listing does not block the linked working folder. Folder browsing is also available while linking that folder.

## Sign-in

Install GitHub CLI, then select **Sign in with GitHub CLI** in the repository picker. Open the displayed GitHub verification link and enter the one-time device code. LeanReview uses an application-owned CLI configuration and excludes inherited token variables. The CLI owns authentication; the local API does not return tokens.

GitHub CLI documents that it can fall back to plaintext when a system credential store is unavailable. LeanReview rejects that result, removes the token-bearing configuration from its own profile, and asks the user to unlock or configure the OS credential store. It does not fall back to a personal access token. Disconnect disables the application's connection, including after restart, without deleting unrelated CLI profiles.

## Snapshots and feedback

Opening a PR resumes its saved snapshot, progress, and drafts. First capture enumerates all changed-file pages and checks the count against GitHub's PR metadata. File bytes come from Git blobs reached through pinned trees. Symlinks, submodules, binary files, oversized files, and unavailable content remain explicit metadata-only changes. A mismatched file count is an incomplete change set and cannot support publication.

The PR description and discussions are shown separately from the AI guide. Select a diff line to draft an inline comment, or draft a reply from a discussion. Both remain local. Preview submission selects drafts and a review decision. **Submit to GitHub** is the publishing action. Resolve and reopen actions are labelled **on GitHub now** and publish immediately.

Saving another draft preserves your existing submission selections. Switching PRs or snapshots clears unsaved composer text and the reply target; saved drafts remain attached to their original review.

New commits produce a notice; they never silently replace the diff. Refresh retains history, copies progress only for unchanged content/diffs, preserves drafts, and flags positions that need checking. A draft can be reattached to a checked line in the current captured diff before submission.

Publication rechecks the current revision, complete file listing, and selected draft positions. Confirmed drafts are removed individually, while failed or uncertain drafts remain local. An uncertain request is reconciled using submission markers before any retry. The app does not automatically resend an ambiguous write. If GitHub never confirms it, the retained drafts and pending record remain available for investigation.

## Verification limits

Controlled CLI fixtures cover sign-in, capture, local drafts/replies, selective publication, thread resolution, reopening, changed revisions, incomplete listings, and uncertain publication reconciliation. Fixture tests do not establish live GitHub OAuth, private repository permissions, organization SSO, or real publication. On 2026-10-15, the user accepted fixture publication tests plus passing live read-only checks as sufficient verification for the MVP. Live publication acceptance is not required to close issue 30 under that amendment.

Regression coverage includes composer isolation between PRs, preserving unchecked drafts when adding feedback, resuming recent reviews without recapture, linked local changes when remote listing is denied, paginated repository/PR/team discovery, and retaining a failed reply after its inline feedback succeeded. Live GitHub checks remain read-only at the user's request; no actual comment, reply, review, or thread mutation is claimed as verified.

Reply targets use GitHub's `fullDatabaseId` and decimal strings to preserve 64-bit identifiers. Existing numeric draft records remain readable. The integration fixture includes identifiers beyond JavaScript's exact integer range and checks reattachment and uncertain-reply reconciliation.

`LiveGitHubReadAcceptanceTest` can verify an existing keyring account and a selected real PR. Set `LEANREVIEW_LIVE_GITHUB_READ_COMMAND` to a JSON command array containing the workspace Node executable and the absolute path to `tests/fixtures/github-readonly.mjs`; optionally set `LEANREVIEW_LIVE_GITHUB_PR` to the PR number. The guard accepts only fixed-host REST reads, GraphQL queries, and token-free account status. It rejects login, credential display, and shared mutations. The test uses isolated local data. Repository access, PR #42 capture/resumption, and discussion reads passed on 2026-10-15; this does not establish live publication or a new interactive login.

Sources: [GitHub CLI browser authentication](https://cli.github.com/manual/gh_auth_login), [GitHub CLI authentication status](https://cli.github.com/manual/gh_auth_status), [GitHub review API](https://docs.github.com/en/rest/pulls/reviews), [GitHub comment identifiers](https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewcomment), and [GitHub discussion mutations](https://docs.github.com/en/graphql/reference/mutations#resolvereviewthread).
