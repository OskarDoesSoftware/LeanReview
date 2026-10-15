import { z } from "zod";
export const graphOptionsSchema = z.object({
  side: z.enum(["before", "after"]).default("after"),
  maxFiles: z.number().int().min(1).max(50000).default(10000),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024)
    .default(20 * 1024 * 1024),
});
export type GraphOptions = z.infer<typeof graphOptionsSchema>;
export type PinnedInventory = {
  revision: string;
  complete: boolean;
  entries: { path: string; oid: string; mode: string }[];
};
export type GraphNode = {
  id: string;
  label: string;
  kind: "module" | "class" | "package" | "external" | "unresolved";
  language: "ts/js" | "java";
  path?: string;
  packageId?: string;
  fileId?: string;
  changed: boolean;
  line?: number;
};
export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "import" | "re-export" | "require" | "dynamic" | "type-reference";
  typeOnly: boolean;
  status: "resolved" | "external" | "unresolved";
  path: string;
  line: number;
  specifier: string;
  resolver: string;
};
export type ModuleGraph = {
  version: 1;
  snapshotId: string;
  side: "before" | "after";
  revision: string;
  capturedAt: string;
  options: GraphOptions;
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: string[][];
  coverage: {
    listed: number;
    eligible: number;
    scanned: number;
    skipped: number;
    bytes: number;
    parserFailures: number;
    unresolved: number;
    incoming: "scanned sources only";
    complete: boolean;
    omissions: { path: string; reason: string }[];
    warnings: string[];
  };
  provenance: { typescript: string; java: string; configuration: string[] };
};
export type GraphRun = {
  status: "running" | "succeeded" | "failed" | "canceled" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  error?: string;
};
