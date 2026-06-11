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
  worktreePath?: string;
  branch: string;
  handoffDir: string;
  status: TaskStatus;
  specPath?: string;
  cleanupStatus?: "active" | "cleaned";
  cleanedAt?: string;
}

export interface CreateTaskRequest {
  taskSlug: string;
  createWorktree?: boolean;
  title?: string;
  specPath?: string;
}

export interface CleanupTaskRequest {
  force?: boolean;
  deleteBranch?: boolean;
  forceDeleteBranch?: boolean;
}

export interface CleanupTaskResult {
  taskSlug: string;
  removedWorktreePath?: string;
  removedStatePaths: string[];
  deletedBranch?: string;
  cleanedAt: string;
}
