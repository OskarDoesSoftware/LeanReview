import type { Snapshot } from "../../../packages/contracts/src/index";
import type {
  GraphOptions,
  ModuleGraph,
  GraphNode,
  GraphEdge,
} from "../../../packages/contracts/src/graph";
import { hash } from "../git/local";
import { localGraphSource, type GraphSource } from "./source";
import {
  typescriptDependencies,
  typescriptResolver,
  type Dependency,
} from "./typescript";
import { javaClasses, type JavaClass } from "./java";
import ts from "typescript-ast";
import path from "node:path";
const pathJoin = (file: string, relative: string) =>
  path.posix.normalize(path.posix.join(path.posix.dirname(file), relative));
export function graphCycles(
  nodes: string[],
  edges: { source: string; target: string }[],
) {
  const out = new Map(nodes.map((n) => [n, [] as string[]])),
    incoming = new Map(nodes.map((n) => [n, [] as string[]]));
  for (const e of edges) {
    out.get(e.source)?.push(e.target);
    incoming.get(e.target)?.push(e.source);
  }
  const visited = new Set<string>(),
    order: string[] = [];
  for (const n of nodes) {
    if (visited.has(n)) continue;
    const stack: [string, boolean][] = [[n, false]];
    while (stack.length) {
      const [id, done] = stack.pop()!;
      if (done) {
        order.push(id);
        continue;
      }
      if (visited.has(id)) continue;
      visited.add(id);
      stack.push([id, true]);
      for (const next of out.get(id) ?? [])
        if (!visited.has(next)) stack.push([next, false]);
    }
  }
  visited.clear();
  const cycles: string[][] = [];
  for (const n of order.reverse()) {
    if (visited.has(n)) continue;
    const group: string[] = [],
      stack = [n];
    visited.add(n);
    while (stack.length) {
      const id = stack.pop()!;
      group.push(id);
      for (const next of incoming.get(id) ?? [])
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
    }
    if (group.length > 1 || (out.get(n) ?? []).includes(n))
      cycles.push(group.sort());
  }
  return cycles;
}
const sourcePattern = /\.(?:[cm]?[jt]sx?|java)$/i;
const excluded =
  /(^|\/)(?:node_modules|\.git|target|dist|build|coverage|vendor)\//;
