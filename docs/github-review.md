# GitHub review workflow

The GitHub workflow is implemented in the opt-in Java backend. Local Git remains available without a GitHub account. Azure DevOps remains deferred per issue [30](https://github.com/OskarDoesSoftware/LeanReview/issues/30).

Choose a repository before selecting its open pull requests or local changes. Search connected repositories or recent local folders, browse for a folder, and link a local folder to a stable GitHub repository identity. The picker remembers its last tab per GitHub repository. Open PRs can be filtered to your own requests or requests awaiting your review, including team requests.

## Sign-in

Install GitHub CLI, then select **Sign in with GitHub CLI** in the repository picker. Open the displayed GitHub verification link and enter the one-time device code. LeanReview uses an application-owned CLI configuration and excludes inherited token variables. The CLI owns authentication; the local API does not return tokens.

GitHub CLI documents that it can fall back to plaintext when a system credential store is unavailable. LeanReview rejects that result, removes the token-bearing configuration from its own profile, and asks the user to unlock or configure the OS credential store. It does not fall back to a personal access token. Disconnect disables the application's connection, including after restart, without deleting unrelated CLI profiles.

## Snapshots and feedback

Opening a PR resumes its saved snapshot, progress, and drafts. First capture enumerates all changed-file pages and checks the count against GitHub's PR metadata. File bytes come from Git blobs reached through pinned trees. Symlinks, submodules, binary files, oversized files, and unavailable content remain explicit metadata-only changes. A mismatched file count is an incomplete change set and cannot support publication.

The PR description and discussions are shown separately from the AI guide. Select a diff line to draft an inline comment, or draft a reply from a discussion. Both remain local. Preview submission selects drafts and a review decision. **Submit to GitHub** is the publishing action. Resolve and reopen actions are labelled **on GitHub now** and publish immediately.

New commits produce a notice; they never silently replace the diff. Refresh retains history, copies progress only for unchanged content/diffs, preserves drafts, and flags positions that need checking. A draft can be reattached to a checked line in the current captured diff before submission.

Publication rechecks the current revision, complete file listing, and selected draft positions. Confirmed drafts are removed individually, while failed or uncertain drafts remain local. An uncertain request is reconciled using submission markers before any retry. The app does not automatically resend an ambiguous write. If GitHub never confirms it, the retained drafts and pending record remain available for investigation.

## Verification limits

Controlled CLI fixtures cover sign-in, capture, local drafts/replies, selective publication, thread resolution, reopening, changed revisions, incomplete listings, and uncertain publication reconciliation. Fixture tests do not establish live GitHub OAuth, private repository permissions, organization SSO, or real publication. Use a designated test PR for those shared writes before closing issue 30.

Sources: [GitHub CLI browser authentication](https://cli.github.com/manual/gh_auth_login), [GitHub CLI authentication status](https://cli.github.com/manual/gh_auth_status), [GitHub review API](https://docs.github.com/en/rest/pulls/reviews), and [GitHub discussion mutations](https://docs.github.com/en/graphql/reference/mutations#resolvereviewthread).
