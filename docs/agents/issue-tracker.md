# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `OskarDoesSoftware/LeanReview`. Use the `gh` CLI from this repository.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --comments`; use `--json` when structured fields are needed.
- List: `gh issue list --state open --json number,title,body,labels,assignees`, with appropriate label and state filters.
- Comment: `gh issue comment <number> --body-file <file>`.
- Labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number>` after recording the resolution.

Write multiline issue bodies and comments to a temporary file and pass it with `--body-file`. Preserve actual newlines.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill conventions

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, read the issue and its comments.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Destination, Notes, Decisions so far, Not yet specified, and Out of scope.
- Child ticket: create an issue labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`. Link it to the map with `gh api --method POST repos/OskarDoesSoftware/LeanReview/issues/<map-number>/sub_issues -F sub_issue_id=<child-database-id>`. If sub-issues are unavailable, add a linked task-list entry to the map and a `Part of #<map-number>` line to the child body.
- Blocking: use native dependencies with `gh api --method POST repos/OskarDoesSoftware/LeanReview/issues/<child-number>/dependencies/blocked_by -F issue_id=<blocker-database-id>`. Retrieve database IDs through `gh api repos/OskarDoesSoftware/LeanReview/issues/<number> --jq .id`. If dependencies are unavailable, use `Blocked by: #<number>, #<number>` in the child body.
- Frontier: fetch the map's sub-issues through `gh api --paginate repos/OskarDoesSoftware/LeanReview/issues/<map-number>/sub_issues`, or read its fallback task list. Keep open, unassigned children with no open blockers. Inspect `issue_dependencies_summary.blocked_by`, or resolve each fallback blocker's state. Select the first eligible ticket in map order.
- Claim: assign the chosen ticket with `gh issue edit <number> --add-assignee @me` before working on it.
- Resolve: post a resolution comment, close the ticket, and append its linked title and a one-line gist to the map's Decisions so far.

Refer to maps and tickets by their linked titles in human-facing output.
