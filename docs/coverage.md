# CRAP meter and coverage

Select a changed file and open the CRAP tab. Each function or method shows complexity, observed coverage, and `CRAP = C² × (1 − coverage)³ + C`. The meter shows the highest measured score and counts of measured/unavailable functions. Scores above the configurable default threshold of 8 are advisory.

- TS/JS uses classic source cyclomatic complexity and per-function statement coverage from original-source-mapped Istanbul JSON. Statements inside nested functions belong to those functions. Vitest/V8 and Jest can produce `coverage/coverage-final.json` with their JSON reporter.
- Java uses JaCoCo XML method complexity and instruction coverage. Class name, method name, and JVM descriptor distinguish overloads. Maven commonly writes `target/site/jacoco/jacoco.xml`; Gradle commonly writes `build/reports/jacoco/test/jacocoTestReport.xml`. Configure the project's JaCoCo plugin and XML reporting first.

## Configure and run tests

Configure tests saves a per-repository command sequence, working directory, report path, timeout, and threshold. The directory and report path are relative to the repository root. Command arguments are a JSON array so executable paths and individual arguments remain explicit. A typical step is:

```json
[
  {
    "executable": "npm",
    "args": ["run", "test", "--", "--coverage"],
    "shell": false
  }
]
```

For Vitest configure `coverage.reporter: ["json"]`; for Jest use `--coverageReporters=json`. Java projects can use `mvn verify jacoco:report` or `./gradlew test jacocoTestReport` as their configured executable and arguments. On Windows, use `npm.cmd`, `mvnw.cmd`, or `gradlew.bat` with `shell: true`. Adjust commands to your project's actual test setup. Prerequisites must already be installed.

Run tests & coverage previews every command and requires Confirm & run tests. These commands execute repository code locally and may build or download dependencies. They run with an allowlisted environment that excludes LeanReview's provider credentials. Output is bounded, common credential patterns are redacted, and runs can be canceled or timed out. Application restart marks unfinished runs interrupted and does not resume them.

## Import, alignment, and storage

A successful run verifies the reviewed files and HEAD before and after execution, rejects a report that was not regenerated, saves results in SQLite with the raw report in the hashed cache, and writes `<report>.leanreview.json` provenance beside the report. Import and export support the report and sidecar. Matching source and report fingerprints are required for a score. Ordinary imported reports without matching provenance remain unavailable rather than assuming current coverage. TS/JS source complexity is still shown.

Failed or canceled runs retain previous measurements. Historical snapshots retain their own results; no before/after score delta is shown without two aligned reports. Upgrading a version-1 SQLite database creates `leanreview.pre-v2.<timestamp>.sqlite` before migration. Reports, logs, and provenance stay local; measurement does not call an LLM.

## Development verification

The coverage tests run real Vitest/V8 tests. To enable the Java execution fixture, install a JDK with `java` and `javac` on PATH, then run `npm run test:prepare-java`. This explicitly downloads checksum-verified JaCoCo 0.8.14 fixture tools from Maven Central into the ignored test directory. Without those tools, only the Java execution fixture is skipped; XML adapter tests still run. The application does not download these tools.

Run `npm test` for adapters, execution, cancellation, timeout, report alignment, and database migration. `npm run test:browser` also exercises command approval, real TS coverage execution, report import, and refresh in the built UI. Current execution verification is on Windows; macOS/Linux acceptance remains pending.
