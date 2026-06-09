import { FormEvent, type ReactNode, useEffect, useState } from "react";
import type { ThemeMode } from "../../shared/types/app-settings.js";
import type {
  HarnessApplyResult,
  HarnessBootstrapStatusReport,
  HarnessStatusReport
} from "../../shared/types/harness.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import type { ProjectSummary } from "../../shared/types/project.js";
import type { VcmTaskRoundState } from "../../shared/types/round.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { EventLog } from "../components/event-log.js";
import { HarnessPanel } from "../components/harness-panel.js";
import { MessageTimeline, getMessageCounts } from "../components/message-timeline.js";
import { RepoConnectForm } from "../components/repo-connect-form.js";
import { TaskNav } from "../components/task-nav.js";

export interface ProjectDashboardProps {
  project: ProjectSummary | null;
  recentRepositoryPaths: string[];
  tasks: TaskRecord[];
  activeTaskSlug: string | null;
  messages: VcmRoleMessage[];
  orchestration: VcmOrchestrationState | null;
  events: string[];
  roundState: VcmTaskRoundState | null;
  harnessStatus: HarnessStatusReport | null;
  harnessBootstrapStatus: HarnessBootstrapStatusReport | null;
  harnessApplyResult?: HarnessApplyResult | null;
  busy?: boolean;
  onConnect(repoPath: string): Promise<void>;
  onRefreshHarness(): Promise<void>;
  onApplyHarness(): Promise<void>;
  onStartHarnessBootstrap(): Promise<void>;
  onCreateTask(input: { taskSlug: string; createWorktree?: boolean; title?: string }): Promise<void>;
  onSelectTask(taskSlug: string): void;
  themeMode: ThemeMode;
  onThemeModeChange(themeMode: ThemeMode): void;
  flowPauseAlerts: boolean;
  onFlowPauseAlertsChange(enabled: boolean): void;
  onTryFlowPauseAlert(): void;
  onMarkAllMessagesDone(taskSlug: string): void;
  onDeleteMessageHistory(taskSlug: string): void;
}

