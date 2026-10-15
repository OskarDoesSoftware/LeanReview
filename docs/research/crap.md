# CRAP score calculation and coverage inputs

Research for [issue 11](https://github.com/OskarDoesSoftware/LeanReview/issues/11), checked 14 October 2026. This note records evidence and unresolved choices; it does not select product behavior.

## Formula and attribution

Alberto Savoia's July 2007 article credits research with Bob Evans. Its original expansion is Change Risk Analysis and Predictions. It defines a method-level maintenance/change-risk indicator, warns against using it as a general code-quality or programmer-quality score, and specifies cyclomatic complexity plus automated basis-path coverage. [Original proposal](https://www.artima.com/weblogs/viewpost.jsp?thread=210575).

For complexity C and coverage fraction q in [0,1], the equivalent formula is:

```text
CRAP = C² × (1 − q)³ + C
```

The article writes coverage as a percentage divided by 100. At full coverage the result is C; at verified zero coverage it is C²+C. These are mathematical consequences. For C=10, coverage 0%, 50%, 80%, and 100% produces 110, 22.5, 10.8, and 10 respectively. This is not a bounded 0–100 meter.

The user's Uncle Bob reference also has a concrete first-party implementation context. The current `unclebob/crap4java` specification uses the fraction formula, source-syntax complexity, JaCoCo instruction coverage, N/A when coverage cannot be attributed, and a maximum-score failure threshold strictly greater than 8. It runs Maven tests, excludes constructors and some other method types, and permits nearest appropriate coverage entries when exact matching fails. It is Java/Maven-specific and does not promise machine-readable output. [Uncle Bob's specification](https://github.com/unclebob/crap4java/blob/main/spec.md).

These represent different coverage policies. Original basis-path coverage, instruction coverage, line coverage, and branch coverage must not silently share one label. No evidence here establishes a universal threshold. PHPUnit's Crap4j exporter defaults to 30, counts methods at or above that threshold, and accumulates individual method scores. This differs from Uncle Bob's >8 policy. [Exporter source](https://raw.githubusercontent.com/sebastianbergmann/php-code-coverage/main/src/Report/Crap4j.php).

## Aggregation and interpretation

The original formula operates on a method/function. Inference from its nonlinearity: computing once from summed file complexity and file coverage is not equivalent to aggregating method results. With two fully uncovered C=5 functions, their scores sum to 60; applying C=10 once yields 110. A file/cohort meter therefore requires an explicit summary policy, such as worst measured function, distribution, or count above a chosen threshold. A mean can hide a risky outlier. Unknown methods must remain visible in any denominator.

A deterministic parser-derived complexity value plus observed coverage can produce a reproducible score under a named convention. An LLM cannot observe test execution from source text. An AI guess about tests or complexity is not a measured CRAP score. This distinction follows from the formula's required inputs.

## Existing language inputs

| Language | Complexity input | Coverage input | Mapping and limits |
|---|---|---|---|
| TypeScript/JavaScript | ESLint complexity rule with TypeScript parser | Vitest V8 or Istanbul coverage reports | Preserve original-source mapping and function/statement/branch positions. Function execution percentage is not internal function coverage. |
| Python | Radon function/method complexity | Coverage.py JSON with executed/missing lines and optional branches | Join executable lines to parsed function ranges, handling nested functions explicitly. File percentages alone cannot establish method coverage. |
| Go | gocyclo function complexity | Go coverage profile | Profile counts source blocks and statements, not basis paths; join block spans to function source ranges. |
| Java | JaCoCo method complexity, or source parser under a separate convention | JaCoCo method counters in XML | Method name plus JVM descriptor distinguishes overloads; synthetic methods and compiler transformations complicate source matching. |
| C# | Roslyn/code metrics convention or existing report | Coverlet JSON/OpenCover/Cobertura | Test projects and build artifacts are needed to generate coverage; report granularity determines whether a method score is possible. |

The table describes available ingredients, not verified LeanReview adapters.

ESLint supports classic and modified complexity; the modified form counts a switch once rather than each case. It counts optional chains and default values and treats class initializers/static blocks as separate implicit functions. Preserve tool version and variant when comparing. [ESLint rule](https://eslint.org/docs/latest/rules/complexity). TypeScript requires an ESLint-compatible parser rather than native JavaScript parsing. [TypeScript parser](https://typescript-eslint.io/packages/parser/).

Vitest supports V8 and Istanbul and documents coverage reporting and source remapping. Importing emitted reports avoids requiring LeanReview to execute a test suite, but fixtures must verify original TS/TSX coordinates and nested functions. [Vitest coverage](https://vitest.dev/guide/coverage.html).

Radon documents syntax-specific cyclomatic increments including conditionals, boolean operators, comprehensions, and exception handlers. [Radon definitions](https://radon.readthedocs.io/en/latest/intro.html). Coverage.py emits JSON, and `--show-contexts` can include execution contexts. [JSON command](https://coverage.readthedocs.io/en/latest/commands/cmd_json.html). Tool outputs must be inspected against fixtures before promising a stable method-level mapping.

Go's official coverage description uses source rewriting, statement counts, and source block ranges. It explains that short-circuit expression internals are not individually instrumented, so 100% statement coverage does not imply every logical path ran. [Go coverage](https://go.dev/blog/cover). gocyclo calculates per-function complexity as 1 plus increments for if/for/case and &&/||. [gocyclo](https://github.com/fzipp/gocyclo).

JaCoCo derives metrics from bytecode. It computes method complexity from branches/decisions, excludes exception handling from that count, distinguishes instruction, branch and line counters, and warns that synthetic code can affect results. Debug information supports source mapping. These values are not guaranteed to match source-parser counts. [JaCoCo counters](https://www.jacoco.org/jacoco/trunk/doc/counters.html). Zero-total counter ratios are NaN rather than meaningful zero coverage. [Counter API](https://www.jacoco.org/jacoco/trunk/doc/api/org/jacoco/core/analysis/ICounter.html).

Microsoft documents C#/VB method cyclomatic complexity and a configurable CA1502 threshold. That threshold is a complexity lint policy, not a CRAP threshold. [CA1502](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1502). Coverlet is cross-platform and produces JSON, LCOV, OpenCover and Cobertura outputs; it requires builds/tests to collect data. [Coverlet](https://github.com/coverlet-coverage/coverlet). OpenCover itself is Windows-only, so it is unsuitable as a mandatory cross-platform collector. Its report format remains an import possibility. [OpenCover](https://github.com/OpenCover/opencover).

## Missing coverage and revision alignment

The following are implementation consequences, not settled product decisions:

- No report, unsupported syntax, missing function mapping, zero executable denominator, and verified zero test hits are different states. Only the last justifies q=0 without an explicit assumption.
- A report's existence and timestamp do not prove it measures the current review snapshot. Retain repository identity, revision, source hashes, tool/version, configuration, coverage kind, report hash, and collection time where available. A hash match can validate the measured source but cannot prove the rest of the test environment or repository revision.
- In API-first remote review, source APIs do not generate test coverage. Imported reports need revision/source validation; generating coverage locally requires a checkout/build environment and executes repository code. That cannot be assumed in the read-only API workflow.
- Base/head comparisons need separate aligned coverage inputs. Reusing base coverage on head introduces an assumption. If only head coverage exists, show head metrics and complexity changes without inventing a measured CRAP delta.
- Function matching across edits requires identity rules for renames, overloads, nested/anonymous functions, splits and merges. Ambiguous matches should remain unpaired. A changed-file score concerns full functions, not just added lines.
- Cache metrics with their snapshot and provenance. Refresh should recompute or revalidate source mappings rather than transplant old numeric scores onto new code.

## Unresolved product choices

1. Is the intended meter faithful to original basis-path coverage, to Uncle Bob's instruction-based Java convention, or a family of clearly named per-language variants?
2. Which languages and report formats must work for MVP completion? Full-stack TypeScript implementation does not automatically provide parsers or runtime coverage for every review language.
3. Is report import sufficient, or must LeanReview run tests? Is managed checkout work now required for remote measurement?
4. What should the meter display when coverage is unavailable or unverified: N/A, complexity only, or a separately labelled worst-case bound?
5. What threshold and file/cohort aggregation should apply? Should users configure them? No universal threshold follows from the formula.
6. How strict must provenance be before declaring a score measured for a snapshot, and can users explicitly attest to an imported report's revision?
7. Is baseline comparison required or optional when only one aligned report exists?

Acceptance fixtures should cover fractional/percentage units, full/zero/missing coverage, differing coverage kinds, nonlinear aggregation, nested functions, generated code, path mapping, stale reports, overloads, and ambiguous base/head matches. No code or benchmark was built for this research.
