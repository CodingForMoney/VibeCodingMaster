import type { RoleName } from "./role.js";

export interface UsageAnalyticsTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  requestCount: number;
  sessionCount: number;
}

export interface UsageAnalyticsRoleSummary extends UsageAnalyticsTotals {
  role: RoleName;
}

export interface UsageAnalyticsModelSummary extends UsageAnalyticsTotals {
  model: string;
}

export interface TaskUsageAnalyticsReport {
  version: 1;
  taskSlug: string;
  updatedAt: string | null;
  totals: UsageAnalyticsTotals;
  byRole: UsageAnalyticsRoleSummary[];
  byModel: UsageAnalyticsModelSummary[];
}
