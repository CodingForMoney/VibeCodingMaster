import type { DispatchableRole, RoleName } from "./role.js";

export type ArtifactKind =
  | "architecture-plan"
  | "implementation-log"
  | "validation-log"
  | "review-report"
  | "docs-sync-report";

export interface HandoffPaths {
  handoffDir: string;
  roleCommandsDir: string;
  logsDir: string;
  messagesDir: string;
  roleCommandPaths: Record<DispatchableRole, string>;
  roleLogPaths: Record<RoleName, string>;
  messageRoutePaths: Record<string, string>;
  architecturePlanPath: string;
  implementationLogPath: string;
  validationLogPath: string;
  reviewReportPath: string;
  docsSyncReportPath: string;
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
