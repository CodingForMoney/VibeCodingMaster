import { useCallback, useEffect, useRef, useState } from "react";
import { CORE_VCM_ROLE_DEFINITIONS, GATE_REVIEWER_ROLE_DEFINITION, VCM_ROLE_DEFINITIONS } from "../../shared/constants.js";
import type { TaskStatusReport } from "../../shared/types/api.js";
import type { VcmOrchestrationMode, VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import type { CoreVcmRoleName, RoleDefinition, RoleName, VcmRoleName } from "../../shared/types/role.js";
import type { VcmSessionRoundState } from "../../shared/types/round.js";
import type { ClaudeModel, ClaudePermissionMode, RoleSessionRecord, SessionEffort, SessionModel } from "../../shared/types/session.js";
import type { TranslationTargetLanguage } from "../../shared/types/app-settings.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { RoleSessionTabs } from "../components/role-session-tabs.js";
import { SessionConsole } from "../components/session-console.js";
import { SwitchControl } from "../components/switch-control.js";
import { getSessionForRole } from "../state/session-store.js";
import { apiClient } from "../state/api-client.js";
import { selectAutoDispatchRole } from "../state/message-navigation.js";

const TASK_MESSAGE_STATE_POLL_INTERVAL_MS = 2000;
type LaunchOptionField = "permissionMode" | "model" | "effort";
type LaunchOptionOverrides = Partial<Record<RoleName, Partial<Record<LaunchOptionField, true>>>>;

export interface TaskWorkspaceProps {
  task: TaskRecord;
  activeRole: RoleName;
  gateReviewerEnabled: boolean;
  translationEnabled: boolean;
  translationAutoSendEnabled: boolean;
  translationTargetLanguage: TranslationTargetLanguage;
  refreshNonce?: number;
  onTaskChanged(): Promise<void>;
  onActiveRoleChange(role: RoleName): void;
  onBeforeCloseTask?(): Promise<void>;
  onMessagesChanged?(messages: VcmRoleMessage[]): void;
  onOrchestrationChanged?(orchestration: VcmOrchestrationState): void;
  onRoundStateChanged?(roundState: VcmSessionRoundState): void;
  onEventsChanged?(events: string[]): void;
  onLaunchStateChanged?(state: TaskWorkspaceLaunchState): void;
}

export interface TaskWorkspaceLaunchState {
  taskSlug: string;
  roles: Record<VcmRoleName, {
    permissionMode: ClaudePermissionMode;
    model: ClaudeModel;
    effort: SessionEffort;
  }>;
  autoOrchestration: boolean;
  statusLoaded: boolean;
  sessionCount: number;
  hasAnySession: boolean;
  allRolesHaveSession: boolean;
}

export function TaskWorkspace({
  task,
  activeRole,
  gateReviewerEnabled,
  translationEnabled,
  translationAutoSendEnabled,
  translationTargetLanguage,
  refreshNonce = 0,
  onTaskChanged,
  onActiveRoleChange,
  onBeforeCloseTask,
  onMessagesChanged,
  onOrchestrationChanged,
  onRoundStateChanged,
  onEventsChanged,
  onLaunchStateChanged
}: TaskWorkspaceProps) {
  const [statusReport, setStatusReport] = useState<TaskStatusReport | null>(null);
  const [permissionModes, setPermissionModes] = useState<Record<RoleName, ClaudePermissionMode>>({
    "project-manager": "bypassPermissions",
    architect: "bypassPermissions",
    coder: "bypassPermissions",
    reviewer: "bypassPermissions",
    "gate-reviewer": "bypassPermissions",
    translator: "bypassPermissions",
    "harness-engineer": "bypassPermissions"
  });
  const [models, setModels] = useState<Record<RoleName, SessionModel>>({
    "project-manager": "default",
    architect: "default",
    coder: "default",
    reviewer: "default",
    "gate-reviewer": "default",
    translator: "default",
    "harness-engineer": "default"
  });
  const [efforts, setEfforts] = useState<Record<RoleName, SessionEffort>>({
    "project-manager": "default",
    architect: "default",
    coder: "default",
    reviewer: "default",
    "gate-reviewer": "default",
    translator: "medium",
    "harness-engineer": "medium"
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [orchestration, setOrchestration] = useState<VcmOrchestrationState | null>(null);
  const messageSnapshotRef = useRef<{ taskSlug: string; messages: VcmRoleMessage[] } | null>(null);
  const taskStatusSyncKeyRef = useRef("");
  const launchOptionOverridesRef = useRef<LaunchOptionOverrides>({});
  const hasGateReviewerSession = Boolean(
    statusReport?.sessions.some((session) => session.role === "gate-reviewer")
  );
  const gateReviewerVisible = gateReviewerEnabled || hasGateReviewerSession;
  const visibleRoleDefinitions: readonly RoleDefinition[] = [
    ...CORE_VCM_ROLE_DEFINITIONS,
    ...(gateReviewerVisible ? [GATE_REVIEWER_ROLE_DEFINITION] : [])
  ];

  const applyMessageState = useCallback((nextMessages: VcmRoleMessage[], nextOrchestration: VcmOrchestrationState) => {
    const previousMessages = messageSnapshotRef.current?.taskSlug === task.taskSlug
      ? messageSnapshotRef.current.messages
      : null;
    const targetRole = selectAutoDispatchRole(previousMessages, nextMessages, nextOrchestration);
    messageSnapshotRef.current = {
      taskSlug: task.taskSlug,
      messages: nextMessages
    };

    setOrchestration(nextOrchestration);
    onMessagesChanged?.(nextMessages);
    onOrchestrationChanged?.(nextOrchestration);
    if (targetRole) {
      onActiveRoleChange(targetRole);
      appendEvent(`auto switched to ${targetRole} before VCM dispatch`);
    }
  }, [onActiveRoleChange, onMessagesChanged, onOrchestrationChanged, task.taskSlug]);

  const applyFetchedState = useCallback((nextStatusReport: TaskStatusReport, nextMessages: VcmRoleMessage[], nextOrchestration: VcmOrchestrationState, nextRoundState: VcmSessionRoundState) => {
    setStatusReport(nextStatusReport);
    applyMessageState(nextMessages, nextOrchestration);
    onRoundStateChanged?.(nextRoundState);
  }, [applyMessageState, onRoundStateChanged]);

  const refresh = useCallback(async () => {
    const [nextStatusReport, nextMessages, nextOrchestration, nextRoundState] = await Promise.all([
      apiClient.getTaskStatus(task.taskSlug),
      apiClient.listMessages(task.taskSlug),
      apiClient.getOrchestrationState(task.taskSlug),
      apiClient.getSessionRoundState(task.taskSlug)
    ]);
    applyFetchedState(nextStatusReport, nextMessages, nextOrchestration, nextRoundState);
  }, [applyFetchedState, task.taskSlug]);

  useEffect(() => {
    void refresh().catch((caught: Error) => setError(caught.message));
  }, [refresh, refreshNonce]);

  useEffect(() => {
    setEvents([]);
    onEventsChanged?.([]);
    launchOptionOverridesRef.current = {};
  }, [onEventsChanged, task.taskSlug]);

  useEffect(() => {
    if (statusReport && !gateReviewerVisible && activeRole === "gate-reviewer") {
      onActiveRoleChange("project-manager");
    }
    if (statusReport && activeRole === "translator") {
      onActiveRoleChange("project-manager");
    }
  }, [activeRole, gateReviewerVisible, onActiveRoleChange, statusReport]);

  useEffect(() => {
    const fetchedTask = statusReport?.task;
    if (!fetchedTask || fetchedTask.taskSlug !== task.taskSlug) {
      return;
    }

    const fetchedKey = taskSyncKey(fetchedTask);
    if (fetchedKey === taskSyncKey(task)) {
      taskStatusSyncKeyRef.current = "";
      return;
    }
    if (taskStatusSyncKeyRef.current === fetchedKey) {
      return;
    }

    taskStatusSyncKeyRef.current = fetchedKey;
    void onTaskChanged().catch((caught: Error) => {
      taskStatusSyncKeyRef.current = "";
      setError(caught.message);
    });
  }, [onTaskChanged, statusReport?.task, task]);

  useEffect(() => {
    setPermissionModes((current) => {
      let changed = false;
      const next = { ...current };
      for (const session of statusReport?.sessions ?? []) {
        if (hasLaunchOptionOverride(launchOptionOverridesRef.current, session.role, "permissionMode")) {
          continue;
        }
        if (next[session.role] !== session.permissionMode) {
          next[session.role] = session.permissionMode;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [statusReport?.sessions]);

  useEffect(() => {
    setModels((current) => {
      let changed = false;
      const next = { ...current };
      for (const session of statusReport?.sessions ?? []) {
        if (hasLaunchOptionOverride(launchOptionOverridesRef.current, session.role, "model")) {
          continue;
        }
        const sessionModel = session.model ?? "default";
        if (next[session.role] !== sessionModel) {
          next[session.role] = sessionModel;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [statusReport?.sessions]);

  useEffect(() => {
    setEfforts((current) => {
      let changed = false;
      const next = { ...current };
      for (const session of statusReport?.sessions ?? []) {
        if (hasLaunchOptionOverride(launchOptionOverridesRef.current, session.role, "effort")) {
          continue;
        }
        const sessionEffort = session.effort ?? "default";
        if (next[session.role] !== sessionEffort) {
          next[session.role] = sessionEffort;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [statusReport?.sessions]);

  useEffect(() => {
    const sessions = statusReport?.sessions ?? [];
    const coreSessions = sessions.filter((session) => isCoreVcmRoleName(session.role));
    const coreSessionRoles = new Set(coreSessions.map((session) => session.role));
    const roles = {} as TaskWorkspaceLaunchState["roles"];
    for (const definition of VCM_ROLE_DEFINITIONS) {
      roles[definition.name] = {
        permissionMode: permissionModes[definition.name],
        model: models[definition.name] as ClaudeModel,
        effort: efforts[definition.name]
      };
    }

    onLaunchStateChanged?.({
      taskSlug: task.taskSlug,
      roles,
      autoOrchestration: (orchestration?.mode ?? "auto") === "auto",
      statusLoaded: Boolean(statusReport),
      sessionCount: coreSessions.length,
      hasAnySession: coreSessions.length > 0,
      allRolesHaveSession: CORE_VCM_ROLE_DEFINITIONS.every((definition) => coreSessionRoles.has(definition.name))
    });
  }, [
    models,
    efforts,
    onLaunchStateChanged,
    orchestration?.mode,
    permissionModes,
    statusReport,
    task.taskSlug
  ]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void Promise.all([
        apiClient.getTaskStatus(task.taskSlug),
        apiClient.listMessages(task.taskSlug),
        apiClient.getOrchestrationState(task.taskSlug),
        apiClient.getSessionRoundState(task.taskSlug)
      ])
        .then(([nextStatusReport, nextMessages, nextOrchestration, nextRoundState]) => {
          applyFetchedState(nextStatusReport, nextMessages, nextOrchestration, nextRoundState);
        })
        .catch((caught: Error) => setError(caught.message));
    }, 3000);

    return () => window.clearInterval(interval);
  }, [applyFetchedState, task.taskSlug]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const interval = window.setInterval(() => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      void Promise.all([
        apiClient.listMessages(task.taskSlug),
        apiClient.getOrchestrationState(task.taskSlug)
      ])
        .then(([nextMessages, nextOrchestration]) => {
          if (!cancelled) {
            applyMessageState(nextMessages, nextOrchestration);
          }
        })
        .catch((caught: Error) => {
          if (!cancelled) {
            setError(caught.message);
          }
        })
        .finally(() => {
          inFlight = false;
        });
    }, TASK_MESSAGE_STATE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [applyMessageState, task.taskSlug]);

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

  async function closeTask() {
    const closeMessage = [
      `Close task "${task.taskSlug}"?`,
      "",
      "This is destructive:",
      "- stops VCM-managed running role sessions for this task",
      "- moves project-scoped Translator and Harness Engineer sessions to the base repository cwd",
      `- deletes the task worktree: ${task.worktreePath}`,
      `- deletes the Git branch: ${task.branch}`,
      "- deletes VCM task/session/message/orchestration state",
      "",
      "VCM will not check running sessions or uncommitted changes before closing."
    ].join("\n");
    const confirmed = window.confirm(
      closeMessage
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      await onBeforeCloseTask?.();
      await apiClient.cleanupTask(task.taskSlug, {
        force: true,
        forceDeleteBranch: true
      });
      appendEvent(`closed ${task.taskSlug}`);
      await onTaskChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Close task failed.");
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
    markLaunchOptionOverride(launchOptionOverridesRef.current, role, "permissionMode");
    setPermissionModes((current) => ({
      ...current,
      [role]: permissionMode
    }));
  }

  function setRoleModel(role: RoleName, model: SessionModel) {
    markLaunchOptionOverride(launchOptionOverridesRef.current, role, "model");
    setModels((current) => ({
      ...current,
      [role]: model
    }));
  }

  function setRoleEffort(role: RoleName, effort: SessionEffort) {
    markLaunchOptionOverride(launchOptionOverridesRef.current, role, "effort");
    setEfforts((current) => ({
      ...current,
      [role]: effort
    }));
  }

  function syncRoleLaunchOptions(session: RoleSessionRecord) {
    delete launchOptionOverridesRef.current[session.role];
    setPermissionModes((current) => ({
      ...current,
      [session.role]: session.permissionMode
    }));
    setModels((current) => ({
      ...current,
      [session.role]: session.model ?? "default"
    }));
    setEfforts((current) => ({
      ...current,
      [session.role]: session.effort ?? "default"
    }));
  }

  async function setOrchestrationMode(mode: VcmOrchestrationMode) {
    setBusy(true);
    setError("");
    try {
      const nextOrchestration = await apiClient.updateOrchestrationState(task.taskSlug, { mode });
      setOrchestration(nextOrchestration);
      onOrchestrationChanged?.(nextOrchestration);
      appendEvent(`auto orchestration ${mode === "auto" ? "enabled" : "disabled"}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update orchestration mode.");
    } finally {
      setBusy(false);
    }
  }

  const autoOrchestrationEnabled = (orchestration?.mode ?? "auto") === "auto";

  return (
    <div className="task-workspace">
      <header className="workspace-header">
        <div className="workspace-title-line">
          <h1>{task.title || task.taskSlug}</h1>
        </div>
        <RoleSessionTabs
          activeRole={activeRole}
          roles={visibleRoleDefinitions}
          sessions={statusReport?.sessions ?? []}
          onSelect={onActiveRoleChange}
        />
        <div className="workspace-header-actions">
          <SwitchControl
            checked={autoOrchestrationEnabled}
            className="orchestration-switch"
            disabled={busy}
            label="Auto orchestration"
            onChange={(checked) => void setOrchestrationMode(checked ? "auto" : "manual")}
          />
          <button className="danger-button" type="button" disabled={busy} onClick={() => void closeTask()}>
            Close Task
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="workspace-grid">
        <div className="workspace-main">
          <div className="role-console-stack">
            {visibleRoleDefinitions.map((definition) => {
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
                    model={models[role]}
                    effort={efforts[role]}
                    active={isActive}
                    busy={busy}
                    translationEnabled={translationEnabled}
                    translationAutoSendEnabled={translationAutoSendEnabled}
                    translationTargetLanguage={translationTargetLanguage}
                    onPermissionModeChange={(permissionMode) => setRolePermissionMode(role, permissionMode)}
                    onModelChange={(model) => setRoleModel(role, model)}
                    onEffortChange={(effort) => setRoleEffort(role, effort)}
                    onStart={() => void runAction(async () => {
                      const session = await apiClient.startRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role],
                        effort: efforts[role]
                      });
                      syncRoleLaunchOptions(session);
                      appendEvent(`started ${role} with ${permissionModes[role]} / ${models[role]} / ${efforts[role]}`);
                    })}
                    onResume={() => void runAction(async () => {
                      const session = await apiClient.resumeRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role],
                        effort: efforts[role]
                      });
                      syncRoleLaunchOptions(session);
                      appendEvent(`resumed ${role} with ${permissionModes[role]} / ${models[role]} / ${efforts[role]}`);
                    })}
                    onStop={() => void runAction(async () => {
                      await apiClient.stopRoleSession(task.taskSlug, role);
                      appendEvent(`stopped ${role}`);
                    })}
                    onRestart={() => void runAction(async () => {
                      const session = await apiClient.restartRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role],
                        effort: efforts[role]
                      });
                      syncRoleLaunchOptions(session);
                      appendEvent(`restarted ${role} with ${permissionModes[role]} / ${models[role]} / ${efforts[role]}`);
                    })}
                    onNotifyHarnessUpdated={() => void runAction(async () => {
                      await apiClient.notifyRoleHarnessUpdated(task.taskSlug, role);
                      appendEvent(`notified ${role} to reload latest harness`);
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

function isCoreVcmRoleName(role: RoleName): role is CoreVcmRoleName {
  return CORE_VCM_ROLE_DEFINITIONS.some((definition) => definition.name === role);
}

function taskSyncKey(task: TaskRecord): string {
  return [
    task.status,
    task.updatedAt,
    task.cleanupStatus ?? "",
    task.cleanedAt ?? ""
  ].join(":");
}

function hasLaunchOptionOverride(overrides: LaunchOptionOverrides, role: RoleName, field: LaunchOptionField): boolean {
  return Boolean(overrides[role]?.[field]);
}

function markLaunchOptionOverride(overrides: LaunchOptionOverrides, role: RoleName, field: LaunchOptionField): void {
  overrides[role] = {
    ...overrides[role],
    [field]: true
  };
}
