export type HarnessFileKind =
  | "root-claude"
  | "gitignore"
  | "claude-settings"
  | "pull-request-template"
  | "skill-vcm-final-acceptance"
  | "skill-vcm-harness-bootstrap"
  | "skill-vcm-long-running-validation"
  | "skill-vcm-route-message"
  | "skill-vcm-codex-review-gate"
  | "codex-agents"
  | "codex-config"
  | "codex-cli-config"
  | "codex-hooks"
  | "codex-translator-agents"
  | "codex-translator-config"
  | "codex-translator-cli-config"
  | "codex-translator-hooks"
  | "codex-prompt-architecture-plan"
  | "codex-prompt-validation-adequacy"
  | "codex-prompt-final-diff"
  | "codex-review-schema"
  | "tool-request-codex-review"
  | "agent-project-manager"
  | "agent-architect"
  | "agent-coder"
  | "agent-reviewer";

export type HarnessFileAction = "create" | "insert" | "update" | "ok";
export type HarnessBootstrapCheckStatus = "ok" | "missing" | "incomplete" | "unknown";
export type HarnessBootstrapStatus = "not_ready" | "not_started" | "incomplete" | "running" | "complete";

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
  /**
   * Whether the VCM harness has already been installed in the target repo.
   *
   * Single source of truth for the UI "project initialized" judgement. Derived
   * by the backend (see renderHarnessStatus in harness-service.ts): true when at
   * least one VCM-exclusive marker is present (a managed block exists, or a
   * VCM-owned whole-file/raw-file harness file exists). Independent of needsApply:
   * an initialized project may still have pending updates.
   *
   * UI contract (HarnessPanel "Fixed install" stage):
   * - initialized === false              -> hide file list, show only "Initialize".
   * - initialized && needsApply          -> show update file list + "Update" button.
   * - initialized && !needsApply         -> show "Up to date", no file list, no apply button.
   */
  initialized: boolean;
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

export interface HarnessBootstrapCheck {
  key:
    | "fixed-harness"
    | "project-context"
    | "module-index"
    | "public-surface"
    | "project-architecture"
    | "module-architecture"
    | "testing-doc";
  label: string;
  status: HarnessBootstrapCheckStatus;
  path?: string;
  detail?: string;
}

export interface HarnessBootstrapSession {
  id: string;
  claudeSessionId: string;
  status: "running" | "exited" | "crashed" | "resumable";
  command: string;
  cwd: string;
  logPath: string;
  startedAt?: string;
  updatedAt: string;
  lastOutputAt?: string;
  exitCode?: number | null;
}

export interface HarnessBootstrapStatusReport {
  status: HarnessBootstrapStatus;
  canStart: boolean;
  checks: HarnessBootstrapCheck[];
  session?: HarnessBootstrapSession;
  warnings: string[];
}

export interface StartHarnessBootstrapRequest {
  cols?: number;
  rows?: number;
}

export interface StartHarnessBootstrapResult {
  status: HarnessBootstrapStatusReport;
  session: HarnessBootstrapSession;
  prompt: string;
}
