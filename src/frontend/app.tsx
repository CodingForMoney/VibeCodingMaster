import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import {
  createDefaultLaunchTemplate,
  DEFAULT_TRANSLATION_OUTPUT_MODE,
  DEFAULT_TRANSLATION_TARGET_LANGUAGE,
  type AppPreferences,
  type LaunchTemplate,
  type PermissionRequestMode,
  type TranslationOutputMode,
  type TranslationTargetLanguage,
  type ThemeMode
} from "../shared/types/app-settings.js";
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
import type { GateReviewGate, GateReviewIndex } from "../shared/types/gate-review.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../shared/types/message.js";
import type { ProjectSummary } from "../shared/types/project.js";
import type { RoleName } from "../shared/types/role.js";
import type { VcmSessionRoundState } from "../shared/types/round.js";
import type { ClaudePermissionMode, RoleSessionRecord, SessionEffort, SessionModel } from "../shared/types/session.js";
import type { TaskRecord } from "../shared/types/task.js";
import { CORE_VCM_ROLE_NAMES } from "../shared/constants.js";
import { AppShell } from "./components/app-shell.js";
import { HarnessStudioModal } from "./components/harness-studio-modal.js";
import { RepositoryDiffModal } from "./components/repository-diff-modal.js";
import { TranslatorSessionModal } from "./components/translator-session-modal.js";
import { FileTranslationModalHost } from "./components/translation-panel.js";
import { selectActiveTask } from "./state/app-store.js";
import { apiClient } from "./state/api-client.js";
import { buildOneClickRoleLaunches } from "./state/one-click-start.js";
import { ProjectDashboard } from "./routes/project-dashboard.js";
import { TaskWorkspace, type TaskWorkspaceLaunchState } from "./routes/task-workspace.js";

const FLOW_PAUSE_STRONG_ALERT_THRESHOLD_MS = 2 * 60 * 1000;
const FLOW_PAUSE_CHIME_INTERVAL_MS = 1400;
const FLOW_PAUSE_WEAK_CHIME_COUNT = 3;

function isTranslationHarnessReady(harnessStatus: HarnessStatusReport | null): boolean {
  return Boolean(harnessStatus?.initialized);
}

