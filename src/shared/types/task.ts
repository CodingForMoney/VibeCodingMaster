export type TaskStatus =
  | "created"
  | "planning"
  | "running"
  | "blocked"
  | "stopped"
  | "done";

export interface TaskRecord {
  version: 1;
  taskSlug: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  repoRoot: string;
  branch: string;
  handoffDir: string;
  status: TaskStatus;
  specPath?: string;
}

export interface CreateTaskRequest {
  taskSlug: string;
  title?: string;
  specPath?: string;
}
