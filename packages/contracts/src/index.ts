import { z } from "zod";
export const comparisonSchema = z.object({
  mode: z.enum(["unstaged", "staged", "all", "branch"]),
  base: z.string().min(1).max(200).default("main"),
});
export type Comparison = z.infer<typeof comparisonSchema>;
export type Content =
  | { kind: "text"; text: string }
  | {
      kind: "absent" | "binary" | "oversized" | "unavailable";
      reason?: string;
    };
export type FileChange = {
  id: string;
  path: string;
  oldPath: string;
  status: "added" | "modified" | "deleted" | "renamed";
  before: Content;
  after: Content;
  fingerprint: string;
  patch: string;
};
export type Snapshot = {
  id: string;
  sessionId: string;
  capturedAt: string;
  root: string;
  comparison: Comparison;
  head: string | null;
  base: string | null;
  files: FileChange[];
  complete: boolean;
};
export const layerSchema = z.object({
  name: z.string().min(1).max(100),
  explanation: z.string().max(2000),
  fileIds: z.array(z.string()),
});
export const analysisSchema = z.object({
  cohorts: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        explanation: z.string().max(2000),
        layers: z.array(layerSchema).min(1),
      }),
    )
    .min(1),
  findings: z.array(
    z.object({
      fileId: z.string(),
      line: z.number().int().positive().nullable(),
      kind: z.enum(["bug", "security", "performance", "improvement"]),
      message: z.string().min(1).max(4000),
    }),
  ),
});
export type Analysis = z.infer<typeof analysisSchema>;
export type Draft = {
  id: string;
  fileId: string;
  path: string;
  side: "before" | "after";
  line: number;
  text: string;
  needsReattachment: boolean;
};
export type ReviewState = {
  reviewed: string[];
  accepted: Analysis | null;
  proposal: Analysis | null;
  drafts: Draft[];
  analysisStatus:
    "idle" | "running" | "ready" | "failed" | "canceled" | "interrupted";
  analysisError?: string;
  manifest?: Manifest;
};
export type Review = {
  snapshot: Snapshot;
  state: ReviewState;
  history: { id: string; capturedAt: string }[];
};
export type SessionSummary = {
  id: string;
  name: string;
  root: string;
  updatedAt: string;
};
export const providerSchema = z.object({
  provider: z.enum(["ollama", "openai", "anthropic"]),
  endpoint: z.string().url(),
  model: z.string().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(2000000),
  maxOutput: z.number().int().min(256).max(128000),
  localOnly: z.boolean().default(false),
});
export type ProviderConfig = z.infer<typeof providerSchema>;
export type Manifest = {
  id: string;
  snapshotId: string;
  config: ProviderConfig;
  files: { id: string; path: string; included: boolean; reason?: string }[];
  estimatedTokens: number;
  inputBudget: number;
};
export const emptyState = (): ReviewState => ({
  reviewed: [],
  accepted: null,
  proposal: null,
  drafts: [],
  analysisStatus: "idle",
});
