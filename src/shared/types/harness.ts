export type HarnessFileKind =
  | "root-claude"
  | "gitignore"
  | "claude-settings"
  | "docs-known-issues"
  | "pull-request-template"
  | "skill-vcm-final-acceptance"
  | "skill-vcm-harness-bootstrap"
  | "skill-vcm-harness-maintenance"
  | "skill-vcm-long-running-validation"
  | "skill-vcm-route-message"
  | "agent-project-manager"
  | "agent-architect"
  | "agent-coder"
  | "agent-reviewer";

export type HarnessFileAction = "create" | "insert" | "update" | "ok";

export interface HarnessFileStatus {
  kind: HarnessFileKind;
  path: string;
  exists: boolean;
  hasManagedBlock: boolean;
  managedVersion?: number;
  action: HarnessFileAction;
}

export interface HarnessPlannedChange {
  path: string;
  action: HarnessFileAction;
  reason: string;
}

export interface HarnessStatusReport {
  version: number;
  files: HarnessFileStatus[];
  needsApply: boolean;
  plannedChanges: HarnessPlannedChange[];
  warnings: string[];
}

export interface HarnessApplyResult {
  version: number;
  changedFiles: HarnessPlannedChange[];
  message: string;
}
