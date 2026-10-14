import path from "node:path";
import { z } from "zod";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Snapshot } from "../../../packages/contracts/src/index";
import {
  provenanceSchema,
  type CoverageMetrics,
  type CoverageProvenance,
  type FileMetrics,
  type FunctionMetric,
} from "../../../packages/contracts/src/coverage";
import { hash } from "../git/local";
import { functionUnits } from "./typescript";
export const crapScore = (complexity: number, coverage: number) => {
  if (
    !Number.isFinite(complexity) ||
    complexity < 1 ||
    !Number.isFinite(coverage) ||
    coverage < 0 ||
    coverage > 1
  )
    throw new Error("Invalid measured complexity or coverage.");
  return complexity ** 2 * (1 - coverage) ** 3 + complexity;
};
const point = z.object({
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
});
const istanbulFile = z.object({
  path: z.string().optional(),
  statementMap: z.record(
    z.string(),
    z.object({
      start: point,
      end: point.extend({ column: z.number().int().nonnegative().nullable() }),
    }),
  ),
  s: z.record(z.string(), z.number().nonnegative().finite()),
});
const normalized = (value: string) =>
  value.replace(/\\/g, "/").replace(/^\.\//, "");
function relativeReportPath(root: string, value: string) {
  const name = normalized(value),
    prefix = normalized(root).replace(/\/$/, "") + "/";
  if (name.toLowerCase().startsWith(prefix.toLowerCase()))
    return name.slice(prefix.length);
  if (
    path.isAbsolute(name) ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").includes("..")
  )
    return null;
  return name;
}
export function measure(
  snapshot: Snapshot,
  format: "istanbul" | "jacoco",
  report?: string,
  supplied?: unknown,
  threshold = 8,
): CoverageMetrics {
  if (report && Buffer.byteLength(report) > 20 * 1024 * 1024)
    throw new Error("Coverage report exceeds 20 MiB.");
  const reportHash = report ? hash(report) : null;
  let provenance: CoverageProvenance | undefined;
  if (supplied !== undefined && supplied !== null)
    provenance = provenanceSchema.parse(supplied);
  const reportAligned =
    !!provenance &&
    provenance.reportHash === reportHash &&
    provenance.head === snapshot.head;
  const warnings: string[] = [];
  if (report && !reportAligned)
    warnings.push(
      "Report fingerprint/source provenance is missing or mismatched. CRAP is unavailable until an aligned report is supplied.",
    );
  const alignedFile = (file: Snapshot["files"][number]) =>
    reportAligned &&
    file.after.kind === "text" &&
    provenance!.sourceHashes[file.path] === hash(file.after.text);
  const files: FileMetrics[] = [];
  let parsedIstanbul = new Map<string, z.infer<typeof istanbulFile>>();
  let packages: any[] = [];
  if (report && format === "istanbul") {
    const raw = z.record(z.string(), istanbulFile).parse(JSON.parse(report));
    for (const [key, entry] of Object.entries(raw)) {
      const rel = relativeReportPath(snapshot.root, entry.path ?? key);
      if (!rel) continue;
      if (parsedIstanbul.has(rel))
        throw new Error("Ambiguous duplicate source paths in coverage report.");
      parsedIstanbul.set(rel, entry);
    }
  }
  if (report && format === "jacoco") {
    // JaCoCo's standard external DTD is a declaration only; no entities are resolved or fetched.
    if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(report))
      throw new Error("Custom XML entities/internal DTDs are not supported.");
    const xml = report.replace(
      /<!DOCTYPE\s+report\s+PUBLIC\s+"-\/\/JACOCO\/\/DTD Report [^"]+"\s+"[^"]+"\s*>/g,
      "",
    );
    if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true)
      throw new Error("Invalid or unsupported JaCoCo XML.");
    const tree = new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
      isArray: (name) =>
        ["package", "class", "method", "counter"].includes(name),
    }).parse(xml);
    if (!tree.report) throw new Error("Expected a JaCoCo report element.");
    packages = tree.report.package ?? [];
  }
  for (const file of snapshot.files) {
    if (
      file.after.kind !== "text" ||
      !/\.(?:[cm]?[jt]sx?|java)$/.test(file.path)
    )
      continue;
    if (file.path.endsWith(".java")) {
      const item: FileMetrics = {
        fileId: file.id,
        path: file.path,
        language: "java",
        convention: "JaCoCo method complexity + instruction coverage",
        functions: [],
      };
      const candidates = packages
        .flatMap((p) => (p.class ?? []).map((c: any) => ({ p, c })))
        .filter(({ p, c }) => {
          const suffix = `${p["@_name"] ? p["@_name"] + "/" : ""}${c["@_sourcefilename"] ?? ""}`;
          return (
            !!c["@_sourcefilename"] &&
            (file.path === suffix || file.path.endsWith("/" + suffix))
          );
        });
      const seen = new Set<string>();
      for (const { c } of candidates)
        for (const method of c.method ?? []) {
          const methodId = `${c["@_name"]}#${method["@_name"]}${method["@_desc"]}`;
          const metric: FunctionMetric = {
            id: hash(methodId).slice(0, 24),
            name: methodId,
            line: Number(method["@_line"] ?? 0),
            complexity: null,
            coverage: null,
            crap: null,
          };
          const counters = method.counter ?? [];
          const counter = (type: string) => {
            const found = counters.filter((x: any) => x["@_type"] === type);
            if (found.length !== 1) return null;
            const missed = Number(found[0]["@_missed"]),
              covered = Number(found[0]["@_covered"]);
            if (
              ![missed, covered].every((n) => Number.isSafeInteger(n) && n >= 0)
            )
              return null;
            if (!Number.isSafeInteger(missed + covered)) return null;
            return { missed, covered, total: missed + covered };
          };
          const complexity = counter("COMPLEXITY"),
            instructions = counter("INSTRUCTION");
          if (complexity && complexity.total > 0 && alignedFile(file))
            metric.complexity = complexity.total;
          if (seen.has(methodId))
            throw new Error("Duplicate method identity in JaCoCo report.");
          else if (!alignedFile(file))
            metric.reason = "Missing/stale source provenance";
          else if (
            snapshot.files.filter(
              (f) =>
                f.path === `${c["@_sourcefilename"]}` ||
                f.path.endsWith("/" + `${c["@_name"]}`.split("$")[0] + ".java"),
            ).length > 1
          )
            metric.reason = "Ambiguous Java source mapping";
          else if (
            !Number.isSafeInteger(metric.line) ||
            metric.line < 1 ||
            metric.line > file.after.text.split("\n").length ||
            !method["@_desc"]
          )
            metric.reason = "Missing/invalid method source mapping";
          else if (
            !complexity ||
            !instructions ||
            complexity.total < 1 ||
            instructions.total < 1
          )
            metric.reason = "Missing counter or zero executable denominator";
          else {
            metric.coverage = instructions.covered / instructions.total;
            metric.crap = crapScore(complexity.total, metric.coverage);
          }
          seen.add(methodId);
          item.functions.push(metric);
        }
      if (!item.functions.length)
        item.reason = report
          ? "No matching JaCoCo methods; method count unknown."
          : "Import or collect JaCoCo XML to measure Java methods.";
      files.push(item);
      continue;
    }
    const item: FileMetrics = {
      fileId: file.id,
      path: file.path,
      language: "ts/js",
      convention:
        "Source classic cyclomatic complexity + per-function statement coverage",
      functions: [],
    };
    try {
      const { units, position, lineEnd } = functionUnits(
        file.path,
        file.after.text,
      );
      const coverage = parsedIstanbul.get(file.path);
      const hits = new Map(units.map((unit) => [unit.id, [] as number[]]));
      let mappingError = false;
      if (coverage && format === "istanbul")
        for (const [id, span] of Object.entries(coverage.statementMap)) {
          try {
            const start = position(span.start.line, span.start.column),
              end =
                span.end.column === null
                  ? lineEnd(span.end.line)
                  : position(span.end.line, span.end.column);
            if (end < start || !(id in coverage.s)) {
              mappingError = true;
              continue;
            }
            const owner = units
              .filter((unit) => start >= unit.bodyStart && end <= unit.bodyEnd)
              .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
            if (owner) hits.get(owner.id)!.push(coverage.s[id]);
          } catch {
            mappingError = true;
          }
        }
      item.functions = units.map((unit) => {
        const counters = hits.get(unit.id)!;
        const reason = !report
          ? "No coverage report"
          : format !== "istanbul" || !coverage
            ? "No matching Istanbul source coverage"
            : !alignedFile(file)
              ? "Missing/stale source provenance"
              : mappingError
                ? "Invalid statement source mapping"
                : !counters.length
                  ? "No executable statements mapped to this function"
                  : undefined;
        const q = reason
          ? null
          : counters.filter((n) => n > 0).length / counters.length;
        return {
          id: unit.id,
          name: unit.name,
          line: unit.line,
          complexity: unit.complexity,
          coverage: q,
          crap: q === null ? null : crapScore(unit.complexity, q),
          reason,
        };
      });
      if (!units.length) item.reason = "No executable functions in this file.";
    } catch {
      item.reason = "Unsupported or invalid source syntax.";
    }
    files.push(item);
  }
  const metrics = files.flatMap((file) => file.functions);
  const scores = metrics.filter((m) => m.crap !== null);
  return {
    snapshotId: snapshot.id,
    format,
    capturedAt: new Date().toISOString(),
    reportHash,
    aligned:
      reportAligned &&
      files.every((f) =>
        snapshot.files.some((s) => s.id === f.fileId && alignedFile(s)),
      ),
    files,
    warnings,
    threshold,
    highest: scores.length ? Math.max(...scores.map((m) => m.crap!)) : null,
    measured: scores.length,
    missing: metrics.length - scores.length,
    aboveThreshold: scores.filter((m) => m.crap! > threshold).length,
  };
}