export async function scanGraph(
  snapshot: Snapshot,
  options: GraphOptions,
  signal?: AbortSignal,
  source: GraphSource = localGraphSource(snapshot, options.side),
  progress?: (
    value: import("../../../packages/contracts/src/graph").GraphProgress,
  ) => void,
): Promise<ModuleGraph> {
  try {
    return await collectGraph(snapshot, options, signal, source, progress);
  } finally {
    await source.close?.();
  }
}
async function collectGraph(
  snapshot: Snapshot,
  options: GraphOptions,
  signal: AbortSignal | undefined,
  source: GraphSource,
  progress?: (
    value: import("../../../packages/contracts/src/graph").GraphProgress,
  ) => void,
): Promise<ModuleGraph> {
  const files = new Map<string, string>(),
    nodes = new Map<string, GraphNode>(),
    edges: GraphEdge[] = [],
    edgeIds = new Set<string>();
  const warnings = [
    "Incoming relationships cover scanned sources only. Java resolution is bounded source analysis, without compiler/classpath or generated-code completeness.",
  ];
  if (!source.complete)
    warnings.push(
      "Pinned repository inventory is incomplete or unavailable. Refresh legacy snapshots to capture full context.",
    );
  const omissions: { path: string; reason: string }[] = [];
  let bytes = 0,
    scanned = 0,
    parserFailures = 0;
  const eligible = source.paths.filter(
    (p) => sourcePattern.test(p) && !excluded.test(p),
  );
  const changed = new Map(
    snapshot.files.map((f) => [
      options.side === "before" ? f.oldPath : f.path,
      f.id,
    ]),
  );
  const makeNode = (
    name: string,
    kind: GraphNode["kind"],
    language: GraphNode["language"],
    file?: string,
    label = name,
  ): GraphNode => {
    const id = hash(`${kind}:${name}`).slice(0, 24);
    let node = nodes.get(id);
    if (!node) {
      node = {
        id,
        label,
        kind,
        language,
        path: file,
        fileId: file ? changed.get(file) : undefined,
        changed: !!file && changed.has(file),
      };
      nodes.set(id, node);
    }
    return node;
  };
  const checkpoint = async () => {
    if (signal?.aborted) throw new Error("Graph scan canceled.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const configuration: string[] = [];
  let configBytes = 0;
  const configQueue = source.paths.filter(
      (p) =>
        /(^|\/)(?:[^/]*[jt]sconfig[^/]*\.json|package\.json)$/.test(p) &&
        !excluded.test(p),
    ),
    seenConfig = new Set<string>();
  for (const name of configQueue) {
    progress?.({
      phase: "configuration",
      completed: seenConfig.size,
      total: configQueue.length,
      bytes: configBytes,
      path: name,
    });
    if (seenConfig.has(name)) continue;
    seenConfig.add(name);
    if (configuration.length >= 500 || configBytes > 2 * 1024 * 1024) {
      warnings.push(
        "Configuration capture limit reached; resolution is partial.",
      );
      break;
    }
    await checkpoint();
    try {
      const text = await source.read(name, signal);
      configBytes += Buffer.byteLength(text);
      if (configBytes > 2 * 1024 * 1024)
        throw new Error("Configuration byte cap");
      files.set(name, text);
      configuration.push(name);
      if (!name.endsWith("package.json")) {
        const value = ts.parseConfigFileTextToJson(name, text).config;
        if (
          typeof value?.extends === "string" &&
          value.extends.startsWith(".")
        ) {
          let target = pathJoin(name, value.extends);
          if (!target.endsWith(".json")) target += ".json";
          if (source.paths.includes(target)) configQueue.push(target);
          else warnings.push(`Missing captured TS config: ${target}`);
        }
      }
    } catch (error) {
      omissions.push({ path: name, reason: String(error) });
    }
  }
  let attempts = 0,
    byteCap = false;
  for (const name of eligible) {
    progress?.({
      phase: "reading",
      completed: attempts,
      total: Math.min(eligible.length, options.maxFiles),
      bytes,
      path: name,
    });
    if (attempts >= options.maxFiles) {
      omissions.push({ path: name, reason: "Source file scan cap reached" });
      continue;
    }
    if (byteCap) {
      omissions.push({ path: name, reason: "Source byte scan cap reached" });
      continue;
    }
    await checkpoint();
    attempts++;
    try {
      const text = await source.read(name, signal),
        size = Buffer.byteLength(text);
      if (bytes + size > options.maxBytes) {
        byteCap = true;
        omissions.push({ path: name, reason: "Source byte scan cap reached" });
        continue;
      }
      files.set(name, text);
      bytes += size;
    } catch (error) {
      omissions.push({
        path: name,
        reason: error instanceof Error ? error.message : "Source unavailable",
      });
    }
  }
  const listed = new Set(source.paths.filter((p) => !excluded.test(p)));
  const resolveTs = typescriptResolver(files, listed, warnings);
  const java: { path: string; unit: JavaClass; node: GraphNode }[] = [];
  const pending: { node: GraphNode; dep: Dependency }[] = [];
  const addEdge = (
    from: GraphNode,
    target: GraphNode,
    dep: Dependency,
    status: GraphEdge["status"],
    resolver: string,
  ) => {
    if (edges.length >= 200000) {
      if (!warnings.includes("Edge cap reached; graph is partial."))
        warnings.push("Edge cap reached; graph is partial.");
      return;
    }
    const identity = `${from.id}:${target.id}:${dep.kind}:${dep.line}:${dep.specifier}:${dep.typeOnly}`;
    const id = hash(identity).slice(0, 24);
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({
      id,
      source: from.id,
      target: target.id,
      kind: dep.kind,
      typeOnly: dep.typeOnly,
      status,
      path: from.path!,
      line: dep.line,
      specifier: dep.specifier,
      resolver,
    });
  };
  for (const name of eligible) {
    const text = files.get(name);
    if (text === undefined) continue;
    progress?.({
      phase: "parsing",
      completed: scanned + parserFailures,
      total: files.size - configuration.length,
      bytes,
      path: name,
    });
    await checkpoint();
    try {
      if (name.endsWith(".java"))
        for (const unit of await javaClasses(text)) {
          const node = makeNode(
            `${name}:${unit.name}`,
            "class",
            "java",
            name,
            unit.name,
          );
          node.line = unit.line;
          const pkg = makeNode(
            unit.packageName || "<default package>",
            "package",
            "java",
            undefined,
            unit.packageName || "<default package>",
          );
          pkg.changed ||= node.changed;
          node.packageId = pkg.id;
          java.push({ path: name, unit, node });
        }
      else {
        const node = makeNode(name, "module", "ts/js", name);
        for (const dep of typescriptDependencies(name, text))
          pending.push({ node, dep });
      }
      scanned++;
    } catch (error) {
      parserFailures++;
      omissions.push({
        path: name,
        reason: error instanceof Error ? error.message : "Parser failure",
      });
    }
  }
  for (const { node, dep } of pending) {
    if (edges.length % 100 === 0) {
      await checkpoint();
      progress?.({
        phase: "resolving",
        completed: edges.length,
        total: pending.length,
        bytes,
        path: node.path,
      });
    }
    const target = !dep.dynamic
      ? resolveTs(node.path!, dep.specifier)
      : undefined;
    const status = target
      ? "resolved"
      : dep.dynamic ||
          resolveTs.isInternal(dep.specifier) ||
          dep.specifier.startsWith(".") ||
          dep.specifier.startsWith("/") ||
          dep.specifier.startsWith("#")
        ? "unresolved"
        : "external";
    addEdge(
      node,
      target
        ? makeNode(target, "module", "ts/js", target)
        : makeNode(
            `${status}:ts:${dep.specifier}`,
            status === "external" ? "external" : "unresolved",
            "ts/js",
            undefined,
            dep.specifier,
          ),
      dep,
      status,
      target
        ? "TypeScript 6.0.3 captured-config module resolution"
        : status === "external"
          ? "Declared external package; target not resolved"
          : "Unresolved literal/computed source dependency",
    );
  }
  const classIndex = new Map<string, typeof java>();
  for (const item of java) {
    const list = classIndex.get(item.unit.name) ?? [];
    list.push(item);
    classIndex.set(item.unit.name, list);
  }
  for (const item of java) {
    for (const dep of item.unit.references) {
      const candidates = new Set<string>();
      const spec = dep.specifier;
      if (classIndex.has(spec)) candidates.add(spec);
      const inPackage = item.unit.packageName
        ? `${item.unit.packageName}.${spec}`
        : spec;
      if (classIndex.has(inPackage)) candidates.add(inPackage);
      const nested = `${item.unit.name}.${spec}`;
      if (classIndex.has(nested)) candidates.add(nested);
      for (const imp of item.unit.references.filter(
        (d) => d.kind === "import",
      )) {
        if (imp.specifier.endsWith(".*")) {
          const full = imp.specifier.slice(0, -1) + spec;
          if (classIndex.has(full)) candidates.add(full);
        } else {
          const short = imp.specifier.split(".").at(-1)!;
          if (spec === short || spec.startsWith(short + ".")) {
            const full = imp.specifier + spec.slice(short.length);
            if (classIndex.has(full)) candidates.add(full);
          }
        }
      }
      // Static imports may name a member; resolve only a unique declared source owner.
      if (dep.kind === "import" && !spec.endsWith(".*")) {
        let prefix = spec;
        while (prefix.includes(".")) {
          prefix = prefix.slice(0, prefix.lastIndexOf("."));
          if (classIndex.has(prefix)) {
            candidates.add(prefix);
            break;
          }
        }
      }
      const names = [...candidates],
        matches = names.length === 1 ? (classIndex.get(names[0]) ?? []) : [];
      const target = matches.length === 1 ? matches[0].node : undefined;
      if (target?.id === item.node.id) continue;
      const status = target
        ? "resolved"
        : /^(?:java|javax|jdk)\./.test(spec)
          ? "external"
          : "unresolved";
      addEdge(
        item.node,
        target ??
          makeNode(
            `${status}:java:${spec}`,
            status === "external" ? "external" : "unresolved",
            "java",
            undefined,
            spec,
          ),
        dep,
        status,
        target
          ? "Tree-sitter Java source declarations, package/import/type context"
          : status === "external"
            ? "Declared platform dependency; classpath not inspected"
            : "Unresolved or ambiguous Java source reference; no classpath execution",
      );
    }
  }
  const nodeValues = [...nodes.values()],
    cycles = graphCycles(
      nodeValues.map((n) => n.id),
      edges.filter((e) => e.status === "resolved"),
    );
  progress?.({
    phase: "saving",
    completed: scanned,
    total: eligible.length,
    bytes,
  });
  return {
    version: 1,
    snapshotId: snapshot.id,
    side: options.side,
    revision: source.revision,
    capturedAt: new Date().toISOString(),
    options,
    nodes: nodeValues,
    edges,
    cycles,
    coverage: {
      listed: source.paths.length,
      eligible: eligible.length,
      scanned,
      skipped: eligible.length - scanned,
      bytes,
      parserFailures,
      unresolved: edges.filter((e) => e.status === "unresolved").length,
      incoming: "scanned sources only",
      complete:
        source.complete &&
        scanned === eligible.length &&
        !parserFailures &&
        !omissions.length &&
        !warnings.some((w) =>
          /cap reached|limit reached|Missing captured|Unsupported|Invalid/.test(
            w,
          ),
        ),
      omissions,
      warnings: [...new Set(warnings)],
    },
    provenance: {
      typescript: "TypeScript 6.0.3 source/module resolver",
      java: "Tree-sitter Java 0.20.2 grammar via tree-sitter-wasms 0.1.13 / runtime 0.20.8",
      configuration,
    },
  };
}
