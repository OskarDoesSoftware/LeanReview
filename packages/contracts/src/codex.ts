export type CodexWindow = {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
};
export type CodexLimit = {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  rateLimitReachedType?: string | null;
};
export type CodexStatus = {
  connected: boolean;
  email?: string | null;
  plan?: string;
  loginPending: boolean;
  loginError?: string;
  models: { model: string; displayName: string; isDefault: boolean }[];
  limits: CodexLimit[];
  usageError?: string;
};
