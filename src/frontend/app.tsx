import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskWorkflowReport } from "../shared/types/api.js";
import type { HarnessApplyResult, HarnessStatusReport } from "../shared/types/harness.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../shared/types/message.js";
import type { ProjectSummary } from "../shared/types/project.js";
import type { RoleName } from "../shared/types/role.js";
import type { TaskRecord } from "../shared/types/task.js";
import { AppShell } from "./components/app-shell.js";
import { selectActiveTask } from "./state/app-store.js";
import { apiClient } from "./state/api-client.js";
import { ProjectDashboard } from "./routes/project-dashboard.js";
import { TaskWorkspace } from "./routes/task-workspace.js";

export function App() {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [recentRepositoryPaths, setRecentRepositoryPaths] = useState<string[]>([]);
  const [harnessStatus, setHarnessStatus] = useState<HarnessStatusReport | null>(null);
  const [harnessApplyResult, setHarnessApplyResult] = useState<HarnessApplyResult | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [activeTaskSlug, setActiveTaskSlug] = useState<string | null>(null);
  const [activeWorkflow, setActiveWorkflow] = useState<{ taskSlug: string; workflow: TaskWorkflowReport } | null>(null);
  const [activeMessages, setActiveMessages] = useState<{ taskSlug: string; messages: VcmRoleMessage[] } | null>(null);
  const [activeOrchestration, setActiveOrchestration] = useState<{ taskSlug: string; orchestration: VcmOrchestrationState } | null>(null);
  const [activeEvents, setActiveEvents] = useState<{ taskSlug: string; events: string[] } | null>(null);
  const [activeRole, setActiveRole] = useState<RoleName>("project-manager");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activeTask = useMemo(
    () => selectActiveTask(tasks, activeTaskSlug),
    [tasks, activeTaskSlug]
  );

  const handleWorkflowChanged = useCallback((workflow: TaskWorkflowReport) => {
    if (activeTask?.taskSlug) {
      setActiveWorkflow({ taskSlug: activeTask.taskSlug, workflow });
    }
  }, [activeTask?.taskSlug]);

  const handleMessagesChanged = useCallback((messages: VcmRoleMessage[]) => {
    if (activeTask?.taskSlug) {
      setActiveMessages({ taskSlug: activeTask.taskSlug, messages });
    }
  }, [activeTask?.taskSlug]);

  const handleOrchestrationChanged = useCallback((orchestration: VcmOrchestrationState) => {
    if (activeTask?.taskSlug) {
      setActiveOrchestration({ taskSlug: activeTask.taskSlug, orchestration });
    }
  }, [activeTask?.taskSlug]);

  const handleEventsChanged = useCallback((events: string[]) => {
    if (activeTask?.taskSlug) {
      setActiveEvents({ taskSlug: activeTask.taskSlug, events });
    }
  }, [activeTask?.taskSlug]);

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

  async function loadRecentRepositoryPaths() {
    const nextPaths = await apiClient.getRecentRepositoryPaths();
    setRecentRepositoryPaths(nextPaths);
    return nextPaths;
  }

  async function refreshMessageState(taskSlug: string) {
    const [messages, orchestration] = await Promise.all([
      apiClient.listMessages(taskSlug),
      apiClient.getOrchestrationState(taskSlug)
    ]);
    setActiveMessages({ taskSlug, messages });
    setActiveOrchestration({ taskSlug, orchestration });
  }

  useEffect(() => {
    Promise.all([
      apiClient.getCurrentProject(),
      apiClient.getRecentRepositoryPaths()
    ])
      .then(async ([currentProject, recentPaths]) => {
        setProject(currentProject);
        setRecentRepositoryPaths(recentPaths);
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

  const sidebarWorkflow =
    activeWorkflow && activeWorkflow.taskSlug === activeTask?.taskSlug
      ? activeWorkflow.workflow
      : null;
  const sidebarMessages =
    activeMessages && activeMessages.taskSlug === activeTask?.taskSlug
      ? activeMessages.messages
      : [];
  const sidebarOrchestration =
    activeOrchestration && activeOrchestration.taskSlug === activeTask?.taskSlug
      ? activeOrchestration.orchestration
      : null;
  const sidebarEvents =
    activeEvents && activeEvents.taskSlug === activeTask?.taskSlug
      ? activeEvents.events
      : [];

  return (
    <AppShell
      sidebar={(
        <ProjectDashboard
          project={project}
          recentRepositoryPaths={recentRepositoryPaths}
          tasks={tasks}
          activeTaskSlug={activeTask?.taskSlug ?? null}
          workflow={sidebarWorkflow}
          messages={sidebarMessages}
          orchestration={sidebarOrchestration}
          events={sidebarEvents}
          harnessStatus={harnessStatus}
          harnessApplyResult={harnessApplyResult}
          busy={busy}
          onConnect={(repoPath) => withBusy(async () => {
            const nextProject = await apiClient.connectProject({ repoPath });
            setProject(nextProject);
            setHarnessApplyResult(null);
            await Promise.all([
              loadTasks(),
              loadHarnessStatus(),
              loadRecentRepositoryPaths()
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
          onOrchestrationModeChange={(mode) => {
            if (!activeTask) {
              return;
            }
            void withBusy(async () => {
              const orchestration = await apiClient.updateOrchestrationState(activeTask.taskSlug, { mode });
              setActiveOrchestration({ taskSlug: activeTask.taskSlug, orchestration });
            });
          }}
          onStageMessage={(message) => {
            void withBusy(async () => {
              const staged = await apiClient.stageMessage(message.taskSlug, message.id);
              setActiveRole(staged.toRole);
              await refreshMessageState(message.taskSlug);
            });
          }}
          onRejectMessage={(message) => {
            void withBusy(async () => {
              await apiClient.rejectMessage(message.taskSlug, message.id);
              await refreshMessageState(message.taskSlug);
            });
          }}
          onOpenMessageRole={setActiveRole}
        />
      )}
    >
      {error ? <div className="error-banner">{error}</div> : null}
      {project && activeTask ? (
        <TaskWorkspace
          task={activeTask}
          activeRole={activeRole}
          onTaskChanged={loadTasks}
          onActiveRoleChange={setActiveRole}
          onWorkflowChanged={handleWorkflowChanged}
          onMessagesChanged={handleMessagesChanged}
          onOrchestrationChanged={handleOrchestrationChanged}
          onEventsChanged={handleEventsChanged}
        />
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
