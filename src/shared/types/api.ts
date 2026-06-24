import type { ArtifactSummary } from "./artifact.js";
import type { HarnessBootstrapStatusReport, HarnessFeedbackStateReport, HarnessStatusReport } from "./harness.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "./message.js";
import type { ProjectSummary } from "./project.js";
import type { DispatchableRole } from "./role.js";
import type { VcmSessionRoundState } from "./round.js";
import type { RoleSessionRecord } from "./session.js";
import type { TaskRecord } from "./task.js";
import type { TranslationState } from "./translation.js";

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

export interface TaskStatusReport {
  task: TaskRecord;
  sessions: RoleSessionRecord[];
  artifacts: ArtifactSummary;
  warnings: string[];
}

export interface TaskWorkspaceState {
  taskStatus: TaskStatusReport;
  messages: VcmRoleMessage[];
  orchestration: VcmOrchestrationState;
  roundState: VcmSessionRoundState;
}

export interface ProjectRuntimeState {
  translatorSession: RoleSessionRecord | null;
  translationState: TranslationState | null;
  harnessEngineerSession: RoleSessionRecord | null;
  harnessStatus: HarnessStatusReport | null;
  harnessBootstrapStatus: HarnessBootstrapStatusReport | null;
  harnessFeedbackState: HarnessFeedbackStateReport | null;
}

export interface DispatchRoleCommandResult {
  taskSlug: string;
  role: DispatchableRole;
  commandPath: string;
  instruction: string;
  dispatchedAt: string;
}

export interface BootstrapState {
  project: ProjectSummary | null;
  tasks: TaskRecord[];
}
