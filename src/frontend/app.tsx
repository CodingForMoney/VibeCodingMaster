import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import {
  createDefaultLaunchTemplate,
  type AppPreferences,
  type LaunchTemplate,
  type PermissionRequestMode,
  type ThemeMode
} from "../shared/types/app-settings.js";
import { ROLE_DEFINITIONS } from "../shared/constants.js";
import type {
  HarnessApplyResult,
  HarnessBootstrapStatusReport,
  HarnessStatusReport
} from "../shared/types/harness.js";
import type {
  CheckGatewayQrLoginResult,
  GatewayStatus,
  StartGatewayQrLoginResult
} from "../shared/types/gateway.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../shared/types/message.js";
import type { ProjectSummary } from "../shared/types/project.js";
import type { RoleName } from "../shared/types/role.js";
import type { VcmSessionRoundState } from "../shared/types/round.js";
import type { TaskRecord } from "../shared/types/task.js";
import { AppShell } from "./components/app-shell.js";
import { selectActiveTask } from "./state/app-store.js";
import { apiClient } from "./state/api-client.js";
import { ProjectDashboard } from "./routes/project-dashboard.js";
import { TaskWorkspace, type TaskWorkspaceLaunchState } from "./routes/task-workspace.js";

const FLOW_PAUSE_STRONG_ALERT_THRESHOLD_MS = 2 * 60 * 1000;
const FLOW_PAUSE_CHIME_INTERVAL_MS = 1400;
const FLOW_PAUSE_WEAK_CHIME_COUNT = 3;