export function App() {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [recentRepositoryPaths, setRecentRepositoryPaths] = useState<string[]>([]);
  const [harnessStatus, setHarnessStatus] = useState<HarnessStatusReport | null>(null);
  const [harnessBootstrapStatus, setHarnessBootstrapStatus] = useState<HarnessBootstrapStatusReport | null>(null);
  const [harnessStatusTaskSlug, setHarnessStatusTaskSlug] = useState<string | null>(null);
  const [harnessBootstrapStatusTaskSlug, setHarnessBootstrapStatusTaskSlug] = useState<string | null>(null);
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
  const [activeGateReview, setActiveGateReview] = useState<{ taskSlug: string; state: GateReviewIndex } | null>(null);
  const [activeRole, setActiveRole] = useState<RoleName>("project-manager");
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [flowPauseAlerts, setFlowPauseAlerts] = useState(true);
  const [permissionRequestMode, setPermissionRequestMode] = useState<PermissionRequestMode>("off");
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationAutoSendEnabled, setTranslationAutoSendEnabled] = useState(false);
  const [translationTargetLanguage, setTranslationTargetLanguage] = useState<TranslationTargetLanguage>(DEFAULT_TRANSLATION_TARGET_LANGUAGE);
  const [translationOutputMode, setTranslationOutputMode] = useState<TranslationOutputMode>(DEFAULT_TRANSLATION_OUTPUT_MODE);
  const [fileTranslationOpen, setFileTranslationOpen] = useState(false);
  const [translatorSessionOpen, setTranslatorSessionOpen] = useState(false);
  const [harnessStudioOpen, setHarnessStudioOpen] = useState(false);
  const [repositoryDiffOpen, setRepositoryDiffOpen] = useState(false);
  const [translatorSession, setTranslatorSession] = useState<RoleSessionRecord | null>(null);
  const [translatorPermissionMode, setTranslatorPermissionMode] = useState<ClaudePermissionMode>("default");
  const [translatorModel, setTranslatorModel] = useState<SessionModel>("default");
  const [translatorEffort, setTranslatorEffort] = useState<SessionEffort>("medium");
  const [harnessEngineerSession, setHarnessEngineerSession] = useState<RoleSessionRecord | null>(null);
  const [harnessEngineerPermissionMode, setHarnessEngineerPermissionMode] = useState<ClaudePermissionMode>("default");
  const [harnessEngineerModel, setHarnessEngineerModel] = useState<SessionModel>("default");
  const [harnessEngineerEffort, setHarnessEngineerEffort] = useState<SessionEffort>("medium");
  const [launchTemplate, setLaunchTemplate] = useState<LaunchTemplate>(() => createDefaultLaunchTemplate());
  const [activeLaunchState, setActiveLaunchState] = useState<TaskWorkspaceLaunchState | null>(null);
  const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0);
  const [flowPauseNotice, setFlowPauseNotice] = useState<{ id: string; text: string } | null>(null);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notifiedFlowPauseKeyRef = useRef<Record<string, string>>({});
  const flowPauseAlarmRef = useRef<number | null>(null);
  const gatewayContextSyncKeyRef = useRef("");
  const translatorEnsureKeyRef = useRef("");
  const harnessEngineerAutoResumeKeyRef = useRef("");
  const activeTask = useMemo(
    () => selectActiveTask(tasks, activeTaskSlug),
    [tasks, activeTaskSlug]
  );
  const activeTaskLaunchState = activeLaunchState?.taskSlug === activeTask?.taskSlug
    ? activeLaunchState
    : null;
  const currentHarnessStatus = harnessStatusTaskSlug === activeTask?.taskSlug ? harnessStatus : null;
  const currentHarnessBootstrapStatus = harnessBootstrapStatusTaskSlug === activeTask?.taskSlug ? harnessBootstrapStatus : null;
  const translationBaseReady = Boolean(project && activeTask && isTranslationHarnessReady(currentHarnessStatus));
  const translatorSessionRunning = translatorSession?.status === "running";
  const effectiveTranslationEnabled = Boolean(translationEnabled && translationBaseReady && translatorSessionRunning);
  const canSaveLaunchTemplate = Boolean(activeTaskLaunchState?.statusLoaded && activeTaskLaunchState.allRolesHaveSession);
  const canOneClickStart = Boolean(activeTask && activeTaskLaunchState?.statusLoaded && !activeTaskLaunchState.hasAnySession);

  const applyPreferences = useCallback((preferences: AppPreferences) => {
    setThemeMode(preferences.themeMode);
    setFlowPauseAlerts(preferences.flowPauseAlerts);
    setPermissionRequestMode(preferences.permissionRequestMode);
    setTranslationEnabled(preferences.translationEnabled);
    setTranslationAutoSendEnabled(preferences.translationAutoSendEnabled);
    setTranslationTargetLanguage(preferences.translationTargetLanguage);
    setTranslationOutputMode(preferences.translationOutputMode);
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
    notifiedFlowPauseKeyRef.current[roundState.taskSlug] = pauseKey;

    if (!flowPauseAlerts) {
      return;
    }

    const roleLabel = roundState.activeRole ?? "role";
    if (getFlowPauseDurationMs(roundState) >= FLOW_PAUSE_STRONG_ALERT_THRESHOLD_MS) {
      showStrongFlowPauseNotice(`No new turn started after ${roleLabel} stopped.`, pauseKey);
    } else {
      playWeakFlowPauseAlert();
    }
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

  async function loadHarnessStatus(taskSlug = activeTask?.taskSlug) {
    if (!taskSlug) {
      setHarnessStatus(null);
      setHarnessStatusTaskSlug(null);
      return null;
    }
    const nextStatus = await apiClient.getHarnessStatus(taskSlug);
    setHarnessStatus(nextStatus);
    setHarnessStatusTaskSlug(taskSlug);
    return nextStatus;
  }

  async function loadHarnessBootstrapStatus(taskSlug = activeTask?.taskSlug) {
    if (!taskSlug) {
      setHarnessBootstrapStatus(null);
      setHarnessBootstrapStatusTaskSlug(null);
      return null;
    }
    const nextStatus = await apiClient.getHarnessBootstrapStatus(taskSlug);
    setHarnessBootstrapStatus(nextStatus);
    setHarnessBootstrapStatusTaskSlug(taskSlug);
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

  async function refreshGateReviewState(taskSlug: string) {
    const state = await apiClient.getGateReviewState(taskSlug);
    setActiveGateReview({ taskSlug, state });
    return state;
  }

  function syncTranslatorLaunchOptions(session: RoleSessionRecord | null) {
    if (!session) {
      return;
    }
    setTranslatorPermissionMode(session.permissionMode);
    if (session.model) {
      setTranslatorModel(session.model);
    }
    if (session.effort) {
      setTranslatorEffort(session.effort);
    }
  }

  async function refreshTranslatorSession(options: { syncLaunchOptions?: boolean } = {}) {
    const session = await apiClient.getTranslatorSession();
    setTranslatorSession(session);
    if (options.syncLaunchOptions) {
      syncTranslatorLaunchOptions(session);
    }
    return session;
  }

  function syncHarnessEngineerLaunchOptions(session: RoleSessionRecord | null) {
    if (!session) {
      return;
    }
    setHarnessEngineerPermissionMode(session.permissionMode);
    if (session.model) {
      setHarnessEngineerModel(session.model);
    }
    if (session.effort) {
      setHarnessEngineerEffort(session.effort);
    }
  }

  async function refreshHarnessEngineerSession(options: { syncLaunchOptions?: boolean } = {}) {
    const session = await apiClient.getHarnessEngineerSession();
    setHarnessEngineerSession(session);
    if (options.syncLaunchOptions) {
      syncHarnessEngineerLaunchOptions(session);
    }
    return session;
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
          await loadTasks();
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

  useEffect(() => {
    if (!activeTask?.taskSlug) {
      setActiveGateReview(null);
      return;
    }

    void refreshGateReviewState(activeTask.taskSlug).catch((caught: Error) => setError(caught.message));
  }, [activeTask?.taskSlug]);

  useEffect(() => {
    translatorEnsureKeyRef.current = "";
    harnessEngineerAutoResumeKeyRef.current = "";
    setTranslatorSession(null);
    setTranslatorPermissionMode("default");
    setTranslatorModel("default");
    setTranslatorEffort("medium");
    setHarnessEngineerSession(null);
    setHarnessEngineerPermissionMode("default");
    setHarnessEngineerModel("default");
    setHarnessEngineerEffort("medium");
    setHarnessStatus(null);
    setHarnessBootstrapStatus(null);
    setHarnessStatusTaskSlug(null);
    setHarnessBootstrapStatusTaskSlug(null);
  }, [project?.repoRoot]);

  useEffect(() => {
    if (!project) {
      return;
    }

    void refreshTranslatorSession({ syncLaunchOptions: true }).catch((caught: Error) => setError(caught.message));
    const interval = window.setInterval(() => {
      void refreshTranslatorSession().catch((caught: Error) => setError(caught.message));
    }, 3000);
    return () => window.clearInterval(interval);
  }, [project?.repoRoot]);

  useEffect(() => {
    if (!project) {
      return;
    }

    void refreshHarnessEngineerSession({ syncLaunchOptions: true }).catch((caught: Error) => setError(caught.message));
    const interval = window.setInterval(() => {
      void refreshHarnessEngineerSession().catch((caught: Error) => setError(caught.message));
    }, 3000);
    return () => window.clearInterval(interval);
  }, [project?.repoRoot]);

  useEffect(() => {
    if (!project || !activeTask?.taskSlug || !harnessEngineerSession?.claudeSessionId) {
      return;
    }
    if (harnessEngineerSession.status === "running" || harnessEngineerSession.status === "done") {
      return;
    }

    const resumeKey = `${project.repoRoot}:${activeTask.taskSlug}:${harnessEngineerSession.claudeSessionId}`;
    if (harnessEngineerAutoResumeKeyRef.current === resumeKey) {
      return;
    }
    harnessEngineerAutoResumeKeyRef.current = resumeKey;

    void apiClient.resumeHarnessEngineerSession({
      taskSlug: activeTask.taskSlug,
      permissionMode: harnessEngineerSession.permissionMode,
      model: harnessEngineerSession.model,
      effort: harnessEngineerSession.effort
    })
      .then((session) => {
        setHarnessEngineerSession(session);
        syncHarnessEngineerLaunchOptions(session);
      })
      .catch((caught: Error) => setError(caught.message));
  }, [
    activeTask?.taskSlug,
    harnessEngineerSession?.claudeSessionId,
    harnessEngineerSession?.effort,
    harnessEngineerSession?.model,
    harnessEngineerSession?.permissionMode,
    harnessEngineerSession?.status,
    project?.repoRoot
  ]);

  useEffect(() => {
    if (!project || !activeTask?.taskSlug) {
      setHarnessStatus(null);
      setHarnessBootstrapStatus(null);
      setHarnessStatusTaskSlug(null);
      setHarnessBootstrapStatusTaskSlug(null);
      return;
    }

    const taskSlug = activeTask.taskSlug;
    void Promise.all([
      loadHarnessStatus(taskSlug),
      loadHarnessBootstrapStatus(taskSlug)
    ]).catch((caught: Error) => setError(caught.message));
    const interval = window.setInterval(() => {
      void Promise.all([
        loadHarnessStatus(taskSlug),
        loadHarnessBootstrapStatus(taskSlug)
      ]).catch((caught: Error) => setError(caught.message));
    }, 3000);
    return () => window.clearInterval(interval);
  }, [project?.repoRoot, activeTask?.taskSlug]);

  useEffect(() => {
    if (!project || !translationEnabled || !activeTask?.taskSlug || !translationBaseReady || !translatorSessionRunning) {
      translatorEnsureKeyRef.current = "";
      return;
    }

    const ensureKey = `${project.repoRoot}:${activeTask.taskSlug}`;
    if (translatorEnsureKeyRef.current === ensureKey && translatorSession?.status === "running") {
      return;
    }
    translatorEnsureKeyRef.current = ensureKey;
    void apiClient.ensureTranslatorSession({ taskSlug: activeTask.taskSlug })
      .then((session) => {
        setTranslatorSession(session);
        syncTranslatorLaunchOptions(session);
      })
      .catch((caught: Error) => {
        translatorEnsureKeyRef.current = "";
        setError(caught.message);
      });
  }, [project?.repoRoot, activeTask?.taskSlug, translationEnabled, translationBaseReady, translatorSessionRunning]);

  useEffect(() => {
    if (!activeTask?.taskSlug) {
      return;
    }

    const taskSlug = activeTask.taskSlug;
    const interval = window.setInterval(() => {
      void refreshGateReviewState(taskSlug).catch((caught: Error) => setError(caught.message));
    }, 3000);

    return () => window.clearInterval(interval);
  }, [activeTask?.taskSlug]);

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
  const sidebarGateReview =
    activeGateReview && activeGateReview.taskSlug === activeTask?.taskSlug
      ? activeGateReview.state
      : null;
  const gateReviewerEnabled = Boolean(
    sidebarGateReview && Object.values(sidebarGateReview.gates).some((gate) => gate.required)
  );
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
          gateReview={sidebarGateReview}
          translationEnabled={effectiveTranslationEnabled}
          translationAutoSendEnabled={translationAutoSendEnabled}
          translationTargetLanguage={translationTargetLanguage}
          translationOutputMode={translationOutputMode}
          translatorSession={translatorSession}
          harnessStatus={currentHarnessStatus}
          harnessBootstrapStatus={currentHarnessBootstrapStatus}
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
            if (!activeTask) {
              throw new Error("Create or select a task before refreshing VCM Harness.");
            }
            setHarnessApplyResult(null);
            await Promise.all([
              loadHarnessStatus(activeTask.taskSlug),
              loadHarnessBootstrapStatus(activeTask.taskSlug)
            ]);
          })}
          onApplyHarness={() => withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before applying VCM Harness.");
            }
            const result = await apiClient.applyHarness({ taskSlug: activeTask.taskSlug });
            setHarnessApplyResult(result);
            await Promise.all([
              loadHarnessStatus(activeTask.taskSlug),
              loadHarnessBootstrapStatus(activeTask.taskSlug)
            ]);
          })}
          onStartHarnessBootstrap={(input) => withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before starting Harness Bootstrap.");
            }
            const result = await apiClient.startHarnessBootstrap({
              taskSlug: activeTask.taskSlug,
              cols: 120,
              rows: 32,
              ...input
            });
            setHarnessBootstrapStatus(result.status);
            setHarnessBootstrapStatusTaskSlug(activeTask.taskSlug);
            await refreshHarnessEngineerSession({ syncLaunchOptions: true });
          })}
          onRestartHarnessBootstrap={(input) => withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before restarting Harness Bootstrap.");
            }
            const result = await apiClient.restartHarnessBootstrap({
              taskSlug: activeTask.taskSlug,
              cols: 120,
              rows: 32,
              ...input
            });
            setHarnessBootstrapStatus(result.status);
            setHarnessBootstrapStatusTaskSlug(activeTask.taskSlug);
            await refreshHarnessEngineerSession({ syncLaunchOptions: true });
          })}
          onStopHarnessBootstrap={() => withBusy(async () => {
            const status = await apiClient.stopHarnessBootstrap();
            setHarnessBootstrapStatus(status);
            setHarnessBootstrapStatusTaskSlug(activeTask?.taskSlug ?? null);
            await refreshHarnessEngineerSession();
          })}
          onRunHarnessBootstrap={() => withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before running Harness Bootstrap.");
            }
            const result = await apiClient.runHarnessBootstrap({ taskSlug: activeTask.taskSlug });
            setHarnessBootstrapStatus(result.status);
            setHarnessBootstrapStatusTaskSlug(activeTask.taskSlug);
            await refreshHarnessEngineerSession();
          })}
          onOpenHarnessStudio={() => setHarnessStudioOpen(true)}
          onOpenRepositoryDiff={() => setRepositoryDiffOpen(true)}
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
          onGateReviewGateEnabledChange={(gate: GateReviewGate, enabled) => {
            void withBusy(async () => {
              if (!activeTask) {
                throw new Error("Create or select a task before changing Gate Review Gates.");
              }
              const state = await apiClient.updateGateReviewSettings(activeTask.taskSlug, {
                gates: { [gate]: enabled }
              });
              setActiveGateReview({ taskSlug: activeTask.taskSlug, state });
            });
          }}
          onTranslationEnabledChange={(enabled) => {
            setTranslationEnabled(enabled);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ translationEnabled: enabled });
              applyPreferences(preferences);
            });
          }}
          onTranslationAutoSendChange={(enabled) => {
            setTranslationAutoSendEnabled(enabled);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ translationAutoSendEnabled: enabled });
              applyPreferences(preferences);
            });
          }}
          onTranslationTargetLanguageChange={(targetLanguage) => {
            setTranslationTargetLanguage(targetLanguage);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ translationTargetLanguage: targetLanguage });
              applyPreferences(preferences);
            });
          }}
          onTranslationOutputModeChange={(outputMode) => {
            setTranslationOutputMode(outputMode);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ translationOutputMode: outputMode });
              applyPreferences(preferences);
            });
          }}
          onOpenFileTranslation={() => setFileTranslationOpen(true)}
          onOpenTranslatorSession={() => setTranslatorSessionOpen(true)}
          onCreateTranslationBootstrap={() => {
            void withBusy(async () => {
              if (!activeTask) {
                throw new Error("Create or select a task before running Translation Bootstrap.");
              }
              await apiClient.createTranslationBootstrap({
                taskSlug: activeTask.taskSlug,
                targetLanguage: translationTargetLanguage
              });
              await refreshTranslatorSession();
            });
          }}
          onUpdateTranslationMemory={() => {
            void withBusy(async () => {
              if (!activeTask) {
                throw new Error("Create or select a task before updating translation memory.");
              }
              await apiClient.createTranslationMemoryUpdate({
                taskSlug: activeTask.taskSlug,
                targetLanguage: translationTargetLanguage
              });
              await refreshTranslatorSession();
            });
          }}
          onCreateTask={(input) => withBusy(async () => {
            const task = await apiClient.createTask(input);
            await loadTasks();
            setActiveTaskSlug(task.taskSlug);
            await refreshGateReviewState(task.taskSlug);
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
                throw new Error("Start all core role sessions before saving a launch template.");
              }

              const preferences = await apiClient.updateAppPreferences({
                launchTemplate: {
                  version: 1,
                  roles: activeTaskLaunchState.roles,
                  autoOrchestration: activeTaskLaunchState.autoOrchestration
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
              if (status.sessions.some((session) => CORE_VCM_ROLE_NAMES.some((role) => role === session.role))) {
                throw new Error("One-click start is only available before any role session has started.");
              }

              const nextOrchestration = await apiClient.updateOrchestrationState(activeTask.taskSlug, {
                mode: launchTemplate.autoOrchestration ? "auto" : "manual"
              });
              setActiveOrchestration({
                taskSlug: activeTask.taskSlug,
                orchestration: nextOrchestration
              });

              const roleLaunches = buildOneClickRoleLaunches(launchTemplate, { gateReviewerEnabled });
              for (const roleLaunch of roleLaunches) {
                const sessionInput = {
                  cols: 100,
                  rows: 28,
                  permissionMode: roleLaunch.permissionMode,
                  model: roleLaunch.model,
                  effort: roleLaunch.effort
                };
                const existingSession = status.sessions.find((session) => session.role === roleLaunch.role);
                if (existingSession?.status === "running") {
                  if (roleLaunch.role === "gate-reviewer") {
                    await apiClient.resumeRoleSession(activeTask.taskSlug, roleLaunch.role, sessionInput);
                  }
                  continue;
                }
                if (existingSession?.claudeSessionId) {
                  await apiClient.resumeRoleSession(activeTask.taskSlug, roleLaunch.role, sessionInput);
                } else {
                  await apiClient.startRoleSession(activeTask.taskSlug, roleLaunch.role, sessionInput);
                }
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
          gateReviewerEnabled={gateReviewerEnabled}
          translationEnabled={effectiveTranslationEnabled}
          translationAutoSendEnabled={translationAutoSendEnabled}
          translationTargetLanguage={translationTargetLanguage}
          refreshNonce={workspaceRefreshNonce}
          onTaskChanged={async () => {
            await loadTasks();
          }}
          onActiveRoleChange={setActiveRole}
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
              ? "Tasks create local role commands and handoff artifacts for the selected repository."
              : "VibeCodingMaster will create a local task workspace, role sessions, and handoff artifacts."}
          </p>
        </section>
      )}
      <FileTranslationModalHost
        open={fileTranslationOpen}
        taskSlug={activeTask?.taskSlug ?? null}
        targetLanguage={translationTargetLanguage}
        onClose={() => setFileTranslationOpen(false)}
      />
      <HarnessStudioModal
        open={harnessStudioOpen}
        busy={busy}
        status={currentHarnessStatus}
        bootstrapStatus={currentHarnessBootstrapStatus}
        engineerSession={harnessEngineerSession}
        permissionMode={harnessEngineerPermissionMode}
        model={harnessEngineerModel}
        effort={harnessEngineerEffort}
        taskSlug={activeTask?.taskSlug ?? null}
        onClose={() => setHarnessStudioOpen(false)}
        onRefresh={() => {
          void withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before refreshing Harness Studio.");
            }
            await Promise.all([
              loadHarnessStatus(activeTask.taskSlug),
              loadHarnessBootstrapStatus(activeTask.taskSlug),
              refreshHarnessEngineerSession()
            ]);
          });
        }}
        onPermissionModeChange={setHarnessEngineerPermissionMode}
        onModelChange={setHarnessEngineerModel}
        onEffortChange={setHarnessEngineerEffort}
        onEngineerStart={() => {
          void withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before starting Harness Engineer.");
            }
            const session = await apiClient.startHarnessEngineerSession({
              taskSlug: activeTask.taskSlug,
              cols: 120,
              rows: 32,
              permissionMode: harnessEngineerPermissionMode,
              model: harnessEngineerModel,
              effort: harnessEngineerEffort
            });
            setHarnessEngineerSession(session);
            syncHarnessEngineerLaunchOptions(session);
          });
        }}
        onEngineerResume={() => {
          void withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before resuming Harness Engineer.");
            }
            const session = await apiClient.resumeHarnessEngineerSession({
              taskSlug: activeTask.taskSlug,
              cols: 120,
              rows: 32,
              permissionMode: harnessEngineerPermissionMode,
              model: harnessEngineerModel,
              effort: harnessEngineerEffort
            });
            setHarnessEngineerSession(session);
            syncHarnessEngineerLaunchOptions(session);
          });
        }}
        onEngineerRestart={() => {
          void withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before restarting Harness Engineer.");
            }
            const session = await apiClient.restartHarnessEngineerSession({
              taskSlug: activeTask.taskSlug,
              cols: 120,
              rows: 32,
              permissionMode: harnessEngineerPermissionMode,
              model: harnessEngineerModel,
              effort: harnessEngineerEffort
            });
            setHarnessEngineerSession(session);
            syncHarnessEngineerLaunchOptions(session);
          });
        }}
        onEngineerStop={() => {
          void withBusy(async () => {
            const session = await apiClient.stopHarnessEngineerSession();
            setHarnessEngineerSession(session);
          });
        }}
        onEngineerNotifyHarnessUpdated={() => {
          void withBusy(async () => {
            const session = await apiClient.notifyHarnessEngineerHarnessUpdated();
            setHarnessEngineerSession(session);
            syncHarnessEngineerLaunchOptions(session);
          });
        }}
        onOpenRepositoryDiff={() => setRepositoryDiffOpen(true)}
      />
      <RepositoryDiffModal
        open={repositoryDiffOpen}
        taskSlug={activeTask?.taskSlug ?? null}
        onClose={() => setRepositoryDiffOpen(false)}
      />
      <TranslatorSessionModal
        open={translatorSessionOpen}
        busy={busy}
        session={translatorSession}
        permissionMode={translatorPermissionMode}
        model={translatorModel}
        effort={translatorEffort}
        onClose={() => setTranslatorSessionOpen(false)}
        onPermissionModeChange={setTranslatorPermissionMode}
        onModelChange={setTranslatorModel}
        onEffortChange={setTranslatorEffort}
        onStart={() => {
          void withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before starting Translator.");
            }
            const session = await apiClient.startTranslatorSession({
              taskSlug: activeTask.taskSlug,
              cols: 100,
              rows: 28,
              permissionMode: translatorPermissionMode,
              model: translatorModel,
              effort: translatorEffort
            });
            setTranslatorSession(session);
            syncTranslatorLaunchOptions(session);
          });
        }}
        onResume={() => {
          void withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before resuming Translator.");
            }
            const session = await apiClient.resumeTranslatorSession({
              taskSlug: activeTask.taskSlug,
              cols: 100,
              rows: 28,
              permissionMode: translatorPermissionMode,
              model: translatorModel,
              effort: translatorEffort
            });
            setTranslatorSession(session);
            syncTranslatorLaunchOptions(session);
          });
        }}
        onRestart={() => {
          void withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before restarting Translator.");
            }
            const session = await apiClient.restartTranslatorSession({
              taskSlug: activeTask.taskSlug,
              cols: 100,
              rows: 28,
              permissionMode: translatorPermissionMode,
              model: translatorModel,
              effort: translatorEffort
            });
            setTranslatorSession(session);
            syncTranslatorLaunchOptions(session);
          });
        }}
        onStop={() => {
          void withBusy(async () => {
            const session = await apiClient.stopTranslatorSession();
            setTranslatorSession(session);
          });
        }}
        onNotifyHarnessUpdated={() => {
          void withBusy(async () => {
            const session = await apiClient.notifyTranslatorHarnessUpdated();
            setTranslatorSession(session);
            syncTranslatorLaunchOptions(session);
          });
        }}
      />
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
