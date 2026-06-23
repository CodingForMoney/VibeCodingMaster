import type { ClaudePermissionMode, SessionEffort, SessionModel } from "./session.js";

export type HarnessFileKind =
  | "root-claude"
  | "gitignore"
  | "claude-settings"
  | "pull-request-template"
  | "skill-vcm-final-acceptance"
  | "skill-vcm-harness-bootstrap"
  | "skill-vcm-long-running-validation"
  | "skill-vcm-route-message"
  | "skill-vcm-gate-review"
  | "skill-vcm-report-harness-issue"
  | "agent-gate-reviewer"
  | "agent-translator"
  | "agent-harness-engineer"
  | "tool-request-gate-review"
  | "agent-project-manager"
  | "agent-architect"
  | "agent-coder"
  | "agent-reviewer";

export type HarnessFileAction = "create" | "insert" | "update" | "delete" | "ok";
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

export interface HarnessTaskRequest {
  taskSlug: string;
}

export interface HarnessStatusReport {
  version: number;
  harnessRevision: number;
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

export type RepositoryDiffFileStatus = "added" | "copied" | "deleted" | "modified" | "renamed" | "untracked" | "unknown";
export type RepositoryDiffFileStage = "committed" | "staged" | "unstaged" | "staged_and_unstaged" | "untracked";
export type RepositoryDiffFileCategory =
  | "fixed_harness"
  | "tools_hooks"
  | "generated_context"
  | "project_docs"
  | "product_code";

export interface RepositoryDiffFile {
  path: string;
  oldPath?: string;
  status: RepositoryDiffFileStatus;
  stage: RepositoryDiffFileStage;
  category: RepositoryDiffFileCategory;
  diff: string;
  binary: boolean;
  truncated: boolean;
  additions: number;
  deletions: number;
}

export interface RepositoryDiffSummary {
  totalFiles: number;
  committedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  additions: number;
  deletions: number;
  harnessFiles: number;
  productCodeFiles: number;
  truncatedFiles: number;
  binaryFiles: number;
}

export interface RepositoryDiffCommit {
  sha: string;
  shortSha: string;
  subject: string;
  committedAt?: string;
}

export interface RepositoryDiffReport {
  version: 1;
  repoRoot: string;
  generatedAt: string;
  commits: RepositoryDiffCommit[];
  commit?: RepositoryDiffCommit;
  summary: RepositoryDiffSummary;
  files: RepositoryDiffFile[];
  warnings: string[];
}

export interface HarnessFileContent {
  path: string;
  kind: HarnessFileKind;
  title: string;
  content: string;
  editable: boolean;
  readonlyReason?: string;
}

export interface UpdateHarnessFileContentRequest {
  taskSlug?: string;
  content: string;
}

export interface UpdateHarnessFileContentResult {
  file: HarnessFileContent;
  status: HarnessStatusReport;
  harnessCommit?: string;
}

export interface HarnessApplyResult {
  version: number;
  changedFiles: HarnessPlannedChange[];
  harnessCommit?: string;
  message: string;
}

export type HarnessApplyRequest = HarnessTaskRequest;

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
  permissionMode?: ClaudePermissionMode;
  model?: SessionModel;
  effort?: SessionEffort;
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
  taskSlug?: string;
  cols?: number;
  rows?: number;
  permissionMode?: ClaudePermissionMode;
  model?: SessionModel;
  effort?: SessionEffort;
}

export interface StartHarnessBootstrapResult {
  status: HarnessBootstrapStatusReport;
  session: HarnessBootstrapSession;
  prompt: string;
}

export type RestartHarnessBootstrapRequest = StartHarnessBootstrapRequest;

export interface RunHarnessBootstrapResult {
  status: HarnessBootstrapStatusReport;
  session: HarnessBootstrapSession;
  prompt: string;
  targetRepoRoot?: string;
}

export interface RecordHarnessBootstrapHookInput {
  eventName: "Stop" | "StopFailure" | "UserPromptSubmit" | "PostCompact";
  sessionId?: string;
  claudeSessionId?: string;
}

export type HarnessFeedbackStatus =
  | "idle"
  | "queued"
  | "analyzing"
  | "awaiting_user_approval"
  | "applying";

export interface HarnessFeedbackQueueItem {
  id: string;
  title: string;
  path: string;
  reporterRole?: string;
  taskSlug?: string;
  summary?: string;
}

export interface HarnessFeedbackActiveItem extends HarnessFeedbackQueueItem {
  status: Exclude<HarnessFeedbackStatus, "idle" | "queued">;
  startedAt?: string;
  updatedAt?: string;
  feedbackContent: string;
  analysisPath?: string;
  analysisContent?: string;
  applyReportPath?: string;
  applyReportContent?: string;
}

export interface HarnessFeedbackStateReport {
  version: 1;
  status: HarnessFeedbackStatus;
  queuedCount: number;
  pending: HarnessFeedbackQueueItem[];
  active?: HarnessFeedbackActiveItem;
  warnings: string[];
}

export interface HarnessFeedbackDecisionRequest {
  taskSlug?: string;
  action: "approve" | "reject" | "comment";
  comment?: string;
}
