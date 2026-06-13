import { useCallback, useEffect, useRef, useState } from "react";
import { ROLE_DEFINITIONS } from "../../shared/constants.js";
import { CODEX_REVIEW_GATES, type CodexReviewGate, type CodexReviewIndex } from "../../shared/types/codex-review.js";
import type { TaskStatusReport } from "../../shared/types/api.js";
import type { VcmOrchestrationMode, VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import type { RoleName } from "../../shared/types/role.js";
import type { VcmSessionRoundState } from "../../shared/types/round.js";
import type { ClaudeModel, ClaudePermissionMode } from "../../shared/types/session.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { RoleSessionTabs } from "../components/role-session-tabs.js";
import { SessionConsole } from "../components/session-console.js";
import { StatusBadge } from "../components/status-badge.js";
import { getSessionForRole } from "../state/session-store.js";
import { apiClient } from "../state/api-client.js";
import { selectAutoDispatchRole } from "../state/message-navigation.js";

export interface TaskWorkspaceProps {
  task: TaskRecord;
  activeRole: RoleName;
  translationEnabled: boolean;
  refreshNonce?: number;
  onTaskChanged(): Promise<void>;
  onActiveRoleChange(role: RoleName): void;
  onTranslationEnabledChange(enabled: boolean): void;
  onMessagesChanged?(messages: VcmRoleMessage[]): void;
  onOrchestrationChanged?(orchestration: VcmOrchestrationState): void;
  onRoundStateChanged?(roundState: VcmSessionRoundState): void;
  onEventsChanged?(events: string[]): void;
  onLaunchStateChanged?(state: TaskWorkspaceLaunchState): void;
}

export interface TaskWorkspaceLaunchState {
  taskSlug: string;
  roles: Record<RoleName, {
    permissionMode: ClaudePermissionMode;
    model: ClaudeModel;
  }>;
  autoOrchestration: boolean;
  translationEnabled: boolean;
  statusLoaded: boolean;
  sessionCount: number;
  hasAnySession: boolean;
  allRolesHaveSession: boolean;
}

export function TaskWorkspace({
  task,
  activeRole,
  translationEnabled,
  refreshNonce = 0,
  onTaskChanged,
  onActiveRoleChange,
  onTranslationEnabledChange,
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
    reviewer: "default"
  });
  const [models, setModels] = useState<Record<RoleName, ClaudeModel>>({
    "project-manager": "default",
    architect: "default",
    coder: "default",
    reviewer: "default"
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [orchestration, setOrchestration] = useState<VcmOrchestrationState | null>(null);
  const [codexReview, setCodexReview] = useState<CodexReviewIndex | null>(null);
  const messageSnapshotRef = useRef<{ taskSlug: string; messages: VcmRoleMessage[] } | null>(null);

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

  const applyFetchedState = useCallback((nextStatusReport: TaskStatusReport, nextMessages: VcmRoleMessage[], nextOrchestration: VcmOrchestrationState, nextRoundState: VcmSessionRoundState, nextCodexReview: CodexReviewIndex) => {
    setStatusReport(nextStatusReport);
    setCodexReview(nextCodexReview);
    applyMessageState(nextMessages, nextOrchestration);
    onRoundStateChanged?.(nextRoundState);
  }, [applyMessageState, onRoundStateChanged]);

  const refresh = useCallback(async () => {
    const [nextStatusReport, nextMessages, nextOrchestration, nextRoundState, nextCodexReview] = await Promise.all([
      apiClient.getTaskStatus(task.taskSlug),
      apiClient.listMessages(task.taskSlug),
      apiClient.getOrchestrationState(task.taskSlug),
      apiClient.getSessionRoundState(task.taskSlug),
      apiClient.getCodexReviewState(task.taskSlug)
    ]);
    applyFetchedState(nextStatusReport, nextMessages, nextOrchestration, nextRoundState, nextCodexReview);
  }, [applyFetchedState, task.taskSlug]);

  useEffect(() => {
    void refresh().catch((caught: Error) => setError(caught.message));
  }, [refresh, refreshNonce]);

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
    const sessions = statusReport?.sessions ?? [];
    const sessionRoles = new Set(sessions.map((session) => session.role));
    const roles = {} as TaskWorkspaceLaunchState["roles"];
    for (const definition of ROLE_DEFINITIONS) {
      roles[definition.name] = {
        permissionMode: permissionModes[definition.name],
        model: models[definition.name]
      };
    }

    onLaunchStateChanged?.({
      taskSlug: task.taskSlug,
      roles,
      autoOrchestration: (orchestration?.mode ?? "auto") === "auto",
      translationEnabled,
      statusLoaded: Boolean(statusReport),
      sessionCount: sessions.length,
      hasAnySession: sessions.length > 0,
      allRolesHaveSession: ROLE_DEFINITIONS.every((definition) => sessionRoles.has(definition.name))
    });
  }, [
    models,
    onLaunchStateChanged,
    orchestration?.mode,
    permissionModes,
    statusReport,
    task.taskSlug,
    translationEnabled
  ]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void Promise.all([
        apiClient.getTaskStatus(task.taskSlug),
        apiClient.listMessages(task.taskSlug),
        apiClient.getOrchestrationState(task.taskSlug),
        apiClient.getSessionRoundState(task.taskSlug),
        apiClient.getCodexReviewState(task.taskSlug)
      ])
        .then(([nextStatusReport, nextMessages, nextOrchestration, nextRoundState, nextCodexReview]) => {
          applyFetchedState(nextStatusReport, nextMessages, nextOrchestration, nextRoundState, nextCodexReview);
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
    }, 200);

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

  function setRoleModel(role: RoleName, model: ClaudeModel) {
    setModels((current) => ({
      ...current,
      [role]: model
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

  async function requestCodexReview(gate: CodexReviewGate) {
    await runAction(async () => {
      const result = await apiClient.requestCodexReviewGate(task.taskSlug, gate);
      appendEvent(`codex ${gate}: ${result.status}`);
    });
  }

  async function retryCodexReview(gate: CodexReviewGate) {
    await runAction(async () => {
      const result = await apiClient.retryCodexReviewGate(task.taskSlug, gate);
      appendEvent(`codex ${gate}: retry ${result.status}`);
    });
  }

  async function skipCodexReview(gate: CodexReviewGate) {
    const reason = window.prompt(`Skip Codex review gate "${gate}"? Enter the reason.`);
    if (!reason?.trim()) {
      return;
    }
    await runAction(async () => {
      const next = await apiClient.skipCodexReviewGate(task.taskSlug, gate, { reason });
      setCodexReview(next);
      appendEvent(`codex ${gate}: skipped`);
    });
  }

  async function overrideCodexReview(gate: CodexReviewGate) {
    const reason = window.prompt(`Override Codex review gate "${gate}"? Enter the reason.`);
    if (!reason?.trim()) {
      return;
    }
    await runAction(async () => {
      const next = await apiClient.overrideCodexReviewGate(task.taskSlug, gate, { reason });
      setCodexReview(next);
      appendEvent(`codex ${gate}: overridden`);
    });
  }

  return (
    <div className="task-workspace">
      <header className="workspace-header">
        <div className="workspace-title-line">
          <h1>{task.title || task.taskSlug}</h1>
        </div>
        <RoleSessionTabs
          activeRole={activeRole}
          sessions={statusReport?.sessions ?? []}
          onSelect={onActiveRoleChange}
        />
        <div className="workspace-header-actions">
          <button
            aria-pressed={translationEnabled}
            className={`translation-toggle${translationEnabled ? " is-active" : ""}`}
            type="button"
            onClick={() => onTranslationEnabledChange(!translationEnabled)}
          >
            {translationEnabled ? "✅ Translate" : "× Translate"}
          </button>
          <button className="danger-button" type="button" disabled={busy} onClick={() => void closeTask()}>
            Close Task
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {codexReview ? (
        <section className="codex-review-panel">
          <div className="codex-review-panel-header">
            <h2>Codex Review Gates</h2>
            <span>{codexReview.enabled ? "enabled" : "disabled"}</span>
          </div>
          <div className="codex-review-gates">
            {CODEX_REVIEW_GATES.map((gate) => {
              const record = codexReview.gates[gate];
              const canRequest = codexReview.enabled
                && record.required
                && record.status !== "running";
              const canHandleFailure = record.status === "failed";
              return (
                <div className="codex-review-gate" key={gate}>
                  <div className="codex-review-gate-main">
                    <strong>{formatCodexGate(gate)}</strong>
                    <StatusBadge status={record.status} />
                    {record.decision ? <span className="codex-review-decision">{record.decision}</span> : null}
                    {record.callbackStatus && record.callbackStatus !== "not_sent" ? (
                      <span className="codex-review-callback">callback {record.callbackStatus}</span>
                    ) : null}
                  </div>
                  <div className="codex-review-gate-meta">
                    <span>{record.required ? "required" : "optional"}</span>
                    <span>{record.reportPath}</span>
                    {record.error ? <span className="codex-review-error">{record.error}</span> : null}
                  </div>
                  <div className="codex-review-actions">
                    <button type="button" disabled={busy || !canRequest} onClick={() => void requestCodexReview(gate)}>
                      {record.status === "completed" || record.status === "failed" ? "Run Again" : "Run"}
                    </button>
                    {canHandleFailure ? (
                      <>
                        <button type="button" disabled={busy} onClick={() => void retryCodexReview(gate)}>Retry</button>
                        <button type="button" disabled={busy} onClick={() => void skipCodexReview(gate)}>Skip</button>
                        <button type="button" disabled={busy} onClick={() => void overrideCodexReview(gate)}>Override</button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

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
                    model={models[role]}
                    active={isActive}
                    busy={busy}
                    orchestrationMode={orchestration?.mode ?? "auto"}
                    translationEnabled={translationEnabled}
                    onPermissionModeChange={(permissionMode) => setRolePermissionMode(role, permissionMode)}
                    onModelChange={(model) => setRoleModel(role, model)}
                    onOrchestrationModeChange={(mode) => void setOrchestrationMode(mode)}
                    onStart={() => void runAction(async () => {
                      await apiClient.startRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role]
                      });
                      appendEvent(`started ${role} with ${permissionModes[role]} / ${models[role]}`);
                    })}
                    onResume={() => void runAction(async () => {
                      await apiClient.resumeRoleSession(task.taskSlug, role, {
                        cols: 100,
                        rows: 28,
                        permissionMode: permissionModes[role],
                        model: models[role]
                      });
                      appendEvent(`resumed ${role} with ${permissionModes[role]} / ${models[role]}`);
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
                        model: models[role]
                      });
                      appendEvent(`restarted ${role} with ${permissionModes[role]} / ${models[role]}`);
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

function formatCodexGate(gate: CodexReviewGate): string {
  return gate.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
