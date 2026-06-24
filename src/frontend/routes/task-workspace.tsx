import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CORE_VCM_ROLE_DEFINITIONS, GATE_REVIEWER_ROLE_DEFINITION, VCM_ROLE_DEFINITIONS } from "../../shared/constants.js";
import type { TaskStatusReport } from "../../shared/types/api.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import type { CoreVcmRoleName, RoleDefinition, RoleName, VcmRoleName } from "../../shared/types/role.js";
import type { VcmSessionRoundState } from "../../shared/types/round.js";
import type { ClaudeModel, ClaudePermissionMode, SessionEffort, SessionModel } from "../../shared/types/session.js";
import type { LaunchTemplate, TranslationTargetLanguage } from "../../shared/types/app-settings.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { RoleSessionTabs } from "../components/role-session-tabs.js";
import { SessionConsole } from "../components/session-console.js";
import { clearUiErrorForActions, formatUiError } from "../state/error-format.js";
import { clearPollError, recordPollError } from "../state/poll-error-gate.js";
import { useUiErrorState } from "../state/ui-error-state.js";
import { getSessionForRole } from "../state/session-store.js";
import { apiClient } from "../state/api-client.js";
import { selectAutoDispatchRole } from "../state/message-navigation.js";
import { useScheduledPoll } from "../state/use-scheduled-poll.js";

const DEFAULT_PERMISSION_MODES: Record<RoleName, ClaudePermissionMode> = {
  "project-manager": "bypassPermissions",
  architect: "bypassPermissions",
  coder: "bypassPermissions",
  reviewer: "bypassPermissions",
  "gate-reviewer": "bypassPermissions",
  translator: "bypassPermissions",
  "harness-engineer": "bypassPermissions"
};

const DEFAULT_MODELS: Record<RoleName, SessionModel> = {
  "project-manager": "default",
  architect: "default",
  coder: "default",
  reviewer: "default",
  "gate-reviewer": "default",
  translator: "default",
  "harness-engineer": "default"
};

const DEFAULT_EFFORTS: Record<RoleName, SessionEffort> = {
  "project-manager": "default",
  architect: "default",
  coder: "default",
  reviewer: "default",
  "gate-reviewer": "default",
  translator: "medium",
  "harness-engineer": "medium"
};

export interface TaskWorkspaceProps {
  task: TaskRecord;
  activeRole: RoleName;
  gateReviewerEnabled: boolean;
  translationEnabled: boolean;
  translationAutoSendEnabled: boolean;
  translationTargetLanguage: TranslationTargetLanguage;
  launchTemplate: LaunchTemplate;
  refreshNonce?: number;
  onTaskChanged(): Promise<void>;
  onActiveRoleChange(role: RoleName): void;
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
  hasGateReviewerSession: boolean;
  allRolesHaveSession: boolean;
}

