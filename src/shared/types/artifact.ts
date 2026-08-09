import type { DispatchableRole } from "./role.js";

export type ArtifactKind =
  | "architecture-brief"
  | "architecture-evidence"
  | "planning-progress"
  | "architecture-plan"
  | "known-issues"
  | "coder-completion"
  | "architect-debug"
  | "architecture-diagnosis"
  | "test-report"
  | "docs-update-report"
  | "docs-sync-report"
  | "workflow-progress"
  | "final-acceptance";

export type DynamicArtifactKind =
  | "route-message"
  | "coder-worker-report"
  | "gate-review-report"
  | "memory-proposal"
  | "harness-feedback"
  | "retrospective-report";

export type ManagedArtifactKind = ArtifactKind | DynamicArtifactKind;
export type ArtifactSubmissionMode = "draft" | "final";

export interface HandoffPaths {
  handoffDir: string;
  roleCommandsDir: string;
  messagesDir: string;
  roleCommandPaths: Record<DispatchableRole, string>;
  messageRoutePaths: Record<string, string>;
  architectureBriefPath: string;
  architectureEvidencePath: string;
  planningProgressPath: string;
  architecturePlanPath: string;
  knownIssuesPath: string;
  coderCompletionPath: string;
  architectDebugPath: string;
  architectureDiagnosisPath: string;
  testReportPath: string;
  docsUpdateReportPath: string;
  docsSyncReportPath: string;
  workflowProgressPath: string;
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

export interface ArtifactSubmissionRequest {
  kind: ManagedArtifactKind;
  mode: ArtifactSubmissionMode;
  role: string;
  runtimeSessionToken?: string;
  content: string;
  path?: string;
}

export interface ArtifactSubmissionResult {
  ok: true;
  kind: ManagedArtifactKind;
  mode: ArtifactSubmissionMode;
  path: string;
  status: ArtifactCheckResult["status"] | "accepted";
}

export interface ArtifactSummary {
  paths: HandoffPaths;
  checks: ArtifactCheckResult[];
}
