import { useCallback, useEffect, useRef, useState } from "react";
import { CODEX_REVIEWER_ROLE_DEFINITION, CODEX_TRANSLATOR_ROLE_DEFINITION, VCM_ROLE_DEFINITIONS, isCodexRoleName } from "../../shared/constants.js";
import type { TaskStatusReport } from "../../shared/types/api.js";
import type { VcmOrchestrationMode, VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import type { RoleDefinition, RoleName, VcmRoleName } from "../../shared/types/role.js";
import type { VcmSessionRoundState } from "../../shared/types/round.js";
import type { ClaudeModel, ClaudePermissionMode, SessionEffort, SessionModel } from "../../shared/types/session.js";
import type { TranslationTargetLanguage } from "../../shared/types/app-settings.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { RoleSessionTabs } from "../components/role-session-tabs.js";
import { SessionConsole } from "../components/session-console.js";
import { getSessionForRole } from "../state/session-store.js";
import { apiClient } from "../state/api-client.js";
import { selectAutoDispatchRole } from "../state/message-navigation.js";

const TASK_MESSAGE_STATE_POLL_INTERVAL_MS = 2000;

export interface TaskWorkspaceProps {
  task: TaskRecord;
  activeRole: RoleName;
  codexReviewerEnabled: boolean;
  translationEnabled: boolean;
  translationAutoSendEnabled: boolean;
  translationTargetLanguage: TranslationTargetLanguage;
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
  allRolesHaveSession: boolean;
}

export function TaskWorkspace({
  task,
  activeRole,
  codexReviewerEnabled,
  translationEnabled,
  translationAutoSendEnabled,
  translationTargetLanguage,
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
  const [permissionModes, setPermissionModes] = useState<Record<RoleName, ClaudePermissionMode>>({
    "project-manager": "default",
    architect: "default",
    coder: "default",
    reviewer: "default",
    "codex-reviewer": "default",
    "codex-translator": "default"
  });
  const [models, setModels] = useState<Record<RoleName, SessionModel>>({
    "project-manager": "default",
    architect: "default",
    coder: "default",
    reviewer: "default",
    "codex-reviewer": "gpt-5.5",
    "codex-translator": "gpt-5.5"
  });
  const [efforts, setEfforts] = useState<Record<RoleName, SessionEffort>>({
    "project-manager": "default",
    architect: "default",
    coder: "default",
    reviewer: "default",
    "codex-reviewer": "xhigh",
    "codex-translator": "medium"
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [orchestration, setOrchestration] = useState<VcmOrchestrationState | null>(null);
  const messageSnapshotRef = useRef<{ taskSlug: string; messages: VcmRoleMessage[] } | null>(null);
  const hasCodexReviewerSession = Boolean(
    statusReport?.sessions.some((session) => session.role === "codex-reviewer")
  );
  const hasCodexTranslatorSession = Boolean(
    statusReport?.sessions.some((session) => session.role === "codex-translator")
  );
  const codexReviewerVisible = codexReviewerEnabled || hasCodexReviewerSession;
  const codexTranslatorVisible = translationEnabled || hasCodexTranslatorSession;
  const visibleRoleDefinitions: readonly RoleDefinition[] = [
    ...VCM_ROLE_DEFINITIONS,
    ...(codexReviewerVisible ? [CODEX_REVIEWER_ROLE_DEFINITION] : []),
    ...(codexTranslatorVisible ? [CODEX_TRANSLATOR_ROLE_DEFINITION] : [])
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
  }, [onEventsChanged, task.taskSlug]);

  useEffect(() => {
    if (statusReport && !codexReviewerVisible && activeRole === "codex-reviewer") {
      onActiveRoleChange("project-manager");
    }
    if (statusReport && !codexTranslatorVisible && activeRole === "codex-translator") {
      onActiveRoleChange("project-manager");
    }
  }, [activeRole, codexReviewerVisible, codexTranslatorVisible, onActiveRoleChange, statusReport]);

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
    setModels((current) => {
      let changed = false;
      const next = { ...current };
      for (const session of statusReport?.sessions ?? []) {
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
    const vcmSessions = sessions.filter((session) => !isCodexRoleName(session.role));
    const sessionRoles = new Set(vcmSessions.map((session) => session.role));
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
      sessionCount: sessions.length,
      hasAnySession: sessions.length > 0,
      allRolesHaveSession: VCM_ROLE_DEFINITIONS.every((definition) => sessionRoles.has(definition.name))
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
    const closeMessage = task.worktreePath
      ? [
          `Close task "${task.taskSlug}"?`,
          "",
          "This is destructive:",
          "- stops VCM-managed running role sessions for this task",
          `- deletes the task worktree: ${task.worktreePath}`,
          `- deletes the Git branch: ${task.branch}`,
          "- deletes VCM task/session/message/orchestration state",
          "",
          "VCM will not check running sessions or uncommitted changes before closing."
        ].join("\n")
      : [
          `Close task "${task.taskSlug}"?`,
          "",
          "This task was created without a separate worktree/branch.",
          "VCM will stop VCM-managed running role sessions for this task.",
          "VCM will delete task/session/message/orchestration state only.",
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
      await apiClient.cleanupTask(task.taskSlug, {
        force: true,
        deleteBranch: Boolean(task.worktreePath),
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
                    orchestrationMode={orchestration?.mode ?? "auto"}
                    translationEnabled={translationEnabled}
                    translationAutoSendEnabled={translationAutoSendEnabled}
                    translationTargetLanguage={translationTargetLanguage}
                    onPermissionModeChange={(permissionMode) => setRolePermissionMode(role, permissionMode)}
                    onModelChange={(model) => setRoleModel(role, model)}
                    onEffortChange={(effort) => setRoleEffort(role, effort)}
                    onOrchestrationModeChange={(mode) => void setOrchestrationMode(mode)}
                    onStart={() => void runAction(async () => {
                      await apiClient.startRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role],
                        effort: efforts[role]
                      });
                      appendEvent(`started ${role} with ${permissionModes[role]} / ${models[role]} / ${efforts[role]}`);
                    })}
                    onResume={() => void runAction(async () => {
                      await apiClient.resumeRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role],
                        effort: efforts[role]
                      });
                      appendEvent(`resumed ${role} with ${permissionModes[role]} / ${models[role]} / ${efforts[role]}`);
                    })}
                    onStop={() => void runAction(async () => {
                      await apiClient.stopRoleSession(task.taskSlug, role);
                      appendEvent(`stopped ${role}`);
                    })}
                    onRestart={() => void runAction(async () => {
                      await apiClient.restartRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role],
                        effort: efforts[role]
                      });
                      appendEvent(`restarted ${role} with ${permissionModes[role]} / ${models[role]} / ${efforts[role]}`);
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
