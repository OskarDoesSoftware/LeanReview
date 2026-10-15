# Java performance acceptance

The user agreed these migration ceilings on 2026-10-15 for the deterministic 1,000-file TypeScript, Java, and mixed datasets. Each dataset requires three fresh-process repetitions, and every repetition must pass. These budgets allow the measured Java overhead; they do not require Java to outperform the [frozen Node baseline](backend-measurements.md).

| Measurement                           |    Ceiling |
| ------------------------------------- | ---------: |
| Startup                               | 10 seconds |
| Snapshot capture                      | 10 seconds |
| Cold artifact-cache scan              | 10 seconds |
| Warm artifact-cache scan              |  3 seconds |
| API p95 during either scan            |     100 ms |
| Sampled owned-process resident memory |    1.5 GiB |

[Machine-readable budgets](java-performance-budgets.json) and `scripts/check-java-performance.ts` enforce the limits, all three dataset identities, complete extraction, three distinct runs, and parser-inclusive memory evidence. A JVM-only historical report cannot pass the memory gate.

## Measurement method

The frozen datasets contain 1,000 committed source files in a clean repository. Snapshot capture compares `main` with `HEAD`, so it measures pinned inventories with no changed-file diffs. The cold/warm scans then examine all 1,000 sources. These results do not establish capture performance for 1,000 changed files or for a production repository.

`npm run benchmark:java` records the Java root process and its visible descendants, including Node parser helpers and Git. The Windows sampler enumerates process ancestry with Toolhelp32 and reads working sets. Unix uses `ps` ancestry and resident sets. Both aim to sample every 200 ms plus enumeration time. The sampler runs outside the measured process tree.

The reported memory peak is the largest sum observed in a sample. Shared resident pages can be counted in multiple processes; a short-lived process or peak between samples can be missed. Browser memory is excluded. This is a sampled resident-memory budget, not a measurement of unique physical pages or a guaranteed upper bound on every transient allocation.

Run without concurrent builds or test suites. Use JDK 25 and the workspace Node 24 runtime. `LEANREVIEW_JAVA_BENCHMARK_JAR` can select a fixed isolated JAR. The benchmark records JAR/helper SHA-256 identities and rejects a run if either artifact changes during measurement.

```text
npm run benchmark:java
npm run check:java-performance
```

The benchmark writes `docs/migration/java-process-tree-baseline.json` by default. `LEANREVIEW_JAVA_BASELINE_OUTPUT` can select another output without replacing the original JVM-only baseline.

Platform, credential-store, startup/recovery, and browser acceptance remain separate requirements in [issue 27](https://github.com/OskarDoesSoftware/LeanReview/issues/27). A passing Windows performance report alone cannot authorize the default-backend cutover.

## Recorded Windows results

All nine runs passed `npm run check:java-performance` on 2026-10-15. Each table entry is the worst observed value for that metric across the dataset's three repetitions, rather than a median.

| Dataset    | Startup ms | Capture ms | Cold scan ms | Warm scan ms | API p95 ms | Process-tree RSS MiB |
| ---------- | ---------: | ---------: | -----------: | -----------: | ---------: | -------------------: |
| TypeScript |    9951.04 |    7087.73 |      7027.71 |      2901.55 |       6.93 |               864.94 |
| Java       |    9134.87 |    7930.74 |      7140.64 |      2738.85 |       5.45 |               549.56 |
| Mixed      |    7319.60 |    7538.11 |      7393.75 |      2896.31 |       5.27 |               578.55 |

The parser and Git descendants were observed in every repetition, with 53–63 memory samples per run. All 18 scans completed with complete extraction and no parser failures. Startup and warm-scan margins are narrow on this host; the raw values above are not rounded down to claim extra headroom.

The [first memory-inclusive pass](java-process-tree-before-inventory-cache.json) failed because one Java capture took 10064.79 ms. That report is retained. Capture was rereading the same immutable commit inventory up to four times. A per-capture cache keyed by commit ID now reuses that inventory; mutable index/worktree stability reads still run in both passes. The frozen Git capture and filesystem tests passed, with the existing Windows symlink-permission skip.

The [passing raw report](java-process-tree-baseline.json) records dataset identities, all repetitions, process observations, and JAR/helper/sampler hashes. Its fixed isolated JAR uses the Java implementation from `818d60c` plus the inventory optimization committed in `395d57b`; subsequent intervening changes concerned launch/CI scripts and platform test expectations. The exact benchmark and sampler sources are hashed in the report. No local test suite or build ran during either measurement pass.
