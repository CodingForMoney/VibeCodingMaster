import type { ProjectSummary } from "../../shared/types/project.js";
import type { TaskRecord } from "../../shared/types/task.js";

export interface AppStateSnapshot {
  project: ProjectSummary | null;
  tasks: TaskRecord[];
  activeTaskSlug: string | null;
}

export function selectActiveTask(tasks: TaskRecord[], activeTaskSlug: string | null): TaskRecord | null {
  return tasks.find((task) => task.taskSlug === activeTaskSlug) ?? tasks[0] ?? null;
}