export function TaskWorkspace({
  task,
  activeRole,
  gateReviewerEnabled,
  translationEnabled,
  translationAutoSendEnabled,
  translationTargetLanguage,
  launchTemplate,
  refreshNonce = 0,
  onTaskChanged,
  onActiveRoleChange,
  onMessagesChanged,
  onOrchestrationChanged,
  onRoundStateChanged,
  onEventsChanged,
  onLaunchStateChanged
}: TaskWorkspaceProps) {
  const [statusReport, setStatusReport] = useState<TaskStatusReport | null>(null);
  const [permissionModes, setPermissionModes] = useState<Record<RoleName, ClaudePermissionMode>>(() => permissionModesFromLaunchTemplate(launchTemplate));
  const [models, setModels] = useState<Record<RoleName, SessionModel>>(() => modelsFromLaunchTemplate(launchTemplate));
  const [efforts, setEfforts] = useState<Record<RoleName, SessionEffort>>(() => effortsFromLaunchTemplate(launchTemplate));
  const [busy, setBusy] = useState(false);
  const [, setError] = useUiErrorState("");
  const [events, setEvents] = useState<string[]>([]);
  const [orchestration, setOrchestration] = useState<VcmOrchestrationState | null>(null);
  const messageSnapshotRef = useRef<{ taskSlug: string; messages: VcmRoleMessage[] } | null>(null);
  const taskStatusSyncKeyRef = useRef("");
  const launchTemplateKey = useMemo(() => JSON.stringify(launchTemplate), [launchTemplate]);
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
    const nextState = await apiClient.getTaskWorkspaceState(task.taskSlug);
    applyFetchedState(nextState.taskStatus, nextState.messages, nextState.orchestration, nextState.roundState);
    clearPollError("Poll task workspace state");
    setError((current) => clearUiErrorForActions(current, ["Load task workspace state", "Poll task workspace state"]));
  }, [applyFetchedState, task.taskSlug]);

  const reportPollError = useCallback((action: string, caught: Error) => {
    const message = recordPollError(action, caught);
    if (message) {
      setError(message);
    }
  }, []);

  useScheduledPoll(
    `task-workspace:${task.taskSlug}:${refreshNonce}`,
    () => refresh().catch((caught: Error) => {
      reportPollError("Poll task workspace state", caught);
    }),
    {
      intervalMs: 3000,
      runImmediately: true
    }
  );

  useEffect(() => {
    setEvents([]);
    onEventsChanged?.([]);
  }, [onEventsChanged, task.taskSlug]);

  useEffect(() => {
    setPermissionModes(permissionModesFromLaunchTemplate(launchTemplate));
    setModels(modelsFromLaunchTemplate(launchTemplate));
    setEfforts(effortsFromLaunchTemplate(launchTemplate));
  }, [launchTemplateKey, task.taskSlug]);

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
      setError(formatUiError("Refresh task list after task status changed", caught));
    });
  }, [onTaskChanged, statusReport?.task, task]);

  useEffect(() => {
    const sessions = statusReport?.sessions ?? [];
    const coreSessions = sessions.filter((session) => isCoreVcmRoleName(session.role));
    const coreSessionRoles = new Set(coreSessions.map((session) => session.role));
    const hasGateReviewerSession = sessions.some((session) => session.role === "gate-reviewer");
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
      hasGateReviewerSession,
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

  async function runAction(action: () => Promise<void>, actionLabel = "Run role session action") {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      await onTaskChanged();
    } catch (caught) {
      setError(formatUiError(actionLabel, caught));
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

  function setRoleModel(role: RoleName, model: SessionModel) {
    setModels((current) => ({
      ...current,
      [role]: model
    }));
  }

  function setRoleEffort(role: RoleName, effort: SessionEffort) {
    setEfforts((current) => ({
      ...current,
      [role]: effort
    }));
  }

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
      </header>

      <div className="workspace-grid">
        <div className="workspace-main">
          <div className="role-console-stack">
            {visibleRoleDefinitions.map((definition) => {
              const role = definition.name;
              const isActive = role === activeRole;
              const sessions = statusReport?.sessions ?? [];
              const session = getSessionForRole(sessions, role);

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
                      await apiClient.startRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role],
                        effort: efforts[role]
                      });
                      appendEvent(`started ${role} with ${permissionModes[role]} / ${models[role]} / ${efforts[role]}`);
                    }, `Start ${role} session`)}
                    onResume={() => void runAction(async () => {
                      await apiClient.resumeRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role],
                        effort: efforts[role]
                      });
                      appendEvent(`resumed ${role} with ${permissionModes[role]} / ${models[role]} / ${efforts[role]}`);
                    }, `Resume ${role} session`)}
                    onStop={() => void runAction(async () => {
                      await apiClient.stopRoleSession(task.taskSlug, role);
                      appendEvent(`stopped ${role}`);
                    }, `Stop ${role} session`)}
                    onRestart={() => void runAction(async () => {
                      await apiClient.restartRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role],
                        effort: efforts[role]
                      });
                      appendEvent(`restarted ${role} with ${permissionModes[role]} / ${models[role]} / ${efforts[role]}`);
                    }, `Restart ${role} session`)}
                    onNotifyHarnessUpdated={() => void runAction(async () => {
                      await apiClient.notifyRoleHarnessUpdated(task.taskSlug, role);
                      appendEvent(`notified ${role} to reload latest harness`);
                    }, `Notify ${role} to reload harness`)}
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

function permissionModesFromLaunchTemplate(template: LaunchTemplate): Record<RoleName, ClaudePermissionMode> {
  const modes = { ...DEFAULT_PERMISSION_MODES };
  for (const definition of VCM_ROLE_DEFINITIONS) {
    modes[definition.name] = template.roles[definition.name]?.permissionMode ?? modes[definition.name];
  }
  return modes;
}

function modelsFromLaunchTemplate(template: LaunchTemplate): Record<RoleName, SessionModel> {
  const models = { ...DEFAULT_MODELS };
  for (const definition of VCM_ROLE_DEFINITIONS) {
    models[definition.name] = template.roles[definition.name]?.model ?? models[definition.name];
  }
  return models;
}

function effortsFromLaunchTemplate(template: LaunchTemplate): Record<RoleName, SessionEffort> {
  const efforts = { ...DEFAULT_EFFORTS };
  for (const definition of VCM_ROLE_DEFINITIONS) {
    efforts[definition.name] = template.roles[definition.name]?.effort ?? efforts[definition.name];
  }
  return efforts;
}
