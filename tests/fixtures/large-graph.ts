import type { ModuleGraph } from "../../packages/contracts/src/graph";
export function largeJavaGraph(): ModuleGraph {
  const nodes: ModuleGraph["nodes"] = [];
  const edges: ModuleGraph["edges"] = [];
  for (let i = 0; i < 600; i++) {
    const label = `com.example.product.area${Math.floor(i / 60)}.feature${i}`;
    nodes.push({
      id: `package:${label}`,
      label,
      kind: "package",
      language: "java",
      changed: false,
    });
    nodes.push({
      id: `class:${i}`,
      label: `${label}.Service`,
      packageId: `package:${label}`,
      kind: "class",
      language: "java",
      path: `src/Service${i}.java`,
      changed: false,
    });
    for (let j = 1; j <= 20; j++)
      edges.push({
        id: `${i}:${j}`,
        source: `class:${i}`,
        target: `class:${(i + j * 13) % 600}`,
        kind: "type-reference",
        status: "resolved",
        typeOnly: false,
        path: `src/Service${i}.java`,
        line: j,
        specifier: "Service",
        resolver: "fixture",
      });
  }
  return {
    version: 1,
    snapshotId: "large",
    side: "after",
    revision: "fixture",
    capturedAt: "2026-10-15",
    options: { side: "after", maxFiles: 10000, maxBytes: 20000000 },
    nodes,
    edges,
    cycles: [],
    coverage: {
      listed: 600,
      eligible: 600,
      scanned: 600,
      skipped: 0,
      bytes: 1000000,
      parserFailures: 0,
      unresolved: 0,
      incoming: "scanned sources only",
      complete: true,
      omissions: [],
      warnings: [],
    },
    provenance: { java: "fixture", typescript: "fixture", configuration: [] },
  };
}
export const largeOptions = {
  scope: "repository" as const,
  query: "",
  showExternal: false,
  showTypeOnly: true,
  expanded: [],
  javaPackage: null,
  collapseCycles: false,
  limit: 200,
  groupModules: true,
};
