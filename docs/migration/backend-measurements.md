# Node backend measurements

Measured on 2026-10-15 on Windows x64 with Node 24.21.0. Three fresh processes per deterministic 1,000-file dataset. Values below are medians across three repetitions, except peak RSS and API p95, which show the worst repetition.

| Dataset | Source MiB | Startup ms | Capture ms | Cold scan ms | Warm scan ms | Peak RSS MiB | Cold API p95 ms | Warm API p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| typescript | 1.79 | 1221.21 | 3982.86 | 3973.96 | 594.8 | 277.25 | 7.18 | 4.49 |
| java | 1.72 | 893.54 | 3166.11 | 3216.67 | 684.37 | 303.96 | 4.31 | 3.21 |
| mixed | 1.76 | 966.07 | 3210.05 | 3141.39 | 697.39 | 352.08 | 4.5 | 4.97 |

All 18 scans completed without parser failures or incomplete extraction coverage. Cold means an empty application artifact cache, with OS caches untouched. Warm means a second scan using captured source artifacts. RSS is the backend process lifetime high-water mark and excludes Git subprocesses. API samples use authenticated GET /api/provider while scanning. Startup includes Node/tsx imports and HTTP initialization, and excludes opening a browser and serving built assets.

Verification before this final measurement pass: TypeScript checking passed; 7 test files and 68 tests passed, including 7 compatibility checks. No tests or builds were intentionally run alongside this pass.

These are synthetic workload baselines, not production repository benchmarks or release performance budgets. The apparent warm-cache improvement is an observation about the current pipeline and does not predict a Java speedup.

See [methodology and fixture inventory](backend-compatibility.md) and [raw measurements with source and dataset identities](backend-baseline.json).
