import type { ArtifactSummary } from "./artifact.js";
import type { SendRoleMessageResult } from "./message.js";
import type { ProjectSummary } from "./project.js";
import type { DispatchableRole, RoleName } from "./role.js";
import type { RoleSessionRecord } from "./session.js";
import type { TaskRecord } from "./task.js";

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
  workflow: TaskWorkflowReport;
  warnings: string[];
}

export type TaskWorkflowStepId =
  | "architecture-plan"
  | "implementation"
  | "review"
  | "docs-sync"
  | "final-acceptance";

export type TaskWorkflowStepStatus = "pending" | "blocked" | "ready" | "complete";

export interface TaskWorkflowStep {
  id: TaskWorkflowStepId;
  label: string;
  status: TaskWorkflowStepStatus;
  detail: string;
  role?: RoleName;
  artifactPaths: string[];
}

export interface TaskWorkflowReport {
  currentStepId: TaskWorkflowStepId;
  nextAction: string;
  blocked: boolean;
  steps: TaskWorkflowStep[];
}

export interface DispatchRoleCommandResult {
  taskSlug: string;
  role: DispatchableRole;
  commandPath: string;
  instruction: string;
  dispatchedAt: string;
}

export type { SendRoleMessageResult };

export interface BootstrapState {
  project: ProjectSummary | null;
  tasks: TaskRecord[];
}