export function ProjectDashboard({
  project,
  recentRepositoryPaths,
  tasks,
  activeTaskSlug,
  messages,
  orchestration,
  events,
  roundState,
  harnessStatus,
  harnessBootstrapStatus,
  harnessApplyResult,
  busy,
  onConnect,
  onRefreshHarness,
  onApplyHarness,
  onStartHarnessBootstrap,
  onCreateTask,
  onSelectTask,
  themeMode,
  onThemeModeChange,
  flowPauseAlerts,
  onFlowPauseAlertsChange,
  onTryFlowPauseAlert,
  onMarkAllMessagesDone,
  onDeleteMessageHistory
}: ProjectDashboardProps) {
  const [taskSlug, setTaskSlug] = useState("");
  const [createWorktree, setCreateWorktree] = useState(true);
  const [showMessages, setShowMessages] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const messageCounts = getMessageCounts(messages);
  const normalizedTaskSlug = taskSlug.trim();
  const activeTask = tasks.find((task) => task.taskSlug === activeTaskSlug) ?? null;

  async function handleCreateTask(event: FormEvent) {
    event.preventDefault();
    await onCreateTask({ taskSlug: normalizedTaskSlug, createWorktree });
    setTaskSlug("");
    setCreateWorktree(true);
  }

  return (
    <div className="project-dashboard">
      <header className="brand-header">
        <strong>VibeCodingMaster</strong>
      </header>

      <SidebarSection title="Repository Path" defaultOpen={!activeTaskSlug}>
        <RepoConnectForm
          defaultPath={project?.repoRoot ?? ""}
          recentPaths={recentRepositoryPaths}
          busy={busy}
          onConnect={onConnect}
        />
      </SidebarSection>

      {project ? (
        <SidebarSection title="Repository">
          <div className="project-summary">
            <dl>
              <div>
                <dt>Path</dt>
                <dd>{project.repoRoot}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>{project.branch}</dd>
              </div>
              <div>
                <dt>Working tree</dt>
                <dd>{project.isDirty ? "uncommitted changes" : "clean"}</dd>
              </div>
            </dl>
            {project.warnings.length > 0 ? (
              <ul className="warnings">
                {project.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </SidebarSection>
      ) : null}

      <SidebarSection title="Settings">
        <div className="sidebar-settings">
          <button
            aria-label={`Theme mode: ${getThemeModeLabel(themeMode)}`}
            className="settings-toggle theme-mode-toggle"
            disabled={busy}
            title="Cycle theme: system, light, dark"
            type="button"
            onClick={() => onThemeModeChange(getNextThemeMode(themeMode))}
          >
            <span>Theme</span>
            <span>{getThemeModeLabel(themeMode)}</span>
          </button>
          <button
            aria-pressed={flowPauseAlerts}
            className={flowPauseAlerts ? "settings-toggle is-active" : "settings-toggle"}
            disabled={busy}
            type="button"
            onClick={() => onFlowPauseAlertsChange(!flowPauseAlerts)}
          >
            <span>Flow pause alert</span>
            <span>{flowPauseAlerts ? "on" : "off"}</span>
          </button>
          <button
            className="settings-toggle"
            type="button"
            onClick={onTryFlowPauseAlert}
          >
            <span>Try alert</span>
            <span>test</span>
          </button>
          {activeTaskSlug ? (
            <>
              <button type="button" onClick={() => setShowMessages(true)}>
                <span>Messages</span>
                <span className="muted">
                  {messageCounts.total} total
                </span>
              </button>
              <button type="button" onClick={() => setShowEvents(true)}>
                <span>Events</span>
                <span className="muted">{events.length} total</span>
              </button>
            </>
          ) : null}
        </div>
      </SidebarSection>

      {project ? (
        <SidebarSection title="VCM Harness">
          <HarnessPanel
            status={harnessStatus}
            bootstrapStatus={harnessBootstrapStatus}
            applyResult={harnessApplyResult}
            busy={busy}
            onRefresh={onRefreshHarness}
            onApply={onApplyHarness}
            onStartBootstrap={onStartHarnessBootstrap}
          />
        </SidebarSection>
      ) : null}

      {project ? (
        <SidebarSection title="New Task">
          <div className="task-create">
            <form onSubmit={handleCreateTask}>
              <input
                value={taskSlug}
                onChange={(event) => setTaskSlug(event.target.value)}
                placeholder="task name"
              />
              <label className="task-create-option">
                <input
                  type="checkbox"
                  checked={createWorktree}
                  onChange={(event) => setCreateWorktree(event.target.checked)}
                />
                <span>Create worktree and branch</span>
              </label>
              {createWorktree ? (
                <div className="task-create-preview">
                  <small>branch: {normalizedTaskSlug ? `feature/${normalizedTaskSlug}` : "feature/<task>"}</small>
                  <small>worktree: {normalizedTaskSlug ? `.claude/worktrees/${normalizedTaskSlug}` : ".claude/worktrees/<task>"}</small>
                </div>
              ) : (
                <div className="task-create-preview">
                  <small>uses current repository path and current branch</small>
                </div>
              )}
              <button type="submit" disabled={busy || !normalizedTaskSlug}>
                Create
              </button>
            </form>
          </div>
        </SidebarSection>
      ) : null}

      {tasks.length > 0 ? (
        <SidebarSection title="Tasks">
          <TaskNav tasks={tasks} activeTaskSlug={activeTaskSlug} onSelect={onSelectTask} />
        </SidebarSection>
      ) : null}

      {project && activeTask ? (
        <TaskStatusDock task={activeTask} roundState={roundState} />
      ) : null}

      {showMessages ? (
        <MessageDialog
          busy={busy}
          messages={messages}
          orchestration={orchestration}
          onClose={() => setShowMessages(false)}
          onMarkAllDone={() => {
            if (activeTaskSlug) {
              onMarkAllMessagesDone(activeTaskSlug);
            }
          }}
          onDeleteMessageHistory={() => {
            if (activeTaskSlug) {
              onDeleteMessageHistory(activeTaskSlug);
            }
          }}
        />
      ) : null}

      {showEvents ? (
        <EventDialog
          events={events}
          onClose={() => setShowEvents(false)}
        />
      ) : null}
    </div>
  );
}

function TaskStatusDock({
  roundState,
  task
}: {
  roundState: VcmTaskRoundState | null;
  task: TaskRecord;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const showCurrentRound = Boolean(
    roundState?.startedAt &&
    (roundState.status === "active" || roundState.status === "settling")
  );
  const taskElapsedMs = getElapsedMs(task.createdAt, nowMs);
  const totalCcActiveMs = getLiveCcActiveMs(roundState, roundState?.totalCcActiveMs ?? 0, nowMs);
  const currentRoundCcActiveMs = showCurrentRound && roundState
    ? getLiveCcActiveMs(roundState, roundState.currentRoundCcActiveMs, nowMs)
    : 0;
  const title = task.title?.trim() || task.taskSlug;

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="task-status-dock" aria-label="Task status">
      <div className="task-status-dock-title">
        <strong title={title}>{title}</strong>
        <span className={`status-badge status-${task.status}`}>{task.status}</span>
      </div>

      <dl className="task-status-stats">
        <div>
          <dt>Started</dt>
          <dd>{formatTime(task.createdAt)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{formatDuration(taskElapsedMs)}</dd>
        </div>
        <div>
          <dt>Rounds</dt>
          <dd>{roundState?.totalRoundCount ?? 0}</dd>
        </div>
        <div>
          <dt>CC runtime</dt>
          <dd>{formatDuration(totalCcActiveMs)}</dd>
        </div>
      </dl>

      {showCurrentRound && roundState ? (
        <div className="current-round-status">
          <div className="current-round-title">
            <span>Current round</span>
            <span className={`status-badge status-${roundState.status}`}>{roundState.status}</span>
          </div>
          <dl className="task-status-stats">
            <div>
              <dt>Started</dt>
              <dd>{formatTime(roundState.startedAt)}</dd>
            </div>
            <div>
              <dt>CC runtime</dt>
              <dd>{formatDuration(currentRoundCcActiveMs)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </section>
  );
}

function getLiveCcActiveMs(
  roundState: VcmTaskRoundState | null,
  baseMs: number,
  nowMs: number
): number {
  if (!roundState?.runningSince || roundState.status !== "active") {
    return baseMs;
  }
  const updatedAtMs = Date.parse(roundState.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return baseMs;
  }
  return baseMs + Math.max(0, nowMs - updatedAtMs);
}

function getElapsedMs(startedAt: string, nowMs: number): number {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return 0;
  }
  return Math.max(0, nowMs - startedAtMs);
}

function formatTime(value?: string): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

function getNextThemeMode(themeMode: ThemeMode): ThemeMode {
  if (themeMode === "system") {
    return "light";
  }
  if (themeMode === "light") {
    return "dark";
  }
  return "system";
}

function getThemeModeLabel(themeMode: ThemeMode): string {
  if (themeMode === "system") {
    return "System";
  }
  if (themeMode === "light") {
    return "Light";
  }
  return "Dark";
}

function EventDialog({ events, onClose }: { events: string[]; onClose(): void }) {
  return (
    <div className="modal-backdrop">
      <section className="event-modal" role="dialog" aria-modal="true" aria-label="Events">
        <header>
          <div>
            <h2>Events</h2>
            <p className="muted">{events.length} total</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <EventLog events={events} maxEvents={null} showHeader={false} />
      </section>
    </div>
  );
}

function MessageDialog({
  busy,
  messages,
  orchestration,
  onClose,
  onMarkAllDone,
  onDeleteMessageHistory
}: {
  busy?: boolean;
  messages: VcmRoleMessage[];
  orchestration: VcmOrchestrationState | null;
  onClose(): void;
  onMarkAllDone(): void;
  onDeleteMessageHistory(): void;
}) {
  const counts = getMessageCounts(messages);

  function markAllDone() {
    const confirmed = window.confirm(
      [
        "Clear all pending route-file messages?",
        "",
        "Use this only after you manually copied or handled stuck route-file messages.",
        "VCM will clear non-empty handoff message files so Stop-hook orchestration can continue."
      ].join("\n")
    );
    if (confirmed) {
      onMarkAllDone();
    }
  }

  function deleteMessageHistory() {
    const confirmed = window.confirm(
      [
        `Delete ${counts.total} message histor${counts.total === 1 ? "y item" : "y items"}?`,
        "",
        "This removes message history from the Messages panel.",
        "Pending route-file messages are not touched."
      ].join("\n")
    );
    if (confirmed) {
      onDeleteMessageHistory();
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="message-modal" role="dialog" aria-modal="true" aria-label="Messages">
        <header>
          <div>
            <h2>Messages</h2>
            <p className="muted">
              {counts.total} total / {counts.accepted} accepted
              {orchestration ? ` · ${orchestration.mode}` : ""}
            </p>
          </div>
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={markAllDone}>Mark All Done</button>
            <button type="button" disabled={busy || counts.total === 0} onClick={deleteMessageHistory}>Delete All</button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </header>
        <MessageTimeline
          busy={busy}
          maxMessages={null}
          messages={messages}
          orchestration={orchestration}
          showControls={false}
          showHeader={false}
        />
      </section>
    </div>
  );
}

function SidebarSection({
  children,
  defaultOpen = false,
  title
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  return (
    <section className="sidebar-section">
      <button
        aria-expanded={open}
        className="sidebar-section-toggle"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{title}</span>
        <span aria-hidden="true" className="sidebar-section-chevron" />
      </button>
      {open ? <div className="sidebar-section-content">{children}</div> : null}
    </section>
  );
}
