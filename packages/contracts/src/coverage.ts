import { z } from "zod";
export const testStepSchema = z.object({
  executable: z.string().trim().min(1).max(2000),
  args: z.array(z.string().max(4000)).max(100),
  shell: z.boolean().default(false),
});
export const testConfigSchema = z.object({
  format: z.enum(["istanbul", "jacoco"]),
  cwd: z.string().min(1).max(1000).default("."),
  reportPath: z.string().min(1).max(1000),
  timeoutSeconds: z.number().int().min(1).max(3600).default(600),
  threshold: z.number().min(0).max(1000000).default(8),
  steps: z.array(testStepSchema).min(1).max(6),
});
export type TestConfig = z.infer<typeof testConfigSchema>;
export const provenanceSchema = z.object({
  version: z.literal(1),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  tool: z.string().min(1).max(200),
  capturedAt: z.string(),
  head: z.string().nullable(),
});
export type CoverageProvenance = z.infer<typeof provenanceSchema>;
export type FunctionMetric = {
  id: string;
  name: string;
  line: number;
  complexity: number | null;
  coverage: number | null;
  crap: number | null;
  reason?: string;
};
export type FileMetrics = {
  fileId: string;
  path: string;
  language: "ts/js" | "java";
  convention: string;
  functions: FunctionMetric[];
  reason?: string;
};
export type CoverageMetrics = {
  snapshotId: string;
  format: "istanbul" | "jacoco";
  capturedAt: string;
  reportHash: string | null;
  aligned: boolean;
  files: FileMetrics[];
  warnings: string[];
  threshold: number;
  highest: number | null;
  measured: number;
  missing: number;
  aboveThreshold: number;
};
export type TestRun = {
  id: string;
  snapshotId: string;
  config: TestConfig;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed" | "canceled" | "interrupted";
  log: string;
  error?: string;
  metrics?: CoverageMetrics;
  provenance?: CoverageProvenance;
};
export type TestPreview = {
  id: string;
  snapshotId: string;
  config: TestConfig;
  root: string;
  workingDirectory: string;
  sourceCount: number;
  expiresAt: string;
};
export type CoverageView = {
  config: TestConfig | null;
  metrics: CoverageMetrics;
  run: TestRun | null;
};
