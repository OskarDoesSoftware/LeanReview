# LeanReview

LeanReview helps a human understand and review repository changes through logical groups and an ordered review sequence.

## Language

**Cohort**:
A group of changed files belonging to one feature, concern, or independent logical unit. In the MVP, each changed file belongs to one cohort.
_Avoid_: Change stack, category

**Layer**:
A review step within a cohort, ordered to introduce dependencies before changes that rely on them. Each changed file belongs to one layer in the MVP.
_Avoid_: Stage, tier

**Review snapshot**:
The fixed version of changes and associated context being reviewed. New commits become part of the review only through an explicit refresh.
_Avoid_: Live diff

**Review progress**:
The human's recorded completion state for files and layers in a review snapshot.

**Draft review comment**:
A locally saved comment associated with a specific file and line in a review snapshot, awaiting explicit publication.

**Repository source**:
The origin of reviewable changes: Local Git, GitHub, or Azure DevOps Repos.
