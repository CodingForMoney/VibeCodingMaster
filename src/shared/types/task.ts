import type { VcmOrchestrationState } from "./message.js";
import type { RoleName } from "./role.js";
import type { RoleSessionRecord } from "./session.js";

export type TaskStatus =
  | "created"
  | "running"
  | "stopped";

export interface TaskRecord {
  version: 1;
  taskSlug: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  handoffDir: string;
  status: TaskStatus;
  specPath?: string;
  cleanupStatus?: "active" | "cleaned";
  cleanedAt?: string;
}

export interface CreateTaskRequest {
  taskSlug: string;
  title?: string;
  specPath?: string;
}

export interface CleanupTaskRequest {
  force?: boolean;
  forceDeleteBranch?: boolean;
}

export interface CleanupTaskResult {
  taskSlug: string;
  removedWorktreePath: string;
  removedStatePaths: string[];
  deletedBranch: string;
  cleanedAt: string;
}

/**
 * Result of the backend-owned one-click start for a task: the orchestration mode
 * applied from the launch template, the canonical roles that were started/resumed
 * (CORE roles plus gate-reviewer when gate review is enabled), and the resulting
 * role sessions. Returned by `POST /api/tasks/:taskSlug/one-click-start` and the
 * shared backend launch method that both the GUI endpoint and the gateway call.
 * A per-role failure surfaces as a `TASK_ONE_CLICK_PARTIAL_START` error instead.
 */
export interface OneClickStartTaskResult {
  taskSlug: string;
  orchestration: VcmOrchestrationState;
  startedRoles: RoleName[];
  sessions: RoleSessionRecord[];
}
