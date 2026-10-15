# Capture remote revisions and record publication before sending

GitHub pull request snapshots carry provider identity and pinned base, merge-base, and head revisions alongside captured artifacts. They do not require a managed clone or use a linked working folder as their source. GitHub-specific behavior stays in source and feedback services behind the local API, while Local Git retains its comparison behavior.

Review submissions are recorded before contacting GitHub. Each posted review and draft includes a hidden submission marker, allowing uncertain outcomes to be reconciled without sending duplicate feedback. A missing marker after a failed request is not proof that GitHub rejected the write, so an uncertain submission blocks refresh and further publication until confirmed. This favors preserving feedback and preventing duplicates over automatic retries. Confirmed feedback is removed from local drafts; unsent feedback remains local.

The user selected GitHub CLI browser sign-in. A separate CLI configuration is used for LeanReview, inherited token environment variables are removed, and only OS-keyring authentication is accepted. The application never requests personal access tokens. Disconnect disables this application's connection without logging the user out of unrelated CLI sessions.
