import { FormEvent, useState } from "react";
import type { HarnessApplyResult, HarnessStatusReport } from "../../shared/types/harness.js";
import type { ProjectSummary } from "../../shared/types/project.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { HarnessPanel } from "../components/harness-panel.js";
import { RepoConnectForm } from "../components/repo-connect-form.js";
import { TaskNav } from "../components/task-nav.js";

export interface ProjectDashboardProps {
  project: ProjectSummary | null;
  tasks: TaskRecord[];
  activeTaskSlug: string | null;
  harnessStatus: HarnessStatusReport | null;
  harnessApplyResult?: HarnessApplyResult | null;
  busy?: boolean;
  onConnect(repoPath: string): Promise<void>;
  onRefreshHarness(): Promise<void>;
  onApplyHarness(): Promise<void>;
  onCreateTask(input: { taskSlug: string; title?: string }): Promise<void>;
  onSelectTask(taskSlug: string): void;
}

export function ProjectDashboard({
  project,
  tasks,
  activeTaskSlug,
  harnessStatus,
  harnessApplyResult,
  busy,
  onConnect,
  onRefreshHarness,
  onApplyHarness,
  onCreateTask,
  onSelectTask
}: ProjectDashboardProps) {
  const [taskSlug, setTaskSlug] = useState("");
  const [title, setTitle] = useState("");

  async function handleCreateTask(event: FormEvent) {
    event.preventDefault();
    await onCreateTask({
      taskSlug,
      title: title.trim() || undefined
    });
    setTaskSlug("");
    setTitle("");
  }

  return (
    <div className="project-dashboard">
      <header className="brand-header">
        <strong>VibeCodingMaster</strong>
        <span>Session Cockpit</span>
      </header>

      <RepoConnectForm
        defaultPath={project?.repoRoot ?? ""}
        busy={busy}
        onConnect={onConnect}
      />

      {project ? (
        <section className="project-summary">
          <h2>Repository</h2>
          <dl>
            <div>
              <dt>Path</dt>
              <dd>{project.repoRoot}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{project.branch}</dd>
            </div>
            <div>
              <dt>Dirty</dt>
              <dd>{project.isDirty ? "yes" : "no"}</dd>
            </div>
          </dl>
          {project.warnings.length > 0 ? (
            <ul className="warnings">
              {project.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {project ? (
        <HarnessPanel
          status={harnessStatus}
          applyResult={harnessApplyResult}
          busy={busy}
          onRefresh={onRefreshHarness}
          onApply={onApplyHarness}
        />
      ) : null}

      {project ? (
        <section className="task-create">
          <h2>New Task</h2>
          <form onSubmit={handleCreateTask}>
            <input
              value={taskSlug}
              onChange={(event) => setTaskSlug(event.target.value)}
              placeholder="task-slug"
            />
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Optional title"
            />
            <button type="submit" disabled={busy || !taskSlug.trim()}>
              Create
            </button>
          </form>
        </section>
      ) : null}

      {tasks.length > 0 ? (
        <section>
          <h2>Tasks</h2>
          <TaskNav tasks={tasks} activeTaskSlug={activeTaskSlug} onSelect={onSelectTask} />
        </section>
      ) : null}
    </div>
  );
}
