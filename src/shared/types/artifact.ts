import type { DispatchableRole, RoleName } from "./role.js";

export type ArtifactKind =
  | "architecture-plan"
  | "implementation-log"
  | "validation-log"
  | "review-report";

export interface HandoffPaths {
  handoffDir: string;
  roleCommandsDir: string;
  logsDir: string;
  roleCommandPaths: Record<DispatchableRole, string>;
  roleLogPaths: Record<RoleName, string>;
  architecturePlanPath: string;
  implementationLogPath: string;
  validationLogPath: string;
  reviewReportPath: string;
}

export interface ArtifactCheckResult {
  kind: ArtifactKind;
  path: string;
  exists: boolean;
  isEmpty: boolean;
  missingHeadings: string[];
  status: "missing" | "empty" | "incomplete" | "ok";
}

export interface ArtifactSummary {
  paths: HandoffPaths;
  checks: ArtifactCheckResult[];
}
