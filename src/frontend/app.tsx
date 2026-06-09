import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ThemeMode } from "../shared/types/app-settings.js";
import type {
  HarnessApplyResult,
  HarnessBootstrapStatusReport,
  HarnessStatusReport
} from "../shared/types/harness.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../shared/types/message.js";
import type { ProjectSummary } from "../shared/types/project.js";
import type { RoleName } from "../shared/types/role.js";
import type { VcmTaskRoundState } from "../shared/types/round.js";
import type { TaskRecord } from "../shared/types/task.js";
import { AppShell } from "./components/app-shell.js";
import { selectActiveTask } from "./state/app-store.js";
import { apiClient } from "./state/api-client.js";
import { ProjectDashboard } from "./routes/project-dashboard.js";
import { TaskWorkspace } from "./routes/task-workspace.js";

const FLOW_PAUSE_STRONG_ALERT_THRESHOLD_MS = 10 * 60 * 1000;
const FLOW_PAUSE_CHIME_INTERVAL_MS = 1400;
const FLOW_PAUSE_WEAK_CHIME_COUNT = 3;

export function App() {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [recentRepositoryPaths, setRecentRepositoryPaths] = useState<string[]>([]);
  const [harnessStatus, setHarnessStatus] = useState<HarnessStatusReport | null>(null);
  const [harnessBootstrapStatus, setHarnessBootstrapStatus] = useState<HarnessBootstrapStatusReport | null>(null);
  const [harnessApplyResult, setHarnessApplyResult] = useState<HarnessApplyResult | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [activeTaskSlug, setActiveTaskSlug] = useState<string | null>(null);
  const [activeMessages, setActiveMessages] = useState<{ taskSlug: string; messages: VcmRoleMessage[] } | null>(null);
  const [activeOrchestration, setActiveOrchestration] = useState<{ taskSlug: string; orchestration: VcmOrchestrationState } | null>(null);
  const [activeEvents, setActiveEvents] = useState<{ taskSlug: string; events: string[] } | null>(null);
  const [activeRoundState, setActiveRoundState] = useState<{ taskSlug: string; roundState: VcmTaskRoundState } | null>(null);
  const [activeRole, setActiveRole] = useState<RoleName>("project-manager");
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [flowPauseAlerts, setFlowPauseAlerts] = useState(true);
  const [flowPauseNotice, setFlowPauseNotice] = useState<{ id: string; text: string } | null>(null);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notifiedFlowPauseRef = useRef<Record<string, string>>({});
  const flowPauseAlarmRef = useRef<number | null>(null);
  const activeTask = useMemo(
    () => selectActiveTask(tasks, activeTaskSlug),
    [tasks, activeTaskSlug]
  );

  const stopFlowPauseAlarm = useCallback(() => {
    if (flowPauseAlarmRef.current === null) {
      return;
    }
    window.clearInterval(flowPauseAlarmRef.current);
    flowPauseAlarmRef.current = null;
  }, []);

  const startStrongFlowPauseAlarm = useCallback(() => {
    stopFlowPauseAlarm();
    playFlowPauseSound();
    flowPauseAlarmRef.current = window.setInterval(playFlowPauseSound, FLOW_PAUSE_CHIME_INTERVAL_MS);
  }, [stopFlowPauseAlarm]);

  const playWeakFlowPauseAlert = useCallback(() => {
    stopFlowPauseAlarm();
    setFlowPauseNotice(null);
    let playCount = 1;
    playFlowPauseSound();
    flowPauseAlarmRef.current = window.setInterval(() => {
      playCount += 1;
      playFlowPauseSound();
      if (playCount >= FLOW_PAUSE_WEAK_CHIME_COUNT && flowPauseAlarmRef.current !== null) {
        window.clearInterval(flowPauseAlarmRef.current);
        flowPauseAlarmRef.current = null;
      }
    }, FLOW_PAUSE_CHIME_INTERVAL_MS);
  }, [stopFlowPauseAlarm]);

  const showStrongFlowPauseNotice = useCallback((text: string, id = `manual-${Date.now()}`) => {
    setFlowPauseNotice({ id, text });
    startStrongFlowPauseAlarm();
  }, [startStrongFlowPauseAlarm]);

  const confirmFlowPauseNotice = useCallback(() => {
    stopFlowPauseAlarm();
    setFlowPauseNotice(null);
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

  const handleRoundStateChanged = useCallback((roundState: VcmTaskRoundState) => {
    if (!activeTask?.taskSlug || roundState.taskSlug !== activeTask.taskSlug) {
      return;
    }
    setActiveRoundState({ taskSlug: roundState.taskSlug, roundState });
    if (roundState.status !== "paused" || !roundState.pauseId) {
      return;
    }

    const previousPauseId = notifiedFlowPauseRef.current[roundState.taskSlug];
    if (previousPauseId === roundState.pauseId) {
      return;
    }

    notifiedFlowPauseRef.current[roundState.taskSlug] = roundState.pauseId;
    if (!flowPauseAlerts) {
      return;
    }

    const roleLabel = roundState.activeRole ?? "role";
    if (getFlowPauseDurationMs(roundState) >= FLOW_PAUSE_STRONG_ALERT_THRESHOLD_MS) {
      showStrongFlowPauseNotice(`No new turn started after ${roleLabel} stopped.`, roundState.pauseId);
    } else {
      playWeakFlowPauseAlert();
    }
  }, [activeTask?.taskSlug, flowPauseAlerts, playWeakFlowPauseAlert, showStrongFlowPauseNotice]);

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
      apiClient.getAppPreferences()
    ])
      .then(async ([currentProject, recentPaths, preferences]) => {
        setProject(currentProject);
        setRecentRepositoryPaths(recentPaths);
        setThemeMode(preferences.themeMode);
        setFlowPauseAlerts(preferences.flowPauseAlerts);
        if (currentProject) {
          await Promise.all([
            loadTasks(),
            loadHarnessStatus(),
            loadHarnessBootstrapStatus()
          ]);
        }
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

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
    activeRoundState && activeRoundState.taskSlug === activeTask?.taskSlug
      ? activeRoundState.roundState
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
              setThemeMode(preferences.themeMode);
              setFlowPauseAlerts(preferences.flowPauseAlerts);
            });
          }}
          flowPauseAlerts={flowPauseAlerts}
          onFlowPauseAlertsChange={(enabled) => {
            setFlowPauseAlerts(enabled);
            void withBusy(async () => {
              const preferences = await apiClient.updateAppPreferences({ flowPauseAlerts: enabled });
              setThemeMode(preferences.themeMode);
              setFlowPauseAlerts(preferences.flowPauseAlerts);
            });
          }}
          onTryFlowPauseAlert={() => {
            showStrongFlowPauseNotice("This is a test flow pause alert.");
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
            <h2 id="flow-pause-alert-title">Flow paused</h2>
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
      {project && activeTask ? (
        <TaskWorkspace
          task={activeTask}
          activeRole={activeRole}
          onTaskChanged={async () => {
            await loadTasks();
          }}
          onActiveRoleChange={setActiveRole}
          onMessagesChanged={handleMessagesChanged}
          onOrchestrationChanged={handleOrchestrationChanged}
          onRoundStateChanged={handleRoundStateChanged}
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

type AudioContextWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

function getFlowPauseDurationMs(roundState: VcmTaskRoundState): number {
  const startedAt = Date.parse(roundState.startedAt ?? "");
  const endedAt = Date.parse(roundState.lastStopAt ?? "");
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return 0;
  }
  return Math.max(0, endedAt - startedAt);
}

function playFlowPauseSound(): void {
  const AudioContextCtor = window.AudioContext ?? (window as AudioContextWindow).webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }

  try {
    const context = new AudioContextCtor();
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
    void context.resume?.().catch(() => undefined);
    window.setTimeout(() => {
      void context.close().catch(() => undefined);
    }, 800);
  } catch {
    // Browser autoplay policy can block audio until the page has user activation.
  }
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
