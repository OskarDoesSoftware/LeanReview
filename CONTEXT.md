# LeanReview

LeanReview helps a human understand and review repository changes through logical groups and an ordered review sequence.

## Language

**Cohort**:
A group of changed files belonging to one feature, concern, or independent logical unit. In the MVP, each changed file belongs to one cohort.
_Avoid_: Change stack, category

**Layer**:
A review step within a cohort's suggested reading order, informed by dependencies and the explanation of the change. Each changed file belongs to one layer in the MVP.
_Avoid_: Stage, tier

**Review snapshot**:
The fixed version of changes and associated context being reviewed. New commits become part of the review only through an explicit refresh.
_Avoid_: Live diff

**Snapshot refresh**:
The creation of a new review snapshot from the latest changes while retaining the previous snapshot. Review progress carries forward only for files whose content and diff are unchanged.

**Incomplete change set**:
A set of changes whose changed-file listing is missing entries or cannot be verified as complete. It cannot support a completed review or comment publication.

**Metadata-only change**:
A known changed file whose content cannot be displayed, such as a binary or oversized file. A reviewer can explicitly acknowledge it without reviewing a text diff.

**Review progress**:
The human's recorded completion state for files and layers in a review snapshot.

**Draft review comment**:
A locally saved comment associated with a specific file and line in a review snapshot, awaiting explicit publication.

**Review analysis**:
An explicitly authorized examination of a review snapshot that proposes cohorts, layers, and findings for the human to accept.

**Captured artifact**:
Immutable text associated with a review snapshot, such as captured source, a diff, or a coverage report.

**Repository source**:
The origin of reviewable changes: Local Git, GitHub, or Azure DevOps Repos.

**CRAP score**:
A function or method's measured change-risk indicator combining cyclomatic complexity and observed test coverage under an explicitly named convention. Missing or unaligned coverage makes the score unavailable.
_Avoid_: AI quality score

**Repository module graph**:
A revision-specific view of modules and their observed dependency relationships across a repository, with extraction coverage and unresolved relationships visible.

**Review module graph**:
A snapshot-specific view focused on changed modules and their dependencies, expandable to related modules.
