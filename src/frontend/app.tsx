import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "../shared/types/project.js";
import type { TaskRecord } from "../shared/types/task.js";
import { AppShell } from "./components/app-shell.js";
import { selectActiveTask } from "./state/app-store.js";
import { apiClient } from "./state/api-client.js";
import { ProjectDashboard } from "./routes/project-dashboard.js";
import { TaskWorkspace } from "./routes/task-workspace.js";

export function App() {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [activeTaskSlug, setActiveTaskSlug] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activeTask = useMemo(
    () => selectActiveTask(tasks, activeTaskSlug),
    [tasks, activeTaskSlug]
  );

  async function loadTasks() {
    const nextTasks = await apiClient.listTasks();
    setTasks(nextTasks);
    setActiveTaskSlug((current) => current ?? nextTasks[0]?.taskSlug ?? null);
  }

  useEffect(() => {
    apiClient.getCurrentProject()
      .then(async (currentProject) => {
        setProject(currentProject);
        if (currentProject) {
          await loadTasks();
        }
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  async function withBusy(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      sidebar={(
        <ProjectDashboard
          project={project}
          tasks={tasks}
          activeTaskSlug={activeTask?.taskSlug ?? null}
          busy={busy}
          onConnect={(repoPath) => withBusy(async () => {
            const nextProject = await apiClient.connectProject({ repoPath });
            setProject(nextProject);
            await loadTasks();
          })}
          onCreateTask={(input) => withBusy(async () => {
            const task = await apiClient.createTask(input);
            await loadTasks();
            setActiveTaskSlug(task.taskSlug);
          })}
          onSelectTask={setActiveTaskSlug}
        />
      )}
    >
      {error ? <div className="error-banner">{error}</div> : null}
      {project && activeTask ? (
        <TaskWorkspace task={activeTask} onTaskChanged={loadTasks} />
      ) : (
        <section className="empty-workspace">
          <h1>{project ? "Create a task to open the workspace" : "Connect a repository to begin"}</h1>
          <p>
            {project
              ? "Tasks create local role commands, logs, and handoff artifacts for the selected repository."
              : "VibeCodingMaster will create a local task workspace, role sessions, logs, and handoff artifacts."}
          </p>
        </section>
      )}
    </AppShell>
  );
}
