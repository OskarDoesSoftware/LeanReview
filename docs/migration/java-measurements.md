# Java backend measurements

Measured on Windows on 2026-10-15 with JDK 25 and Node 24.21.0. Each deterministic dataset has 1,000 files and three fresh-process repetitions. Dataset manifests, trees, and revisions match the frozen Node baseline. No tests or builds ran alongside these measurements.

Values are medians, except peak Java RSS and API p95, which show the worst repetition.

| Dataset | Startup ms | Capture ms | Cold scan ms | Warm scan ms | Peak Java RSS MiB | Cold API p95 ms | Warm API p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| typescript | 7124.2 | 5588.19 | 5606.69 | 1894.12 | 522.3 | 21.95 | 3.44 |
| java | 7411.75 | 7196.05 | 5996.23 | 2471.38 | 706.83 | 5.25 | 3.2 |
| mixed | 6641.22 | 7226.87 | 6335.59 | 2205.31 | 587.55 | 4.85 | 3.22 |

Java startup, capture, and scan times exceed the [Node baseline](backend-measurements.md) for these workloads. This result does not pass performance acceptance. Startup includes Spring, JPA, and Tomcat. Capture includes the HTTP round trip. Warm scan timing includes any bounded wait for the preceding scan process to release its slot.

Peak Java RSS excludes the separate Node parser helper and Git processes. It cannot establish total application memory acceptance. Numeric release budgets and a process-tree memory measurement remain open in [issue 27](https://github.com/OskarDoesSoftware/LeanReview/issues/27). Java remains opt-in while platform and performance acceptance are incomplete.

[Raw measurements and artifact hashes](java-baseline.json) identify the exact measured JAR and helper. The recorded working-tree changes are committed with this report.
