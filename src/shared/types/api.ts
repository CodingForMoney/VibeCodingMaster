import type { ArtifactSummary } from "./artifact.js";
import type { ProjectSummary } from "./project.js";
import type { DispatchableRole } from "./role.js";
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
  warnings: string[];
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
