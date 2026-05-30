import { useEffect, useMemo, useState } from "react";
import type { HarnessApplyResult, HarnessStatusReport } from "../shared/types/harness.js";
import type { ProjectSummary } from "../shared/types/project.js";
import type { TaskRecord } from "../shared/types/task.js";
import { AppShell } from "./components/app-shell.js";
import { selectActiveTask } from "./state/app-store.js";
import { apiClient } from "./state/api-client.js";
import { ProjectDashboard } from "./routes/project-dashboard.js";
import { TaskWorkspace } from "./routes/task-workspace.js";

export function App() {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [harnessStatus, setHarnessStatus] = useState<HarnessStatusReport | null>(null);
  const [harnessApplyResult, setHarnessApplyResult] = useState<HarnessApplyResult | null>(null);
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

  async function loadHarnessStatus() {
    const nextStatus = await apiClient.getHarnessStatus();
    setHarnessStatus(nextStatus);
    return nextStatus;
  }

  useEffect(() => {
    apiClient.getCurrentProject()
      .then(async (currentProject) => {
        setProject(currentProject);
        if (currentProject) {
          await Promise.all([
            loadTasks(),
            loadHarnessStatus()
          ]);
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
          harnessStatus={harnessStatus}
          harnessApplyResult={harnessApplyResult}
          busy={busy}
          onConnect={(repoPath) => withBusy(async () => {
            const nextProject = await apiClient.connectProject({ repoPath });
            setProject(nextProject);
            setHarnessApplyResult(null);
            await Promise.all([
              loadTasks(),
              loadHarnessStatus()
            ]);
          })}
          onRefreshHarness={() => withBusy(async () => {
            setHarnessApplyResult(null);
            await loadHarnessStatus();
          })}
          onApplyHarness={() => withBusy(async () => {
            const result = await apiClient.applyHarness();
            setHarnessApplyResult(result);
            await loadHarnessStatus();
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
