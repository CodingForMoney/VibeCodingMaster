import type { DispatchableRole } from "./role.js";

export type ArtifactKind =
  | "architecture-brief"
  | "architecture-plan"
  | "known-issues"
  | "test-report"
  | "docs-sync-report"
  | "final-acceptance";

export interface HandoffPaths {
  handoffDir: string;
  roleCommandsDir: string;
  messagesDir: string;
  roleCommandPaths: Record<DispatchableRole, string>;
  messageRoutePaths: Record<string, string>;
  architectureBriefPath: string;
  architecturePlanPath: string;
  knownIssuesPath: string;
  testReportPath: string;
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
  invalidFields: string[];
  status: "missing" | "empty" | "incomplete" | "ok";
}

export interface ArtifactSummary {
  paths: HandoffPaths;
  checks: ArtifactCheckResult[];
}
