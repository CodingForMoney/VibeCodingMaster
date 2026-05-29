import type { TaskRecord } from "../../shared/types/task.js";
import { StatusBadge } from "./status-badge.js";

export interface TaskNavProps {
  tasks: TaskRecord[];
  activeTaskSlug: string | null;
  onSelect(taskSlug: string): void;
}

export function TaskNav({ tasks, activeTaskSlug, onSelect }: TaskNavProps) {
  return (
    <nav className="task-nav" aria-label="Tasks">
      {tasks.map((task) => (
        <button
          className={task.taskSlug === activeTaskSlug ? "task-nav-item is-active" : "task-nav-item"}
          key={task.taskSlug}
          type="button"
          onClick={() => onSelect(task.taskSlug)}
        >
          <span>{task.title || task.taskSlug}</span>
          <StatusBadge status={task.status === "created" ? "unknown" : "running"} />
        </button>
      ))}
    </nav>
  );
}
