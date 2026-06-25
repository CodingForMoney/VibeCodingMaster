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
  HarnessFeedbackStateReport,
  HarnessStatusReport
} from "../shared/types/harness.js";
import type {
  CheckGatewayQrLoginResult,
  CheckGatewayLarkRegistrationResult,
  GatewayStatus,
  StartGatewayLarkRegistrationResult,
  StartGatewayQrLoginResult
} from "../shared/types/gateway.js";
import type { GateReviewGate, GateReviewIndex } from "../shared/types/gate-review.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../shared/types/message.js";
import type { ProjectSummary } from "../shared/types/project.js";
import type { ProjectRuntimeState } from "../shared/types/api.js";
import type { RoleName } from "../shared/types/role.js";
import type { VcmRoleRecoveryState, VcmRoundStatus, VcmSessionRoundState } from "../shared/types/round.js";
import type { ClaudePermissionMode, RoleSessionRecord, SessionEffort, SessionModel } from "../shared/types/session.js";
import type { TaskRecord } from "../shared/types/task.js";
import { AppShell } from "./components/app-shell.js";
import { HarnessFeedbackReview } from "./components/harness-feedback-review.js";
import { HarnessStudioModal } from "./components/harness-studio-modal.js";
import { RepositoryDiffModal } from "./components/repository-diff-modal.js";
import { TranslatorSessionModal } from "./components/translator-session-modal.js";
import { FileTranslationModalHost } from "./components/translation-panel.js";
import { UiErrorCenter } from "./components/ui-error-center.js";
import { selectActiveTask } from "./state/app-store.js";
import { selectAutoFollowRole } from "./state/active-role-follow.js";
import { getFlowPauseNotificationKey, selectFlowPauseAlertMessage } from "./state/flow-pause-alert.js";
import { apiClient } from "./state/api-client.js";
import { clearUiErrorForActions, formatUiError } from "./state/error-format.js";
import { clearPollError, recordPollError } from "./state/poll-error-gate.js";
import { useUiErrorState } from "./state/ui-error-state.js";
import { useScheduledPoll } from "./state/use-scheduled-poll.js";
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
  const [harnessFeedbackState, setHarnessFeedbackState] = useState<HarnessFeedbackStateReport | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [gatewayQrLogin, setGatewayQrLogin] = useState<StartGatewayQrLoginResult | null>(null);
  const [gatewayQrCheck, setGatewayQrCheck] = useState<CheckGatewayQrLoginResult | null>(null);
  const [gatewayQrModalOpen, setGatewayQrModalOpen] = useState(false);
  const [gatewayLarkRegistration, setGatewayLarkRegistration] = useState<StartGatewayLarkRegistrationResult | null>(null);
  const [gatewayLarkRegistrationCheck, setGatewayLarkRegistrationCheck] = useState<CheckGatewayLarkRegistrationResult | null>(null);
  const [gatewayLarkRegistrationModalOpen, setGatewayLarkRegistrationModalOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [activeTaskSlug, setActiveTaskSlug] = useState<string | null>(null);
  const [activeMessages, setActiveMessages] = useState<{ taskSlug: string; messages: VcmRoleMessage[] } | null>(null);
  const [activeOrchestration, setActiveOrchestration] = useState<{ taskSlug: string; orchestration: VcmOrchestrationState } | null>(null);
  const [activeEvents, setActiveEvents] = useState<{ taskSlug: string; events: string[] } | null>(null);
  const [activeSessionRoundState, setActiveSessionRoundState] = useState<{ taskSlug: string; roundState: VcmSessionRoundState } | null>(null);
  const [activeGateReview, setActiveGateReview] = useState<{ taskSlug: string; state: GateReviewIndex } | null>(null);
  const [activeRole, setActiveRole] = useState<RoleName>("project-manager");
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [pauseAlertSound, setPauseAlertSound] = useState(true);
  const [roleRetryEnabled, setRoleRetryEnabled] = useState(true);
  const [permissionRequestMode, setPermissionRequestMode] = useState<PermissionRequestMode>("off");
  const [autoTaskHarnessReviewEnabled, setAutoTaskHarnessReviewEnabled] = useState(false);
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationAutoSendEnabled, setTranslationAutoSendEnabled] = useState(false);
  const [translationTargetLanguage, setTranslationTargetLanguage] = useState<TranslationTargetLanguage>(DEFAULT_TRANSLATION_TARGET_LANGUAGE);
  const [translationOutputMode, setTranslationOutputMode] = useState<TranslationOutputMode>(DEFAULT_TRANSLATION_OUTPUT_MODE);
  const [translationMemoryInitialized, setTranslationMemoryInitialized] = useState(false);
  const [fileTranslationOpen, setFileTranslationOpen] = useState(false);
  const [translatorSessionOpen, setTranslatorSessionOpen] = useState(false);
  const [harnessStudioOpen, setHarnessStudioOpen] = useState(false);
  const [repositoryDiffOpen, setRepositoryDiffOpen] = useState(false);
  const [translatorSession, setTranslatorSession] = useState<RoleSessionRecord | null>(null);
  const [translatorPermissionMode, setTranslatorPermissionMode] = useState<ClaudePermissionMode>("bypassPermissions");
  const [translatorModel, setTranslatorModel] = useState<SessionModel>("default");
  const [translatorEffort, setTranslatorEffort] = useState<SessionEffort>("medium");
  const [harnessEngineerSession, setHarnessEngineerSession] = useState<RoleSessionRecord | null>(null);
  const [harnessEngineerPermissionMode, setHarnessEngineerPermissionMode] = useState<ClaudePermissionMode>("bypassPermissions");
  const [harnessEngineerModel, setHarnessEngineerModel] = useState<SessionModel>("default");
  const [harnessEngineerEffort, setHarnessEngineerEffort] = useState<SessionEffort>("medium");
  const [launchTemplate, setLaunchTemplate] = useState<LaunchTemplate>(() => createDefaultLaunchTemplate());
  const [activeLaunchState, setActiveLaunchState] = useState<TaskWorkspaceLaunchState | null>(null);
  const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0);
  const [flowPauseNotice, setFlowPauseNotice] = useState<{ id: string; text: string } | null>(null);
  const [dismissedRoleRecoveryKey, setDismissedRoleRecoveryKey] = useState<string | null>(null);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setError] = useUiErrorState("");
  const notifiedFlowPauseKeyRef = useRef<Record<string, string>>({});
  const observedFlowPauseStateRef = useRef<Record<string, { status: VcmRoundStatus }>>({});
  // Per-task mirror of the orchestration mode and the last role we auto-followed,
  // read inside handleRoundStateChanged without widening its dependency array.
  const orchestrationModeRef = useRef<Record<string, VcmOrchestrationState["mode"]>>({});
  const autoFollowedRoleRef = useRef<Record<string, RoleName>>({});
  const activeTaskViewStartedAtRef = useRef<Record<string, number>>({});
  const flowPauseAlarmRef = useRef<number | null>(null);
  const projectRuntimeLaunchSyncKeyRef = useRef("");
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
  const gatewayRunning = Boolean(gatewayStatus?.running);
  const effectiveTranslationEnabled = Boolean(translationEnabled && translationBaseReady && translatorSessionRunning);
  const canSaveLaunchTemplate = Boolean(activeTaskLaunchState?.statusLoaded);
  const canOneClickStart = Boolean(activeTask && activeTaskLaunchState?.statusLoaded && !activeTaskLaunchState.hasAnySession);

  const applyPreferences = useCallback((preferences: AppPreferences) => {
    setThemeMode(preferences.themeMode);
    setPauseAlertSound(preferences.flowPauseAlerts);
    setRoleRetryEnabled(preferences.roleRetryEnabled);
    setPermissionRequestMode(preferences.permissionRequestMode);
    setAutoTaskHarnessReviewEnabled(preferences.autoTaskHarnessReviewEnabled);
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

  const startStrongFlowPauseAlarm = useCallback(() => {
    stopFlowPauseAlarm();
    void playFlowPauseSound();
    flowPauseAlarmRef.current = window.setInterval(() => {
      void playFlowPauseSound();
    }, FLOW_PAUSE_CHIME_INTERVAL_MS);
  }, [stopFlowPauseAlarm]);

  const playWeakFlowPauseAlert = useCallback(() => {
    stopFlowPauseAlarm();
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

  const showFlowPauseNotice = useCallback((
    text: string,
    id = `manual-${Date.now()}`,
    options: { sound?: "none" | "weak" | "strong" } = {}
  ) => {
    setFlowPauseNotice({ id, text });
    if (options.sound === "strong") {
      startStrongFlowPauseAlarm();
    } else if (options.sound === "weak") {
      playWeakFlowPauseAlert();
    } else {
      stopFlowPauseAlarm();
    }
  }, [playWeakFlowPauseAlert, startStrongFlowPauseAlarm, stopFlowPauseAlarm]);

  const confirmFlowPauseNotice = useCallback(() => {
    stopFlowPauseAlarm();
    setFlowPauseNotice(null);
  }, [stopFlowPauseAlarm]);

  useEffect(() => {
    if (activeTask?.taskSlug) {
      activeTaskViewStartedAtRef.current[activeTask.taskSlug] = Date.now();
    }
  }, [activeTask?.taskSlug]);

  const handleMessagesChanged = useCallback((messages: VcmRoleMessage[]) => {
    if (activeTask?.taskSlug) {
      setActiveMessages({ taskSlug: activeTask.taskSlug, messages });
    }
  }, [activeTask?.taskSlug]);

  const handleOrchestrationChanged = useCallback((orchestration: VcmOrchestrationState) => {
    orchestrationModeRef.current[orchestration.taskSlug] = orchestration.mode;
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
    // Follow the authoritative active role (set by the round at turn start) in auto
    // orchestration mode, deduped so a steady role does not re-switch every poll and
    // a user's manual tab focus is not stolen. Replaces the former client-side
    // message-diff role derivation and the gate-reviewer-only tab special case.
    const followRole = selectAutoFollowRole({
      mode: orchestrationModeRef.current[roundState.taskSlug],
      status: roundState.status,
      activeRole: roundState.activeRole,
      lastFollowedRole: autoFollowedRoleRef.current[roundState.taskSlug]
    });
    if (followRole) {
      autoFollowedRoleRef.current[roundState.taskSlug] = followRole;
      setActiveRole(followRole);
    }
    // Consume the authoritative flow-pause decision + message from the backend
    // (round-service) instead of re-deriving "is it paused / why" here. Everything
    // below is purely the client-side alert mechanics (dedupe, viewing gate, sound,
    // gateway suppression), which are unchanged.
    const flowPauseMessage = selectFlowPauseAlertMessage(roundState, formatRoleRecoveryFailureMessage);
    if (flowPauseMessage === null) {
      observedFlowPauseStateRef.current[roundState.taskSlug] = { status: roundState.status };
      return;
    }

    const pauseKey = getFlowPauseNotificationKey(roundState);
    const previousPauseKey = notifiedFlowPauseKeyRef.current[roundState.taskSlug];
    const previousObservation = observedFlowPauseStateRef.current[roundState.taskSlug];
    observedFlowPauseStateRef.current[roundState.taskSlug] = { status: roundState.status };
    if (previousPauseKey === pauseKey) {
      return;
    }
    notifiedFlowPauseKeyRef.current[roundState.taskSlug] = pauseKey;
    if (!shouldShowFlowPauseNotice(roundState, previousObservation, activeTaskViewStartedAtRef.current[roundState.taskSlug])) {
      return;
    }
    if (gatewayRunning) {
      stopFlowPauseAlarm();
      setFlowPauseNotice(null);
      return;
    }

    const sound = !pauseAlertSound
      ? "none"
      : getFlowPauseDurationMs(roundState) >= FLOW_PAUSE_STRONG_ALERT_THRESHOLD_MS
        ? "strong"
        : "weak";
    showFlowPauseNotice(flowPauseMessage, pauseKey, { sound });
  }, [activeTask?.taskSlug, gatewayRunning, pauseAlertSound, showFlowPauseNotice, stopFlowPauseAlarm]);

  const handleLaunchStateChanged = useCallback((launchState: TaskWorkspaceLaunchState) => {
    setActiveLaunchState((current) => {
      if (
        current?.taskSlug === launchState.taskSlug &&
        current.statusLoaded === launchState.statusLoaded &&
        current.sessionCount === launchState.sessionCount &&
        current.hasAnySession === launchState.hasAnySession &&
        current.hasGateReviewerSession === launchState.hasGateReviewerSession &&
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

  async function refreshTranslationMemoryInitialized() {
    if (!project) {
      setTranslationMemoryInitialized(false);
      return false;
    }
    const state = await apiClient.getTranslationState();
    setTranslationMemoryInitialized(state.memoryInitialized);
    return state.memoryInitialized;
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
    clearPollError("Poll Gate Review state");
    setError((current) => clearUiErrorForActions(current, ["Refresh Gate Review state", "Poll Gate Review state"]));
    return state;
  }

  function reportPollError(action: string, caught: Error) {
    const message = recordPollError(action, caught);
    if (message) {
      setError(message);
    }
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

  async function refreshHarnessFeedbackState(taskSlug = activeTask?.taskSlug) {
    if (!project) {
      setHarnessFeedbackState(null);
      return null;
    }
    const state = await apiClient.getHarnessFeedbackState(taskSlug);
    setHarnessFeedbackState(state);
    return state;
  }

  function applyProjectRuntimeState(
    state: ProjectRuntimeState,
    taskSlug: string | null,
    options: { syncLaunchOptions?: boolean } = {}
  ) {
    setTranslatorSession(state.translatorSession);
    setTranslationMemoryInitialized(Boolean(state.translationState?.memoryInitialized));
    setHarnessEngineerSession(state.harnessEngineerSession);
    setHarnessFeedbackState(state.harnessFeedbackState);
    setGatewayStatus(state.gatewayStatus);

    if (taskSlug && state.harnessStatus) {
      setHarnessStatus(state.harnessStatus);
      setHarnessStatusTaskSlug(taskSlug);
    } else {
      setHarnessStatus(null);
      setHarnessStatusTaskSlug(null);
    }

    if (taskSlug && state.harnessBootstrapStatus) {
      setHarnessBootstrapStatus(state.harnessBootstrapStatus);
      setHarnessBootstrapStatusTaskSlug(taskSlug);
    } else {
      setHarnessBootstrapStatus(null);
      setHarnessBootstrapStatusTaskSlug(null);
    }

    if (options.syncLaunchOptions) {
      syncTranslatorLaunchOptions(state.translatorSession);
      syncHarnessEngineerLaunchOptions(state.harnessEngineerSession);
    }
  }

  async function refreshProjectRuntimeState(options: { syncLaunchOptions?: boolean } = {}) {
    if (!project) {
      setTranslatorSession(null);
      setTranslationMemoryInitialized(false);
      setHarnessEngineerSession(null);
      setHarnessStatus(null);
      setHarnessBootstrapStatus(null);
      setHarnessStatusTaskSlug(null);
      setHarnessBootstrapStatusTaskSlug(null);
      setHarnessFeedbackState(null);
      return null;
    }

    const taskSlug = activeTask?.taskSlug ?? null;
    const state = await apiClient.getProjectRuntimeState(taskSlug);
    applyProjectRuntimeState(state, taskSlug, options);
    return state;
  }

  function clearProjectRuntimePollErrors() {
    const actions = [
      "Poll project runtime state",
      "Load project runtime state",
      "Refresh Harness feedback state",
      "Poll Harness feedback state",
      "Load Translator session",
      "Poll Translator session",
      "Poll translation memory status",
      "Load Harness Engineer session",
      "Poll Harness Engineer session",
      "Load VCM Harness status",
      "Poll VCM Harness status"
    ];
    for (const action of actions) {
      clearPollError(action);
    }
    setError((current) => clearUiErrorForActions(current, actions));
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
      .catch((caught: Error) => setError(formatUiError("Load initial app data", caught)));
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
    if (!gatewayRunning) {
      return;
    }
    stopFlowPauseAlarm();
    setFlowPauseNotice(null);
  }, [gatewayRunning, stopFlowPauseAlarm]);

  useEffect(() => {
    const resolvedTheme = themeMode === "system"
      ? systemPrefersDark ? "dark" : "light"
      : themeMode;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = themeMode;
  }, [systemPrefersDark, themeMode]);

  useEffect(() => {
    if (!activeTask?.taskSlug) {
      setActiveGateReview(null);
      return;
    }

    void refreshGateReviewState(activeTask.taskSlug).catch((caught: Error) => setError(formatUiError("Refresh Gate Review state", caught)));
  }, [activeTask?.taskSlug]);

  useEffect(() => {
    projectRuntimeLaunchSyncKeyRef.current = "";
    setTranslatorSession(null);
    setTranslatorPermissionMode("bypassPermissions");
    setTranslatorModel("default");
    setTranslatorEffort("medium");
    setTranslationMemoryInitialized(false);
    setHarnessEngineerSession(null);
    setHarnessEngineerPermissionMode("bypassPermissions");
    setHarnessEngineerModel("default");
    setHarnessEngineerEffort("medium");
    setHarnessStatus(null);
    setHarnessBootstrapStatus(null);
    setHarnessStatusTaskSlug(null);
    setHarnessBootstrapStatusTaskSlug(null);
    setHarnessFeedbackState(null);
  }, [project?.repoRoot]);

  useScheduledPoll(
    project ? `project-runtime:${project.repoRoot}:${activeTask?.taskSlug ?? "no-task"}` : null,
    async () => {
      try {
        const syncKey = project?.repoRoot ?? "";
        const syncLaunchOptions = Boolean(project && projectRuntimeLaunchSyncKeyRef.current !== syncKey);
        await refreshProjectRuntimeState({ syncLaunchOptions });
        if (syncLaunchOptions) {
          projectRuntimeLaunchSyncKeyRef.current = syncKey;
        }
        clearProjectRuntimePollErrors();
      } catch (caught) {
        reportPollError("Poll project runtime state", caught as Error);
      }
    },
    {
      intervalMs: 3000,
      runImmediately: true
    }
  );

  const gateReviewPollTaskSlug = activeTask?.taskSlug ?? null;
  const gateReviewPollState = gateReviewPollTaskSlug && activeGateReview?.taskSlug === gateReviewPollTaskSlug
    ? activeGateReview.state
    : null;
  const gateReviewPollRoundState = gateReviewPollTaskSlug && activeSessionRoundState?.taskSlug === gateReviewPollTaskSlug
    ? activeSessionRoundState.roundState
    : null;
  const gateReviewPollLaunchState = gateReviewPollTaskSlug && activeLaunchState?.taskSlug === gateReviewPollTaskSlug
    ? activeLaunchState
    : null;
  const gateReviewShouldPoll = Boolean(
    gateReviewPollTaskSlug
      && (
        gateReviewPollState?.activeGate
        || gateReviewPollRoundState?.activeRole === "gate-reviewer"
        || gateReviewPollLaunchState?.hasGateReviewerSession
      )
  );

  useScheduledPoll(
    gateReviewShouldPoll && gateReviewPollTaskSlug ? `gate-review:${gateReviewPollTaskSlug}` : null,
    async () => {
      if (!gateReviewPollTaskSlug) {
        return;
      }
      try {
        await refreshGateReviewState(gateReviewPollTaskSlug);
      } catch (caught) {
        reportPollError("Poll Gate Review state", caught as Error);
      }
    },
    {
      intervalMs: 3000,
      runImmediately: false
    }
  );

  async function withBusy(action: () => Promise<void>, actionLabel = "Run UI action") {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(formatUiError(actionLabel, caught));
    } finally {
      setBusy(false);
    }
  }

  async function closeActiveTask() {
    if (!activeTask) {
      throw new Error("Create or select a task before closing it.");
    }
    const closeMessage = [
      `Close task "${activeTask.taskSlug}"?`,
      "",
      "This is destructive:",
      "- stops VCM-managed running role sessions for this task",
      "- moves project-scoped Translator and Harness Engineer sessions to the base repository cwd",
      `- deletes the task worktree: ${activeTask.worktreePath}`,
      `- deletes the Git branch: ${activeTask.branch}`,
      "- deletes VCM task/session/message/orchestration state",
      "",
      "VCM will not check running sessions or uncommitted changes before closing."
    ].join("\n");
    const confirmed = window.confirm(closeMessage);
    if (!confirmed) {
      return;
    }

    await apiClient.cleanupTask(activeTask.taskSlug, {
      force: true,
      forceDeleteBranch: true
    });
    setActiveTaskSlug(null);
    setActiveMessages(null);
    setActiveOrchestration(null);
    setActiveEvents(null);
    setActiveSessionRoundState(null);
    setActiveGateReview(null);
    setWorkspaceRefreshNonce((current) => current + 1);
    await loadTasks();
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
  const roleRecoveryNoticeKey = activeTask?.taskSlug && sidebarRoundState?.roleRecovery
    ? getRoleRecoveryNoticeKey(activeTask.taskSlug, sidebarRoundState.roleRecovery)
    : null;
  const roleRecoveryNoticeText = sidebarRoundState?.roleRecovery &&
    sidebarRoundState.roleRecovery.status !== "failed" &&
    roleRecoveryNoticeKey !== dismissedRoleRecoveryKey
      ? formatRoleRecoveryNotice(sidebarRoundState.roleRecovery)
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
          translationMemoryInitialized={translationMemoryInitialized}
          translatorSession={translatorSession}
          harnessStatus={currentHarnessStatus}
          harnessBootstrapStatus={currentHarnessBootstrapStatus}
          harnessApplyResult={harnessApplyResult}
          autoTaskHarnessReviewEnabled={autoTaskHarnessReviewEnabled}
          gatewayStatus={gatewayStatus}
          gatewayQrLogin={gatewayQrLogin}
          gatewayQrCheck={gatewayQrCheck}
          gatewayLarkRegistration={gatewayLarkRegistration}
          gatewayLarkRegistrationCheck={gatewayLarkRegistrationCheck}
          busy={busy}
          onConnect={(repoPath) => withBusy(async () => {
            const nextProject = await apiClient.connectProject({ repoPath });
            setProject(nextProject);
            setHarnessApplyResult(null);
            await Promise.all([
              loadTasks(),
              loadRecentRepositoryPaths()
            ]);
          }, "Connect repository")}
          onRefreshConnectedRepository={() => withBusy(async () => {
            const nextProject = await apiClient.getCurrentProject();
            setProject(nextProject);
          }, "Refresh connected repository")}
          onPullConnectedRepository={() => withBusy(async () => {
            const nextProject = await apiClient.pullCurrentProject();
            setProject(nextProject);
          }, "Pull connected repository")}
          onRefreshHarness={() => withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before refreshing VCM Harness.");
            }
            setHarnessApplyResult(null);
            await Promise.all([
              loadHarnessStatus(activeTask.taskSlug),
              loadHarnessBootstrapStatus(activeTask.taskSlug)
            ]);
          }, "Refresh VCM Harness")}
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
          }, "Apply VCM Harness")}
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
          }, "Start Harness Bootstrap")}
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
          }, "Restart Harness Bootstrap")}
          onStopHarnessBootstrap={() => withBusy(async () => {
            const status = await apiClient.stopHarnessBootstrap();
            setHarnessBootstrapStatus(status);
            setHarnessBootstrapStatusTaskSlug(activeTask?.taskSlug ?? null);
            await refreshHarnessEngineerSession();
          }, "Stop Harness Bootstrap")}
          onRunHarnessBootstrap={() => withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before running Harness Bootstrap.");
            }
            const result = await apiClient.runHarnessBootstrap({ taskSlug: activeTask.taskSlug });
            setHarnessBootstrapStatus(result.status);
            setHarnessBootstrapStatusTaskSlug(activeTask.taskSlug);
            await refreshHarnessEngineerSession();
          }, "Run Harness Bootstrap")}
          onOpenHarnessStudio={() => setHarnessStudioOpen(true)}
          onOpenRepositoryDiff={() => setRepositoryDiffOpen(true)}
          onAutoTaskHarnessReviewChange={(enabled) => {
            setAutoTaskHarnessReviewEnabled(enabled);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ autoTaskHarnessReviewEnabled: enabled });
              applyPreferences(preferences);
            }, "Update auto task harness review setting");
          }}
          onRefreshGateway={() => withBusy(async () => {
            await loadGatewayStatus();
          }, "Refresh Gateway status")}
          onGatewayEnabledChange={(enabled) => {
            void withBusy(async () => {
              const nextStatus = await apiClient.updateGatewaySettings({
                enabled,
                ...(enabled && project ? {
                  currentProjectId: project.repoRoot,
                  currentTaskSlug: activeTask?.taskSlug ?? null
                } : {})
              });
              setGatewayStatus(nextStatus);
              if (enabled) {
                applyPreferences(await apiClient.getAppPreferences());
              }
            }, "Update Gateway enabled setting");
          }}
          onGatewaySettingsChange={(input) => withBusy(async () => {
            const nextStatus = await apiClient.updateGatewaySettings(input);
            setGatewayStatus(nextStatus);
          }, "Update Gateway settings")}
          onGatewayTranslationChange={(enabled) => {
            void withBusy(async () => {
              const nextStatus = await apiClient.updateGatewaySettings({ translationEnabled: enabled });
              setGatewayStatus(nextStatus);
            }, "Update Gateway translation setting");
          }}
          onStartGatewayQrLogin={() => {
            void withBusy(async () => {
              const result = await apiClient.startGatewayQrLogin();
              setGatewayQrLogin(result);
              setGatewayQrCheck(null);
              setGatewayQrModalOpen(true);
              await loadGatewayStatus();
            }, "Start Gateway QR login");
          }}
          onStartGatewayLarkRegistration={() => {
            void withBusy(async () => {
              const result = await apiClient.startGatewayLarkRegistration();
              setGatewayLarkRegistration(result);
              setGatewayLarkRegistrationCheck(null);
              setGatewayLarkRegistrationModalOpen(true);
              await loadGatewayStatus();
            }, "Start Lark Gateway QR setup");
          }}
          onResetGatewayBinding={() => {
            void withBusy(async () => {
              const nextStatus = await apiClient.resetGatewayBinding();
              setGatewayStatus(nextStatus);
              setGatewayQrLogin(null);
              setGatewayQrCheck(null);
              setGatewayQrModalOpen(false);
              setGatewayLarkRegistration(null);
              setGatewayLarkRegistrationCheck(null);
              setGatewayLarkRegistrationModalOpen(false);
            }, "Reset Gateway binding");
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
            }, `Update ${gate} Gate Review setting`);
          }}
          onTranslationEnabledChange={(enabled) => {
            setTranslationEnabled(enabled);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ translationEnabled: enabled });
              applyPreferences(preferences);
            }, "Update conversation translation setting");
          }}
          onTranslationAutoSendChange={(enabled) => {
            setTranslationAutoSendEnabled(enabled);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ translationAutoSendEnabled: enabled });
              applyPreferences(preferences);
            }, "Update translation auto-send setting");
          }}
          onTranslationTargetLanguageChange={(targetLanguage) => {
            setTranslationTargetLanguage(targetLanguage);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ translationTargetLanguage: targetLanguage });
              applyPreferences(preferences);
            }, "Update translation target language");
          }}
          onTranslationOutputModeChange={(outputMode) => {
            setTranslationOutputMode(outputMode);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ translationOutputMode: outputMode });
              applyPreferences(preferences);
            }, "Update translation output mode");
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
              await refreshTranslationMemoryInitialized();
              await refreshTranslatorSession();
            }, "Create Translation Bootstrap task");
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
              await refreshTranslationMemoryInitialized();
              await refreshTranslatorSession();
            }, "Create translation memory update task");
          }}
          onCreateTask={(input) => withBusy(async () => {
            const task = await apiClient.createTask(input);
            await loadTasks();
            setActiveTaskSlug(task.taskSlug);
          }, "Create task")}
          onCloseTask={() => {
            void withBusy(closeActiveTask, "Close task");
          }}
          onSelectTask={setActiveTaskSlug}
          themeMode={themeMode}
          onAutoOrchestrationChange={(enabled) => {
            void withBusy(async () => {
              if (!activeTask) {
                throw new Error("Create or select a task before changing auto orchestration.");
              }
              const orchestration = await apiClient.updateOrchestrationState(activeTask.taskSlug, {
                mode: enabled ? "auto" : "manual"
              });
              setActiveOrchestration({ taskSlug: activeTask.taskSlug, orchestration });
            }, "Update auto orchestration mode");
          }}
          onThemeModeChange={(nextThemeMode) => {
            setThemeMode(nextThemeMode);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ themeMode: nextThemeMode });
              applyPreferences(preferences);
            }, "Update theme setting");
          }}
          pauseAlertSound={pauseAlertSound}
          onPauseAlertSoundChange={(enabled) => {
            setPauseAlertSound(enabled);
            if (enabled) {
              void primeFlowPauseAudio();
            }
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ flowPauseAlerts: enabled });
              applyPreferences(preferences);
            }, "Update pause alert sound setting");
          }}
          roleRetryEnabled={roleRetryEnabled}
          onRoleRetryEnabledChange={(enabled) => {
            setRoleRetryEnabled(enabled);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ roleRetryEnabled: enabled });
              applyPreferences(preferences);
            }, "Update CC retry setting");
          }}
          permissionRequestMode={permissionRequestMode}
          onPermissionRequestModeChange={(nextMode) => {
            setPermissionRequestMode(nextMode);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ permissionRequestMode: nextMode });
              applyPreferences(preferences);
            }, "Update permission request setting");
          }}
          launchTemplate={launchTemplate}
          canSaveLaunchTemplate={canSaveLaunchTemplate}
          canOneClickStart={canOneClickStart}
          onSaveLaunchTemplate={() => {
            void withBusy(async () => {
              if (!activeTaskLaunchState?.statusLoaded) {
                throw new Error("Open a task workspace before saving a launch template.");
              }

              const preferences = await apiClient.updateAppPreferences({
                launchTemplate: {
                  version: 1,
                  roles: activeTaskLaunchState.roles,
                  autoOrchestration: activeTaskLaunchState.autoOrchestration
                }
              });
              applyPreferences(preferences);
            }, "Save launch template");
          }}
          onOneClickStart={() => {
            void withBusy(async () => {
              if (!activeTask) {
                throw new Error("Create or select a task before one-click start.");
              }

              // The backend owns roster composition, orchestration mode, the
              // fresh-start precondition, and per-role skip/resume/start.
              const result = await apiClient.oneClickStart(activeTask.taskSlug);
              setActiveOrchestration({
                taskSlug: activeTask.taskSlug,
                orchestration: result.orchestration
              });

              setActiveRole("project-manager");
              await refreshMessageState(activeTask.taskSlug);
              await loadTasks();
              setWorkspaceRefreshNonce((current) => current + 1);
            }, "One-click start role sessions");
          }}
          onMarkAllMessagesDone={(taskSlug) => {
            void withBusy(async () => {
              const result = await apiClient.markAllMessagesDone(taskSlug);
              setActiveMessages({ taskSlug, messages: result.messages });
              await refreshMessageState(taskSlug);
            }, "Mark all role messages done");
          }}
          onDeleteMessageHistory={(taskSlug) => {
            void withBusy(async () => {
              const result = await apiClient.deleteMessageHistory(taskSlug);
              setActiveMessages({ taskSlug, messages: result.messages });
              await refreshMessageState(taskSlug);
            }, "Delete role message history");
          }}
        />
      )}
    >
      <UiErrorCenter />
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
      {roleRecoveryNoticeText && roleRecoveryNoticeKey ? (
        <div className="role-recovery-toast" role="status">
          <span>{roleRecoveryNoticeText}</span>
          <button type="button" onClick={() => setDismissedRoleRecoveryKey(roleRecoveryNoticeKey)}>
            Close
          </button>
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
      {gatewayLarkRegistrationModalOpen && gatewayLarkRegistration ? (
        <GatewayLarkRegistrationModal
          busy={busy}
          registration={gatewayLarkRegistration}
          registrationCheck={gatewayLarkRegistrationCheck}
          onCheck={() => {
            void withBusy(async () => {
              const result = await apiClient.checkGatewayLarkRegistration();
              setGatewayLarkRegistrationCheck(result);
              if (result.gatewayStatus) {
                setGatewayStatus(result.gatewayStatus);
              }
              if (result.status === "confirmed") {
                setGatewayLarkRegistrationModalOpen(false);
                await loadGatewayStatus();
              }
            }, "Check Lark Gateway QR setup");
          }}
          onManualBind={(appId, appSecret) => {
            void withBusy(async () => {
              const result = await apiClient.bindGatewayLarkApp({
                appId,
                appSecret,
                larkDomain: "lark"
              });
              setGatewayLarkRegistrationCheck(result);
              if (result.gatewayStatus) {
                setGatewayStatus(result.gatewayStatus);
              }
              if (result.status === "confirmed") {
                setGatewayLarkRegistrationModalOpen(false);
                await loadGatewayStatus();
              }
            }, "Bind Lark Gateway app");
          }}
          onClose={() => setGatewayLarkRegistrationModalOpen(false)}
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
          launchTemplate={launchTemplate}
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
          }, "Refresh Harness Studio");
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
          }, "Start Harness Engineer");
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
          }, "Resume Harness Engineer");
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
          }, "Restart Harness Engineer");
        }}
        onEngineerStop={() => {
          void withBusy(async () => {
            const session = await apiClient.stopHarnessEngineerSession();
            setHarnessEngineerSession(session);
          }, "Stop Harness Engineer");
        }}
        onEngineerNotifyHarnessUpdated={() => {
          void withBusy(async () => {
            const session = await apiClient.notifyHarnessEngineerHarnessUpdated();
            setHarnessEngineerSession(session);
            syncHarnessEngineerLaunchOptions(session);
          }, "Notify Harness Engineer to reload harness");
        }}
        onOpenRepositoryDiff={() => setRepositoryDiffOpen(true)}
        onReviewTaskHarness={() => {
          void withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before reviewing task harness.");
            }
            const state = await apiClient.startTaskHarnessRetrospective({
              taskSlug: activeTask.taskSlug,
              trigger: "manual"
            });
            setHarnessFeedbackState(state);
            await refreshHarnessEngineerSession({ syncLaunchOptions: true });
          }, "Review task harness");
        }}
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
          }, "Start Translator session");
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
          }, "Resume Translator session");
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
          }, "Restart Translator session");
        }}
        onStop={() => {
          void withBusy(async () => {
            const session = await apiClient.stopTranslatorSession();
            setTranslatorSession(session);
          }, "Stop Translator session");
        }}
        onNotifyHarnessUpdated={() => {
          void withBusy(async () => {
            const session = await apiClient.notifyTranslatorHarnessUpdated();
            setTranslatorSession(session);
            syncTranslatorLaunchOptions(session);
          }, "Notify Translator to reload harness");
        }}
      />
      <HarnessFeedbackReview
        busy={busy}
        state={harnessFeedbackState}
        onCancel={(comment) => {
          void withBusy(async () => {
            const state = await apiClient.decideHarnessFeedback({
              action: "cancel",
              taskSlug: activeTask?.taskSlug,
              comment
            });
            setHarnessFeedbackState(state);
          }, "Cancel Harness feedback");
        }}
        onApprove={(comment) => {
          void withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before approving Harness feedback.");
            }
            const state = await apiClient.decideHarnessFeedback({
              action: "approve",
              taskSlug: activeTask.taskSlug,
              comment
            });
            setHarnessFeedbackState(state);
            await refreshHarnessEngineerSession();
          }, "Approve Harness feedback");
        }}
        onComment={(comment) => {
          void withBusy(async () => {
            if (!activeTask) {
              throw new Error("Create or select a task before sending Harness feedback comments.");
            }
            const state = await apiClient.decideHarnessFeedback({
              action: "comment",
              taskSlug: activeTask.taskSlug,
              comment
            });
            setHarnessFeedbackState(state);
            await refreshHarnessEngineerSession();
          }, "Send Harness feedback comment");
        }}
        onReject={(comment) => {
          void withBusy(async () => {
            const state = await apiClient.decideHarnessFeedback({
              action: "reject",
              taskSlug: activeTask?.taskSlug,
              comment
            });
            setHarnessFeedbackState(state);
          }, "Reject Harness feedback");
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
  const [qrError, setQrError] = useUiErrorState("");

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
        setQrError(formatUiError("Render Gateway QR login code", error));
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
                {qrError ? "QR code could not be rendered." : "Rendering QR code..."}
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

function GatewayLarkRegistrationModal({
  busy,
  onCheck,
  onClose,
  onManualBind,
  registration,
  registrationCheck
}: {
  busy: boolean;
  onCheck(): void;
  onClose(): void;
  onManualBind(appId: string, appSecret: string): void;
  registration: StartGatewayLarkRegistrationResult;
  registrationCheck: CheckGatewayLarkRegistrationResult | null;
}) {
  const [qrImageSrc, setQrImageSrc] = useState("");
  const [qrError, setQrError] = useUiErrorState("");
  const [manualAppId, setManualAppId] = useState("");
  const [manualAppSecret, setManualAppSecret] = useState("");
  const [manualError, setManualError] = useUiErrorState("");

  useEffect(() => {
    let cancelled = false;
    setQrError("");
    setQrImageSrc("");
    try {
      const qr = qrcode(0, "M");
      qr.addData(registration.qrUrl);
      qr.make();
      if (!cancelled) {
        setQrImageSrc(qr.createDataURL(8, 2));
      }
    } catch (error) {
      if (!cancelled) {
        setQrError(formatUiError("Render Lark Gateway setup QR code", error));
      }
    }
    return () => {
      cancelled = true;
    };
  }, [registration.qrUrl]);

  return (
    <div className="modal-backdrop">
      <section
        aria-labelledby="gateway-lark-registration-title"
        aria-modal="true"
        className="gateway-qr-modal"
        role="dialog"
      >
        <header>
          <div>
            <h2 id="gateway-lark-registration-title">Lark Gateway Setup</h2>
            <p className="muted">Scan with Lark, approve bot creation, then click Confirm.</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <div className="gateway-qr-modal-body">
          <div className="gateway-qr-code-frame">
            {qrImageSrc ? (
              <img alt="Lark Gateway setup QR code" src={qrImageSrc} />
            ) : (
              <div className="gateway-qr-placeholder">
                {qrError ? "QR code could not be rendered." : "Rendering QR code..."}
              </div>
            )}
          </div>
          <div className="gateway-qr-actions">
            <button type="button" disabled={busy} onClick={onCheck}>Confirm</button>
          </div>
          <dl className="gateway-qr-meta">
            <div>
              <dt>Status</dt>
              <dd>{registrationCheck?.status ?? registration.status}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{formatFullTime(registration.expiresAt)}</dd>
            </div>
            {registration.userCode ? (
              <div>
                <dt>User Code</dt>
                <dd>{registration.userCode}</dd>
              </div>
            ) : null}
            {registrationCheck?.larkBotName ? (
              <div>
                <dt>Bot</dt>
                <dd>{registrationCheck.larkBotName}</dd>
              </div>
            ) : null}
            {registrationCheck?.message ? (
              <div>
                <dt>Message</dt>
                <dd>{registrationCheck.message}</dd>
              </div>
            ) : null}
          </dl>
          <form
            className="gateway-manual-bind"
            onSubmit={(event) => {
              event.preventDefault();
              const appId = manualAppId.trim();
              const appSecret = manualAppSecret.trim();
              if (!appId || !appSecret) {
                setManualError("Enter both App ID and App Secret.");
                return;
              }
              setManualError("");
              setManualAppSecret("");
              onManualBind(appId, appSecret);
            }}
          >
            <div>
              <label htmlFor="gateway-lark-app-id">App ID</label>
              <input
                id="gateway-lark-app-id"
                autoComplete="off"
                disabled={busy}
                value={manualAppId}
                onChange={(event) => setManualAppId(event.currentTarget.value)}
                placeholder="cli_xxx"
              />
            </div>
            <div>
              <label htmlFor="gateway-lark-app-secret">App Secret</label>
              <input
                id="gateway-lark-app-secret"
                autoComplete="off"
                disabled={busy}
                type="password"
                value={manualAppSecret}
                onChange={(event) => setManualAppSecret(event.currentTarget.value)}
                placeholder="Enter App Secret"
              />
            </div>
            {manualError ? <p className="form-error">{manualError}</p> : null}
            <button type="submit" disabled={busy}>Bind manually</button>
          </form>
        </div>
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

function shouldShowFlowPauseNotice(
  roundState: VcmSessionRoundState,
  previousObservation: { status: VcmRoundStatus } | undefined,
  taskViewStartedAtMs: number | undefined
): boolean {
  if (previousObservation?.status === "running") {
    return true;
  }

  const stoppedAtMs = Date.parse(roundState.stoppedAt ?? roundState.lastTurnEndedAt ?? "");
  return Boolean(
    taskViewStartedAtMs &&
    Number.isFinite(stoppedAtMs) &&
    stoppedAtMs > taskViewStartedAtMs
  );
}

function getRoleRecoveryNoticeKey(taskSlug: string, recovery: VcmRoleRecoveryState): string {
  return `${taskSlug}:${recovery.role}:${recovery.lastFailureAt}`;
}

function formatRoleRecoveryNotice(recovery: VcmRoleRecoveryState): string {
  const role = formatRoleRecoveryRole(recovery.role);
  const reason = formatRoleRecoveryReason(recovery);
  if (recovery.status === "retrying") {
    return `CC 出错，正在重试 ${role}${reason} · 第 ${recovery.attempt}/${recovery.maxAttempts} 次`;
  }
  return `CC 出错，重试中 ${role}${reason} · 第 ${recovery.attempt}/${recovery.maxAttempts} 次 · ${formatRetryDelay(recovery.nextRetryAt)}`;
}

function formatRoleRecoveryFailureMessage(recovery: VcmRoleRecoveryState, roleLabel: string): string {
  const reason = formatRoleRecoveryReason(recovery);
  if (recovery.retryable === false) {
    return `CC stopped for ${roleLabel}: ${formatRoleRecoveryError(recovery)} cannot be fixed by retrying.`;
  }
  return `CC retry failed after ${recovery.maxAttempts} attempts for ${roleLabel}${reason}.`;
}

function formatRoleRecoveryReason(recovery: VcmRoleRecoveryState): string {
  if (!recovery.error || recovery.error === "unknown") {
    return "";
  }
  return ` · ${recovery.error}`;
}

function formatRoleRecoveryError(recovery: VcmRoleRecoveryState): string {
  return recovery.error && recovery.error !== "unknown"
    ? recovery.error
    : "this error";
}

function formatRoleRecoveryRole(role: string): string {
  return role
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatRetryDelay(nextRetryAt: string | undefined): string {
  if (!nextRetryAt) {
    return "即将重试";
  }
  const delayMs = Date.parse(nextRetryAt) - Date.now();
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return "即将重试";
  }
  const minutes = Math.ceil(delayMs / 60_000);
  return `${minutes} 分钟后`;
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