export function App() {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [recentRepositoryPaths, setRecentRepositoryPaths] = useState<string[]>([]);
  const [harnessStatus, setHarnessStatus] = useState<HarnessStatusReport | null>(null);
  const [harnessBootstrapStatus, setHarnessBootstrapStatus] = useState<HarnessBootstrapStatusReport | null>(null);
  const [harnessApplyResult, setHarnessApplyResult] = useState<HarnessApplyResult | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [gatewayQrLogin, setGatewayQrLogin] = useState<StartGatewayQrLoginResult | null>(null);
  const [gatewayQrCheck, setGatewayQrCheck] = useState<CheckGatewayQrLoginResult | null>(null);
  const [gatewayQrModalOpen, setGatewayQrModalOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [activeTaskSlug, setActiveTaskSlug] = useState<string | null>(null);
  const [activeMessages, setActiveMessages] = useState<{ taskSlug: string; messages: VcmRoleMessage[] } | null>(null);
  const [activeOrchestration, setActiveOrchestration] = useState<{ taskSlug: string; orchestration: VcmOrchestrationState } | null>(null);
  const [activeEvents, setActiveEvents] = useState<{ taskSlug: string; events: string[] } | null>(null);
  const [activeSessionRoundState, setActiveSessionRoundState] = useState<{ taskSlug: string; roundState: VcmSessionRoundState } | null>(null);
  const [activeRole, setActiveRole] = useState<RoleName>("project-manager");
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [flowPauseAlerts, setFlowPauseAlerts] = useState(true);
  const [permissionRequestMode, setPermissionRequestMode] = useState<PermissionRequestMode>("off");
  const [launchTemplate, setLaunchTemplate] = useState<LaunchTemplate>(() => createDefaultLaunchTemplate());
  const [activeLaunchState, setActiveLaunchState] = useState<TaskWorkspaceLaunchState | null>(null);
  const [translationEnabledByTask, setTranslationEnabledByTask] = useState<Record<string, boolean>>({});
  const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0);
  const [flowPauseNotice, setFlowPauseNotice] = useState<{ id: string; text: string } | null>(null);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notifiedFlowPauseKeyRef = useRef<Record<string, string>>({});
  const flowPauseAlarmRef = useRef<number | null>(null);
  const gatewayContextSyncKeyRef = useRef("");
  const activeTask = useMemo(
    () => selectActiveTask(tasks, activeTaskSlug),
    [tasks, activeTaskSlug]
  );
  const activeTranslationEnabled = activeTask
    ? translationEnabledByTask[activeTask.taskSlug] ?? false
    : false;
  const activeTaskLaunchState = activeLaunchState?.taskSlug === activeTask?.taskSlug
    ? activeLaunchState
    : null;
  const canSaveLaunchTemplate = Boolean(activeTaskLaunchState?.statusLoaded && activeTaskLaunchState.allRolesHaveSession);
  const canOneClickStart = Boolean(activeTask && activeTaskLaunchState?.statusLoaded && !activeTaskLaunchState.hasAnySession);

  const applyPreferences = useCallback((preferences: AppPreferences) => {
    setThemeMode(preferences.themeMode);
    setFlowPauseAlerts(preferences.flowPauseAlerts);
    setPermissionRequestMode(preferences.permissionRequestMode);
    setLaunchTemplate(preferences.launchTemplate);
  }, []);

  const stopFlowPauseAlarm = useCallback(() => {
    if (flowPauseAlarmRef.current === null) {
      return;
    }
    window.clearInterval(flowPauseAlarmRef.current);
    flowPauseAlarmRef.current = null;
  }, []);

  const startStrongFlowPauseAlarm = useCallback((options: { resetAudio?: boolean } = {}) => {
    stopFlowPauseAlarm();
    if (options.resetAudio) {
      resetFlowPauseAudioContext();
    }
    void playFlowPauseSound();
    flowPauseAlarmRef.current = window.setInterval(() => {
      void playFlowPauseSound();
    }, FLOW_PAUSE_CHIME_INTERVAL_MS);
  }, [stopFlowPauseAlarm]);

  const playWeakFlowPauseAlert = useCallback(() => {
    stopFlowPauseAlarm();
    setFlowPauseNotice(null);
    let playCount = 1;
    void playFlowPauseSound();
    flowPauseAlarmRef.current = window.setInterval(() => {
      playCount += 1;
      void playFlowPauseSound();
      if (playCount >= FLOW_PAUSE_WEAK_CHIME_COUNT && flowPauseAlarmRef.current !== null) {
        window.clearInterval(flowPauseAlarmRef.current);
        flowPauseAlarmRef.current = null;
      }
    }, FLOW_PAUSE_CHIME_INTERVAL_MS);
  }, [stopFlowPauseAlarm]);

  const showStrongFlowPauseNotice = useCallback((
    text: string,
    id = `manual-${Date.now()}`,
    options: { resetAudio?: boolean } = {}
  ) => {
    setFlowPauseNotice({ id, text });
    startStrongFlowPauseAlarm(options);
  }, [startStrongFlowPauseAlarm]);

  const confirmFlowPauseNotice = useCallback(() => {
    stopFlowPauseAlarm();
    setFlowPauseNotice(null);
  }, [stopFlowPauseAlarm]);

  const disableFlowPauseAlerts = useCallback(() => {
    stopFlowPauseAlarm();
    setFlowPauseNotice(null);
    setFlowPauseAlerts(false);
  }, [stopFlowPauseAlarm]);

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

  const handleRoundStateChanged = useCallback((roundState: VcmSessionRoundState) => {
    if (!activeTask?.taskSlug || roundState.taskSlug !== activeTask.taskSlug) {
      return;
    }
    setActiveSessionRoundState({ taskSlug: roundState.taskSlug, roundState });
    if (roundState.status !== "stopped" || !roundState.roundId) {
      return;
    }

    const pauseKey = getFlowPauseNotificationKey(roundState);
    const previousPauseKey = notifiedFlowPauseKeyRef.current[roundState.taskSlug];
    if (previousPauseKey === pauseKey) {
      return;
    }

    if (!flowPauseAlerts) {
      return;
    }

    const roleLabel = roundState.activeRole ?? "role";
    if (getFlowPauseDurationMs(roundState) >= FLOW_PAUSE_STRONG_ALERT_THRESHOLD_MS) {
      showStrongFlowPauseNotice(`No new turn started after ${roleLabel} stopped.`, pauseKey);
    } else {
      playWeakFlowPauseAlert();
    }
    notifiedFlowPauseKeyRef.current[roundState.taskSlug] = pauseKey;
  }, [activeTask?.taskSlug, flowPauseAlerts, playWeakFlowPauseAlert, showStrongFlowPauseNotice]);

  const handleLaunchStateChanged = useCallback((launchState: TaskWorkspaceLaunchState) => {
    setActiveLaunchState((current) => {
      if (
        current?.taskSlug === launchState.taskSlug &&
        current.statusLoaded === launchState.statusLoaded &&
        current.sessionCount === launchState.sessionCount &&
        current.hasAnySession === launchState.hasAnySession &&
        current.allRolesHaveSession === launchState.allRolesHaveSession &&
        current.autoOrchestration === launchState.autoOrchestration &&
        current.translationEnabled === launchState.translationEnabled &&
        JSON.stringify(current.roles) === JSON.stringify(launchState.roles)
      ) {
        return current;
      }
      return launchState;
    });
  }, []);

  async function loadTasks() {
    const nextTasks = await apiClient.listTasks();
    setTasks(nextTasks);
    setActiveTaskSlug((current) => {
      if (current && nextTasks.some((task) => task.taskSlug === current)) {
        return current;
      }
      return nextTasks[0]?.taskSlug ?? null;
    });
    return nextTasks;
  }

  async function loadHarnessStatus() {
    const nextStatus = await apiClient.getHarnessStatus();
    setHarnessStatus(nextStatus);
    return nextStatus;
  }

  async function loadHarnessBootstrapStatus() {
    const nextStatus = await apiClient.getHarnessBootstrapStatus();
    setHarnessBootstrapStatus(nextStatus);
    return nextStatus;
  }

  async function loadGatewayStatus() {
    const nextStatus = await apiClient.getGatewayStatus();
    setGatewayStatus(nextStatus);
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
      apiClient.getRecentRepositoryPaths(),
      apiClient.getAppPreferences(),
      apiClient.getGatewayStatus()
    ])
      .then(async ([currentProject, recentPaths, preferences, nextGatewayStatus]) => {
        setProject(currentProject);
        setRecentRepositoryPaths(recentPaths);
        setGatewayStatus(nextGatewayStatus);
        applyPreferences(preferences);
        if (currentProject) {
          await Promise.all([
            loadTasks(),
            loadHarnessStatus(),
            loadHarnessBootstrapStatus()
          ]);
        }
      })
      .catch((caught: Error) => setError(caught.message));
  }, [applyPreferences]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () => setSystemPrefersDark(query.matches);
    updateSystemTheme();
    query.addEventListener("change", updateSystemTheme);
    return () => query.removeEventListener("change", updateSystemTheme);
  }, []);

  useEffect(() => {
    return () => stopFlowPauseAlarm();
  }, [stopFlowPauseAlarm]);

  useEffect(() => {
    const resolvedTheme = themeMode === "system"
      ? systemPrefersDark ? "dark" : "light"
      : themeMode;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = themeMode;
  }, [systemPrefersDark, themeMode]);

  useEffect(() => {
    if (!gatewayStatus?.enabled || !flowPauseAlerts) {
      return;
    }

    disableFlowPauseAlerts();
    void apiClient.updateAppPreferences({ flowPauseAlerts: false })
      .then((preferences) => applyPreferences(preferences))
      .catch((caught: Error) => setError(caught.message));
  }, [applyPreferences, disableFlowPauseAlerts, flowPauseAlerts, gatewayStatus?.enabled]);

  useEffect(() => {
    if (!gatewayStatus?.enabled || !project || !activeTask) {
      return;
    }

    const syncKey = `${project.repoRoot}:${activeTask.taskSlug}`;
    if (
      gatewayStatus.currentProjectId === project.repoRoot &&
      gatewayStatus.currentTaskSlug === activeTask.taskSlug
    ) {
      gatewayContextSyncKeyRef.current = syncKey;
      return;
    }
    if (gatewayContextSyncKeyRef.current === syncKey) {
      return;
    }

    gatewayContextSyncKeyRef.current = syncKey;
    void apiClient.updateGatewaySettings({
      currentProjectId: project.repoRoot,
      currentTaskSlug: activeTask.taskSlug
    })
      .then((nextStatus) => setGatewayStatus(nextStatus))
      .catch((caught: Error) => {
        if (gatewayContextSyncKeyRef.current === syncKey) {
          gatewayContextSyncKeyRef.current = "";
        }
        setError(caught.message);
      });
  }, [
    activeTask?.taskSlug,
    gatewayStatus?.currentProjectId,
    gatewayStatus?.currentTaskSlug,
    gatewayStatus?.enabled,
    project?.repoRoot
  ]);

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
  const sidebarRoundState =
    activeSessionRoundState && activeSessionRoundState.taskSlug === activeTask?.taskSlug
      ? activeSessionRoundState.roundState
      : null;

  return (
    <AppShell
      sidebar={(
        <ProjectDashboard
          project={project}
          recentRepositoryPaths={recentRepositoryPaths}
          tasks={tasks}
          activeTaskSlug={activeTask?.taskSlug ?? null}
          messages={sidebarMessages}
          orchestration={sidebarOrchestration}
          events={sidebarEvents}
          roundState={sidebarRoundState}
          harnessStatus={harnessStatus}
          harnessBootstrapStatus={harnessBootstrapStatus}
          harnessApplyResult={harnessApplyResult}
          gatewayStatus={gatewayStatus}
          gatewayQrLogin={gatewayQrLogin}
          gatewayQrCheck={gatewayQrCheck}
          busy={busy}
          onConnect={(repoPath) => withBusy(async () => {
            const nextProject = await apiClient.connectProject({ repoPath });
            setProject(nextProject);
            setHarnessApplyResult(null);
            await Promise.all([
              loadTasks(),
              loadHarnessStatus(),
              loadHarnessBootstrapStatus(),
              loadRecentRepositoryPaths()
            ]);
          })}
          onRefreshConnectedRepository={() => withBusy(async () => {
            const nextProject = await apiClient.getCurrentProject();
            setProject(nextProject);
          })}
          onPullConnectedRepository={() => withBusy(async () => {
            const nextProject = await apiClient.pullCurrentProject();
            setProject(nextProject);
          })}
          onRefreshHarness={() => withBusy(async () => {
            setHarnessApplyResult(null);
            await Promise.all([
              loadHarnessStatus(),
              loadHarnessBootstrapStatus()
            ]);
          })}
          onApplyHarness={() => withBusy(async () => {
            const result = await apiClient.applyHarness();
            setHarnessApplyResult(result);
            await Promise.all([
              loadHarnessStatus(),
              loadHarnessBootstrapStatus()
            ]);
          })}
          onStartHarnessBootstrap={() => withBusy(async () => {
            const result = await apiClient.startHarnessBootstrap();
            setHarnessBootstrapStatus(result.status);
          })}
          onRefreshGateway={() => withBusy(async () => {
            await loadGatewayStatus();
          })}
          onGatewayEnabledChange={(enabled) => {
            void withBusy(async () => {
              const [nextStatus, preferences] = await Promise.all([
                apiClient.updateGatewaySettings({
                  enabled,
                  ...(enabled && project ? {
                    currentProjectId: project.repoRoot,
                    currentTaskSlug: activeTask?.taskSlug ?? null
                  } : {})
                }),
                enabled
                  ? apiClient.updateAppPreferences({ flowPauseAlerts: false })
                  : Promise.resolve(null)
              ]);
              if (preferences) {
                applyPreferences(preferences);
              }
              if (enabled) {
                disableFlowPauseAlerts();
              }
              setGatewayStatus(nextStatus);
            });
          }}
          onGatewayTranslationChange={(enabled) => {
            void withBusy(async () => {
              const nextStatus = await apiClient.updateGatewaySettings({ translationEnabled: enabled });
              setGatewayStatus(nextStatus);
            });
          }}
          onStartGatewayQrLogin={() => {
            void withBusy(async () => {
              const result = await apiClient.startGatewayQrLogin();
              setGatewayQrLogin(result);
              setGatewayQrCheck(null);
              setGatewayQrModalOpen(true);
              await loadGatewayStatus();
            });
          }}
          onResetGatewayBinding={() => {
            void withBusy(async () => {
              const nextStatus = await apiClient.resetGatewayBinding();
              setGatewayStatus(nextStatus);
              setGatewayQrLogin(null);
              setGatewayQrCheck(null);
              setGatewayQrModalOpen(false);
            });
          }}
          onCreateTask={(input) => withBusy(async () => {
            const task = await apiClient.createTask(input);
            await loadTasks();
            setActiveTaskSlug(task.taskSlug);
          })}
          onSelectTask={setActiveTaskSlug}
          themeMode={themeMode}
          onThemeModeChange={(nextThemeMode) => {
            setThemeMode(nextThemeMode);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ themeMode: nextThemeMode });
              applyPreferences(preferences);
            });
          }}
          flowPauseAlerts={flowPauseAlerts}
          onFlowPauseAlertsChange={(enabled) => {
            if (gatewayStatus?.enabled) {
              disableFlowPauseAlerts();
              return;
            }
            setFlowPauseAlerts(enabled);
            if (enabled) {
              void primeFlowPauseAudio();
            }
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ flowPauseAlerts: enabled });
              applyPreferences(preferences);
            });
          }}
          permissionRequestMode={permissionRequestMode}
          onPermissionRequestModeChange={(nextMode) => {
            setPermissionRequestMode(nextMode);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ permissionRequestMode: nextMode });
              applyPreferences(preferences);
            });
          }}
          launchTemplate={launchTemplate}
          canSaveLaunchTemplate={canSaveLaunchTemplate}
          canOneClickStart={canOneClickStart}
          onSaveLaunchTemplate={() => {
            void withBusy(async () => {
              if (!activeTaskLaunchState?.allRolesHaveSession) {
                throw new Error("Start all four role sessions before saving a launch template.");
              }

              const preferences = await apiClient.updateAppPreferences({
                launchTemplate: {
                  version: 1,
                  roles: activeTaskLaunchState.roles,
                  autoOrchestration: activeTaskLaunchState.autoOrchestration,
                  translationEnabled: activeTaskLaunchState.translationEnabled
                }
              });
              applyPreferences(preferences);
            });
          }}
          onOneClickStart={() => {
            void withBusy(async () => {
              if (!activeTask) {
                throw new Error("Create or select a task before one-click start.");
              }

              const status = await apiClient.getTaskStatus(activeTask.taskSlug);
              if (status.sessions.length > 0) {
                throw new Error("One-click start is only available before any role session has started.");
              }

              setTranslationEnabledByTask((current) => ({
                ...current,
                [activeTask.taskSlug]: launchTemplate.translationEnabled
              }));
              const nextOrchestration = await apiClient.updateOrchestrationState(activeTask.taskSlug, {
                mode: launchTemplate.autoOrchestration ? "auto" : "manual"
              });
              setActiveOrchestration({
                taskSlug: activeTask.taskSlug,
                orchestration: nextOrchestration
              });

              for (const definition of ROLE_DEFINITIONS) {
                const roleTemplate = launchTemplate.roles[definition.name];
                await apiClient.startRoleSession(activeTask.taskSlug, definition.name, {
                  cols: 100,
                  rows: 28,
                  permissionMode: roleTemplate.permissionMode,
                  model: roleTemplate.model
                });
              }

              setActiveRole("project-manager");
              await refreshMessageState(activeTask.taskSlug);
              await loadTasks();
              setWorkspaceRefreshNonce((current) => current + 1);
            });
          }}
          onTryFlowPauseAlert={() => {
            showStrongFlowPauseNotice("This is a test flow pause alert.", undefined, { resetAudio: true });
          }}
          onMarkAllMessagesDone={(taskSlug) => {
            void withBusy(async () => {
              const result = await apiClient.markAllMessagesDone(taskSlug);
              setActiveMessages({ taskSlug, messages: result.messages });
              await refreshMessageState(taskSlug);
            });
          }}
          onDeleteMessageHistory={(taskSlug) => {
            void withBusy(async () => {
              const result = await apiClient.deleteMessageHistory(taskSlug);
              setActiveMessages({ taskSlug, messages: result.messages });
              await refreshMessageState(taskSlug);
            });
          }}
        />
      )}
    >
      {error ? <div className="error-banner">{error}</div> : null}
      {flowPauseNotice ? (
        <div className="flow-pause-alert-backdrop">
          <section
            aria-describedby="flow-pause-alert-body flow-pause-alert-hint"
            aria-labelledby="flow-pause-alert-title"
            aria-modal="true"
            className="flow-pause-alert"
            role="alertdialog"
          >
            <p className="flow-pause-alert-kicker">VCM needs attention</p>
            <h2 id="flow-pause-alert-title">Flow needs attention</h2>
            <p id="flow-pause-alert-body">{flowPauseNotice.text}</p>
            <p id="flow-pause-alert-hint" className="flow-pause-alert-hint">
              The task may be complete, waiting for your decision, or blocked by a workflow issue.
            </p>
            <button type="button" autoFocus onClick={confirmFlowPauseNotice}>
              Confirm
            </button>
          </section>
        </div>
      ) : null}
      {gatewayQrModalOpen && gatewayQrLogin ? (
        <GatewayQrLoginModal
          busy={busy}
          qrCheck={gatewayQrCheck}
          qrLogin={gatewayQrLogin}
          onCheck={() => {
            void withBusy(async () => {
              const result = await apiClient.checkGatewayQrLogin();
              setGatewayQrCheck(result);
              if (result.status === "confirmed" || result.status === "binded_redirect") {
                setGatewayQrModalOpen(false);
              }
              await loadGatewayStatus();
            });
          }}
          onClose={() => setGatewayQrModalOpen(false)}
        />
      ) : null}
      {project && activeTask ? (
        <TaskWorkspace
          task={activeTask}
          activeRole={activeRole}
          translationEnabled={activeTranslationEnabled}
          refreshNonce={workspaceRefreshNonce}
          onTaskChanged={async () => {
            await loadTasks();
          }}
          onActiveRoleChange={setActiveRole}
          onTranslationEnabledChange={(enabled) => {
            setTranslationEnabledByTask((current) => ({
              ...current,
              [activeTask.taskSlug]: enabled
            }));
          }}
          onMessagesChanged={handleMessagesChanged}
          onOrchestrationChanged={handleOrchestrationChanged}
          onRoundStateChanged={handleRoundStateChanged}
          onEventsChanged={handleEventsChanged}
          onLaunchStateChanged={handleLaunchStateChanged}
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

function GatewayQrLoginModal({
  busy,
  onCheck,
  onClose,
  qrCheck,
  qrLogin
}: {
  busy: boolean;
  onCheck(): void;
  onClose(): void;
  qrCheck: CheckGatewayQrLoginResult | null;
  qrLogin: StartGatewayQrLoginResult;
}) {
  const [qrImageSrc, setQrImageSrc] = useState("");
  const [qrError, setQrError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setQrError("");
    setQrImageSrc("");
    if (qrLogin.qrcodeUrl.startsWith("data:image/")) {
      setQrImageSrc(qrLogin.qrcodeUrl);
      return;
    }
    try {
      const qr = qrcode(0, "M");
      qr.addData(qrLogin.qrcodeUrl);
      qr.make();
      if (!cancelled) {
        setQrImageSrc(qr.createDataURL(8, 2));
      }
    } catch (error) {
      if (!cancelled) {
        setQrError(error instanceof Error ? error.message : "Failed to render QR code.");
      }
    }
    return () => {
      cancelled = true;
    };
  }, [qrLogin.qrcodeUrl]);

  return (
    <div className="modal-backdrop">
      <section
        aria-labelledby="gateway-qr-title"
        aria-modal="true"
        className="gateway-qr-modal"
        role="dialog"
      >
        <header>
          <div>
            <h2 id="gateway-qr-title">Weixin Gateway Login</h2>
            <p className="muted">Scan with Weixin, confirm on the phone, then click Confirm.</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <div className="gateway-qr-modal-body">
          <div className="gateway-qr-code-frame">
            {qrImageSrc ? (
              <img alt="Weixin Gateway QR login" src={qrImageSrc} />
            ) : (
              <div className="gateway-qr-placeholder">
                {qrError || "Rendering QR code..."}
              </div>
            )}
          </div>
          <dl className="gateway-qr-meta">
            <div>
              <dt>Status</dt>
              <dd>{qrCheck?.status ?? qrLogin.status}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{formatFullTime(qrLogin.expiresAt)}</dd>
            </div>
            {qrCheck?.message ? (
              <div>
                <dt>Message</dt>
                <dd>{qrCheck.message}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        <footer>
          <button type="button" disabled={busy} onClick={onCheck}>Confirm</button>
        </footer>
      </section>
    </div>
  );
}

function formatFullTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

type AudioContextWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

let flowPauseAudioContext: AudioContext | null = null;

function getFlowPauseDurationMs(roundState: VcmSessionRoundState): number {
  const startedAt = Date.parse(roundState.startedAt ?? "");
  const endedAt = Date.parse(roundState.stoppedAt ?? roundState.lastTurnEndedAt ?? "");
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return 0;
  }
  return Math.max(0, endedAt - startedAt);
}

function getFlowPauseNotificationKey(roundState: VcmSessionRoundState): string {
  const roundKey = roundState.roundId ?? roundState.startedAt ?? roundState.taskSlug;
  const stoppedKey = roundState.stoppedAt ?? roundState.lastTurnEndedAt ?? "stopped";
  return `${roundKey}:${stoppedKey}`;
}

async function primeFlowPauseAudio(): Promise<boolean> {
  const context = getFlowPauseAudioContext();
  if (!context) {
    return false;
  }
  return resumeFlowPauseAudioContext(context);
}

async function playFlowPauseSound(): Promise<boolean> {
  const context = getFlowPauseAudioContext();
  if (!context) {
    return false;
  }

  const audioReady = await resumeFlowPauseAudioContext(context);
  if (!audioReady) {
    return false;
  }

  try {
    const masterGain = context.createGain();
    const startAt = context.currentTime + 0.025;

    masterGain.gain.setValueAtTime(0.85, context.currentTime);
    masterGain.connect(context.destination);
    scheduleCompletionChimeNote(context, masterGain, {
      frequency: 587.33,
      startAt,
      duration: 0.18,
      peakGain: 0.045
    });
    scheduleCompletionChimeNote(context, masterGain, {
      frequency: 783.99,
      startAt: startAt + 0.11,
      duration: 0.28,
      peakGain: 0.055
    });
    window.setTimeout(() => {
      masterGain.disconnect();
    }, 800);
    return true;
  } catch {
    return false;
  }
}

function getFlowPauseAudioContext(): AudioContext | null {
  const AudioContextCtor = window.AudioContext ?? (window as AudioContextWindow).webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  try {
    if (!flowPauseAudioContext || flowPauseAudioContext.state === "closed") {
      flowPauseAudioContext = new AudioContextCtor();
    }
    return flowPauseAudioContext;
  } catch {
    return null;
  }
}

function resetFlowPauseAudioContext(): void {
  discardFlowPauseAudioContext(flowPauseAudioContext);
}

function discardFlowPauseAudioContext(context: AudioContext | null): void {
  flowPauseAudioContext = null;
  if (context && context.state !== "closed") {
    void context.close().catch(() => undefined);
  }
}

async function resumeFlowPauseAudioContext(context: AudioContext): Promise<boolean> {
  if (isFlowPauseAudioContextRunning(context)) {
    return true;
  }
  try {
    await context.resume();
    const resumed = isFlowPauseAudioContextRunning(context);
    if (!resumed && context === flowPauseAudioContext) {
      discardFlowPauseAudioContext(context);
    }
    return resumed;
  } catch {
    // Browser autoplay policy can block audio until the page has user activation.
    if (context === flowPauseAudioContext) {
      discardFlowPauseAudioContext(context);
    }
    return false;
  }
}

function isFlowPauseAudioContextRunning(context: AudioContext): boolean {
  return context.state === "running";
}

function scheduleCompletionChimeNote(
  context: AudioContext,
  destination: AudioNode,
  note: {
    frequency: number;
    startAt: number;
    duration: number;
    peakGain: number;
  }
): void {
  const noteGain = context.createGain();
  const fundamental = context.createOscillator();
  const shimmer = context.createOscillator();
  const endAt = note.startAt + note.duration;

  noteGain.gain.setValueAtTime(0.0001, note.startAt);
  noteGain.gain.exponentialRampToValueAtTime(note.peakGain, note.startAt + 0.018);
  noteGain.gain.exponentialRampToValueAtTime(0.0001, endAt);

  fundamental.type = "sine";
  fundamental.frequency.setValueAtTime(note.frequency, note.startAt);
  shimmer.type = "triangle";
  shimmer.frequency.setValueAtTime(note.frequency * 2.01, note.startAt);

  fundamental.connect(noteGain);
  shimmer.connect(noteGain);
  noteGain.connect(destination);

  fundamental.start(note.startAt);
  shimmer.start(note.startAt);
  fundamental.stop(endAt + 0.02);
  shimmer.stop(endAt + 0.02);
}
