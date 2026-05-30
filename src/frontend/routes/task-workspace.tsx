import { useCallback, useEffect, useState } from "react";
import { ROLE_DEFINITIONS } from "../../shared/constants.js";
import type { TaskStatusReport, TaskWorkflowReport } from "../../shared/types/api.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import type { RoleName } from "../../shared/types/role.js";
import type { ClaudePermissionMode } from "../../shared/types/session.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { RoleSessionTabs } from "../components/role-session-tabs.js";
import { SessionConsole } from "../components/session-console.js";
import { getSessionForRole } from "../state/session-store.js";
import { apiClient } from "../state/api-client.js";

export interface TaskWorkspaceProps {
  task: TaskRecord;
  activeRole: RoleName;
  onTaskChanged(): Promise<void>;
  onActiveRoleChange(role: RoleName): void;
  onWorkflowChanged?(workflow: TaskWorkflowReport): void;
  onMessagesChanged?(messages: VcmRoleMessage[]): void;
  onOrchestrationChanged?(orchestration: VcmOrchestrationState): void;
  onEventsChanged?(events: string[]): void;
}

export function TaskWorkspace({
  task,
  activeRole,
  onTaskChanged,
  onActiveRoleChange,
  onWorkflowChanged,
  onMessagesChanged,
  onOrchestrationChanged,
  onEventsChanged
}: TaskWorkspaceProps) {
  const [statusReport, setStatusReport] = useState<TaskStatusReport | null>(null);
  const [permissionModes, setPermissionModes] = useState<Record<RoleName, ClaudePermissionMode>>({
    "project-manager": "default",
    architect: "default",
    coder: "default",
    reviewer: "default"
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const [nextStatusReport, nextMessages, nextOrchestration] = await Promise.all([
      apiClient.getTaskStatus(task.taskSlug),
      apiClient.listMessages(task.taskSlug),
      apiClient.getOrchestrationState(task.taskSlug)
    ]);
    setStatusReport(nextStatusReport);
    onWorkflowChanged?.(nextStatusReport.workflow);
    onMessagesChanged?.(nextMessages);
    onOrchestrationChanged?.(nextOrchestration);
  }, [onMessagesChanged, onOrchestrationChanged, onWorkflowChanged, task.taskSlug]);

  useEffect(() => {
    void refresh().catch((caught: Error) => setError(caught.message));
  }, [refresh]);

  useEffect(() => {
    setEvents([]);
    onEventsChanged?.([]);
  }, [onEventsChanged, task.taskSlug]);

  useEffect(() => {
    setPermissionModes((current) => {
      let changed = false;
      const next = { ...current };
      for (const session of statusReport?.sessions ?? []) {
        if (next[session.role] !== session.permissionMode) {
          next[session.role] = session.permissionMode;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [statusReport?.sessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void Promise.all([
        apiClient.getTaskStatus(task.taskSlug),
        apiClient.listMessages(task.taskSlug),
        apiClient.getOrchestrationState(task.taskSlug)
      ])
        .then(([nextStatusReport, nextMessages, nextOrchestration]) => {
          setStatusReport(nextStatusReport);
          onWorkflowChanged?.(nextStatusReport.workflow);
          onMessagesChanged?.(nextMessages);
          onOrchestrationChanged?.(nextOrchestration);
        })
        .catch((caught: Error) => setError(caught.message));
    }, 3000);

    return () => window.clearInterval(interval);
  }, [onMessagesChanged, onOrchestrationChanged, onWorkflowChanged, task.taskSlug]);

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      await onTaskChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  function appendEvent(message: string) {
    setEvents((current) => {
      const next = [...current, `${new Date().toLocaleTimeString()} ${message}`];
      onEventsChanged?.(next);
      return next;
    });
  }

  function setRolePermissionMode(role: RoleName, permissionMode: ClaudePermissionMode) {
    setPermissionModes((current) => ({
      ...current,
      [role]: permissionMode
    }));
  }

  return (
    <div className="task-workspace">
      <header className="workspace-header">
        <div className="workspace-title-line">
          <span className="eyebrow">Task Workspace</span>
          <h1>{task.title || task.taskSlug}</h1>
          <span className="workspace-branch">{task.branch}</span>
        </div>
        <RoleSessionTabs
          activeRole={activeRole}
          sessions={statusReport?.sessions ?? []}
          onSelect={onActiveRoleChange}
        />
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="workspace-grid">
        <div className="workspace-main">
          <div className="role-console-stack">
            {ROLE_DEFINITIONS.map((definition) => {
              const role = definition.name;
              const isActive = role === activeRole;
              const session = getSessionForRole(statusReport?.sessions ?? [], role);

              return (
                <div
                  className={isActive ? "role-console-panel is-active" : "role-console-panel"}
                  key={role}
                  aria-hidden={!isActive}
                >
                  <SessionConsole
                    role={role}
                    session={session}
                    permissionMode={permissionModes[role]}
                    active={isActive}
                    busy={busy}
                    onPermissionModeChange={(permissionMode) => setRolePermissionMode(role, permissionMode)}
                    onStart={() => void runAction(async () => {
                      await apiClient.startRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role]
                      });
                      appendEvent(`started ${role} with ${permissionModes[role]}`);
                    })}
                    onResume={() => void runAction(async () => {
                      await apiClient.resumeRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role]
                      });
                      appendEvent(`resumed ${role} with ${permissionModes[role]}`);
                    })}
                    onStop={() => void runAction(async () => {
                      await apiClient.stopRoleSession(task.taskSlug, role);
                      appendEvent(`stopped ${role}`);
                    })}
                    onRestart={() => void runAction(async () => {
                      await apiClient.restartRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role]
                      });
                      appendEvent(`restarted ${role} with ${permissionModes[role]}`);
                    })}
                    onTerminalEvent={(message) => appendEvent(`${definition.label}: ${message}`)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
