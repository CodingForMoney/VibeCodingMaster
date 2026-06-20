import type { DispatchableRole, RoleName } from "./role.js";

export type ArtifactKind =
  | "architecture-plan"
  | "known-issues"
  | "review-report"
  | "docs-sync-report"
  | "final-acceptance";

export interface HandoffPaths {
  handoffDir: string;
  roleCommandsDir: string;
  logsDir: string;
  messagesDir: string;
  roleCommandPaths: Record<DispatchableRole, string>;
  roleLogPaths: Partial<Record<RoleName, string>>;
  messageRoutePaths: Record<string, string>;
  architecturePlanPath: string;
  knownIssuesPath: string;
  reviewReportPath: string;
  docsSyncReportPath: string;
  finalAcceptancePath: string;
}

export interface ArtifactCheckResult {
  kind: ArtifactKind;
  path: string;
  exists: boolean;
  isEmpty: boolean;
  hasPlaceholder: boolean;
  missingHeadings: string[];
  status: "missing" | "empty" | "incomplete" | "ok";
}

export interface ArtifactSummary {
  paths: HandoffPaths;
  checks: ArtifactCheckResult[];
}
