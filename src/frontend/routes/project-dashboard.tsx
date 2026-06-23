import { FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  TRANSLATION_OUTPUT_MODE_OPTIONS,
  TRANSLATION_TARGET_LANGUAGE_OPTIONS,
  type LaunchTemplate,
  type PermissionRequestMode,
  type ThemeMode,
  type TranslationOutputMode,
  type TranslationTargetLanguage
} from "../../shared/types/app-settings.js";
import type {
  HarnessApplyResult,
  HarnessBootstrapStatusReport,
  HarnessStatusReport
} from "../../shared/types/harness.js";
import type {
  CheckGatewayQrLoginResult,
  GatewayStatus,
  StartGatewayQrLoginResult
} from "../../shared/types/gateway.js";
import { GATE_REVIEW_GATES, type GateReviewGate, type GateReviewIndex } from "../../shared/types/gate-review.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import type { ProjectSummary } from "../../shared/types/project.js";
import type { VcmSessionRoundState } from "../../shared/types/round.js";
import type { ClaudePermissionMode, RoleSessionRecord, SessionEffort, SessionModel } from "../../shared/types/session.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { EventLog } from "../components/event-log.js";
import { HarnessPanel } from "../components/harness-panel.js";
import { MessageTimeline, getMessageCounts } from "../components/message-timeline.js";
import { RepoConnectForm } from "../components/repo-connect-form.js";
import { SwitchControl } from "../components/switch-control.js";
import { TaskNav } from "../components/task-nav.js";

type SidebarSectionId =
  | "repository-path"
  | "connected-repository"
  | "settings"
  | "translation"
  | "gate-review-gates"
  | "gateway"
  | "vcm-harness"
  | "new-task"
  | "tasks";

export interface ProjectDashboardProps {
  project: ProjectSummary | null;
  recentRepositoryPaths: string[];
  tasks: TaskRecord[];
  activeTaskSlug: string | null;
  messages: VcmRoleMessage[];
  orchestration: VcmOrchestrationState | null;
  events: string[];
  roundState: VcmSessionRoundState | null;
  gateReview: GateReviewIndex | null;
  translationEnabled: boolean;
  translationAutoSendEnabled: boolean;
  translationTargetLanguage: TranslationTargetLanguage;
  translationOutputMode: TranslationOutputMode;
  translationMemoryInitialized: boolean;
  translatorSession: RoleSessionRecord | null;
  harnessStatus: HarnessStatusReport | null;
  harnessBootstrapStatus: HarnessBootstrapStatusReport | null;
  harnessApplyResult?: HarnessApplyResult | null;
  gatewayStatus: GatewayStatus | null;
  gatewayQrLogin: StartGatewayQrLoginResult | null;
  gatewayQrCheck: CheckGatewayQrLoginResult | null;
  busy?: boolean;
  onConnect(repoPath: string): Promise<void>;
  onRefreshConnectedRepository(): Promise<void>;
  onPullConnectedRepository(): Promise<void>;
  onRefreshHarness(): Promise<void>;
  onApplyHarness(): Promise<void>;
  onStartHarnessBootstrap(input: { permissionMode: ClaudePermissionMode; model: SessionModel; effort: SessionEffort }): Promise<void>;
  onRestartHarnessBootstrap(input: { permissionMode: ClaudePermissionMode; model: SessionModel; effort: SessionEffort }): Promise<void>;
  onStopHarnessBootstrap(): Promise<void>;
  onRunHarnessBootstrap(): Promise<void>;
  onOpenHarnessStudio(): void;
  onOpenRepositoryDiff(): void;
  onRefreshGateway(): Promise<void>;
  onGatewayEnabledChange(enabled: boolean): void;
  onGatewayTranslationChange(enabled: boolean): void;
  onStartGatewayQrLogin(): void;
  onResetGatewayBinding(): void;
  onGateReviewGateEnabledChange(gate: GateReviewGate, enabled: boolean): void;
  onTranslationEnabledChange(enabled: boolean): void;
  onTranslationAutoSendChange(enabled: boolean): void;
  onTranslationTargetLanguageChange(targetLanguage: TranslationTargetLanguage): void;
  onTranslationOutputModeChange(outputMode: TranslationOutputMode): void;
  onOpenFileTranslation(): void;
  onOpenTranslatorSession(): void;
  onCreateTranslationBootstrap(): void;
  onUpdateTranslationMemory(): void;
  onCreateTask(input: { taskSlug: string; title?: string }): Promise<void>;
  onSelectTask(taskSlug: string): void;
  themeMode: ThemeMode;
  onThemeModeChange(themeMode: ThemeMode): void;
  flowPauseAlerts: boolean;
  onFlowPauseAlertsChange(enabled: boolean): void;
  permissionRequestMode: PermissionRequestMode;
  onPermissionRequestModeChange(mode: PermissionRequestMode): void;
  launchTemplate: LaunchTemplate;
  canSaveLaunchTemplate: boolean;
  canOneClickStart: boolean;
  onSaveLaunchTemplate(): void;
  onOneClickStart(): void;
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
  gateReview,
  translationEnabled,
  translationAutoSendEnabled,
  translationTargetLanguage,
  translationOutputMode,
  translationMemoryInitialized,
  translatorSession,
  harnessStatus,
  harnessBootstrapStatus,
  harnessApplyResult,
  gatewayStatus,
  gatewayQrLogin,
  gatewayQrCheck,
  busy,
  onConnect,
  onRefreshConnectedRepository,
  onPullConnectedRepository,
  onRefreshHarness,
  onApplyHarness,
  onStartHarnessBootstrap,
  onRestartHarnessBootstrap,
  onStopHarnessBootstrap,
  onRunHarnessBootstrap,
  onOpenHarnessStudio,
  onOpenRepositoryDiff,
  onRefreshGateway,
  onGatewayEnabledChange,
  onGatewayTranslationChange,
  onStartGatewayQrLogin,
  onResetGatewayBinding,
  onGateReviewGateEnabledChange,
  onTranslationEnabledChange,
  onTranslationAutoSendChange,
  onTranslationTargetLanguageChange,
  onTranslationOutputModeChange,
  onOpenFileTranslation,
  onOpenTranslatorSession,
  onCreateTranslationBootstrap,
  onUpdateTranslationMemory,
  onCreateTask,
  onSelectTask,
  themeMode,
  onThemeModeChange,
  flowPauseAlerts,
  onFlowPauseAlertsChange,
  permissionRequestMode,
  onPermissionRequestModeChange,
  launchTemplate,
  canSaveLaunchTemplate,
  canOneClickStart,
  onSaveLaunchTemplate,
  onOneClickStart,
  onTryFlowPauseAlert,
  onMarkAllMessagesDone,
  onDeleteMessageHistory
}: ProjectDashboardProps) {
  const [taskSlug, setTaskSlug] = useState("");
  const [showMessages, setShowMessages] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [openSidebarSection, setOpenSidebarSection] = useState<SidebarSectionId | null>(
    () => activeTaskSlug ? null : "repository-path"
  );
  const messageCounts = getMessageCounts(messages);
  const normalizedTaskSlug = taskSlug.trim();
  const translationBaseUnavailableReason = getTranslationBaseUnavailableReason(
    project,
    activeTaskSlug,
    harnessStatus
  );
  const activeTask = tasks.find((task) => task.taskSlug === activeTaskSlug) ?? null;

  useEffect(() => {
    setOpenSidebarSection((current) => {
      if (activeTaskSlug && current === "repository-path") {
        return null;
      }
      if (!activeTaskSlug && current === null) {
        return "repository-path";
      }
      return current;
    });
  }, [activeTaskSlug]);

  function handleSidebarSectionChange(sectionId: SidebarSectionId, open: boolean) {
    setOpenSidebarSection(open ? sectionId : null);
  }

  async function handleCreateTask(event: FormEvent) {
    event.preventDefault();
    await onCreateTask({ taskSlug: normalizedTaskSlug });
    setTaskSlug("");
  }

  return (
    <div className="project-dashboard">
      <header className="brand-header">
        <strong>VibeCodingMaster</strong>
      </header>

      <SidebarSection
        title="Repository Path"
        open={openSidebarSection === "repository-path"}
        onOpenChange={(open) => handleSidebarSectionChange("repository-path", open)}
      >
        <RepoConnectForm
          defaultPath={project?.repoRoot ?? ""}
          recentPaths={recentRepositoryPaths}
          busy={busy}
          onConnect={onConnect}
        />
      </SidebarSection>

      {project ? (
        <SidebarSection
          title="Connected Repository"
          open={openSidebarSection === "connected-repository"}
          onOpenChange={(open) => {
            handleSidebarSectionChange("connected-repository", open);
            if (open) {
              void onRefreshConnectedRepository();
            }
          }}
        >
          <ConnectedRepositoryPanel
            busy={busy}
            project={project}
            onPull={onPullConnectedRepository}
          />
        </SidebarSection>
      ) : null}

      <SidebarSection
        title="Settings"
        open={openSidebarSection === "settings"}
        onOpenChange={(open) => handleSidebarSectionChange("settings", open)}
      >
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
          <SwitchControl
            checked={!gatewayStatus?.enabled && flowPauseAlerts}
            className="sidebar-switch"
            disabled={busy || gatewayStatus?.enabled}
            label="Flow pause alert"
            stateLabel={gatewayStatus?.enabled ? "off" : flowPauseAlerts ? "on" : "off"}
            title={gatewayStatus?.enabled ? "Disabled while Gateway is on" : undefined}
            onChange={(checked) => onFlowPauseAlertsChange(checked)}
          />
          <button
            className="settings-toggle"
            disabled={busy || gatewayStatus?.enabled}
            title={gatewayStatus?.enabled ? "Disabled while Gateway is on" : undefined}
            type="button"
            onClick={onTryFlowPauseAlert}
          >
            <span>Try alert</span>
            <span>test</span>
          </button>
          <label className="settings-select-row">
            <span>Permission requests</span>
            <select
              value={permissionRequestMode}
              disabled={busy}
              onChange={(event) => onPermissionRequestModeChange(event.target.value as PermissionRequestMode)}
            >
              <option value="off">off</option>
              <option value="allowAll">allow all</option>
            </select>
          </label>
          <button
            className="settings-toggle"
            disabled={busy || !canSaveLaunchTemplate}
            title="Save the current core role launch settings and optional Gate Reviewer settings"
            type="button"
            onClick={onSaveLaunchTemplate}
          >
            <span>Save launch template</span>
            <span>{canSaveLaunchTemplate ? "ready" : "open task"}</span>
          </button>
          {canOneClickStart ? (
            <button
              className="settings-toggle is-active"
              disabled={busy}
              title={getLaunchTemplateSummary(launchTemplate)}
              type="button"
              onClick={onOneClickStart}
            >
              <span>One-click start</span>
              <span>{getLaunchTemplateBadge(launchTemplate)}</span>
            </button>
          ) : null}
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

      <SidebarSection
        title="Translation"
        open={openSidebarSection === "translation"}
        onOpenChange={(open) => handleSidebarSectionChange("translation", open)}
      >
        <TranslationControlsPanel
          busy={busy}
          enabled={translationEnabled}
          autoSendEnabled={translationAutoSendEnabled}
          targetLanguage={translationTargetLanguage}
          outputMode={translationOutputMode}
          memoryInitialized={translationMemoryInitialized}
          baseUnavailableReason={translationBaseUnavailableReason}
          translatorSession={translatorSession}
          onAutoSendChange={onTranslationAutoSendChange}
          onCreateBootstrap={onCreateTranslationBootstrap}
          onEnabledChange={onTranslationEnabledChange}
          onUpdateMemory={onUpdateTranslationMemory}
          onTargetLanguageChange={onTranslationTargetLanguageChange}
          onOutputModeChange={onTranslationOutputModeChange}
          onOpenFileTranslation={onOpenFileTranslation}
          onOpenTranslatorSession={onOpenTranslatorSession}
        />
      </SidebarSection>

      {project && activeTaskSlug ? (
        <SidebarSection
          title="Gate Review Gates"
          open={openSidebarSection === "gate-review-gates"}
          onOpenChange={(open) => handleSidebarSectionChange("gate-review-gates", open)}
        >
          <GateReviewGateSettings
            busy={busy}
            state={gateReview}
            onGateEnabledChange={onGateReviewGateEnabledChange}
          />
        </SidebarSection>
      ) : null}

      <SidebarSection
        title="Gateway"
        open={openSidebarSection === "gateway"}
        onOpenChange={(open) => {
          handleSidebarSectionChange("gateway", open);
          if (open) {
            void onRefreshGateway();
          }
        }}
      >
        <GatewayPanel
          busy={busy}
          qrCheck={gatewayQrCheck}
          qrLogin={gatewayQrLogin}
          status={gatewayStatus}
          onEnabledChange={onGatewayEnabledChange}
          onResetBinding={onResetGatewayBinding}
          onStartQrLogin={onStartGatewayQrLogin}
          onTranslationChange={onGatewayTranslationChange}
        />
      </SidebarSection>

      {project ? (
        <SidebarSection
          title="VCM Harness"
          open={openSidebarSection === "vcm-harness"}
          onOpenChange={(open) => handleSidebarSectionChange("vcm-harness", open)}
        >
          <HarnessPanel
            status={harnessStatus}
            bootstrapStatus={harnessBootstrapStatus}
            applyResult={harnessApplyResult}
            hasActiveTask={Boolean(activeTask)}
            busy={busy}
            onRefresh={onRefreshHarness}
            onApply={onApplyHarness}
            onOpenStudio={onOpenHarnessStudio}
            onOpenRepositoryDiff={onOpenRepositoryDiff}
            onStartBootstrap={onStartHarnessBootstrap}
            onRestartBootstrap={onRestartHarnessBootstrap}
            onStopBootstrap={onStopHarnessBootstrap}
            onRunBootstrap={onRunHarnessBootstrap}
          />
        </SidebarSection>
      ) : null}

      {project ? (
        <SidebarSection
          title="New Task"
          open={openSidebarSection === "new-task"}
          onOpenChange={(open) => handleSidebarSectionChange("new-task", open)}
        >
          <div className="task-create">
            <form onSubmit={handleCreateTask}>
              <input
                value={taskSlug}
                onChange={(event) => setTaskSlug(event.target.value)}
                placeholder="task name"
              />
              <div className="task-create-preview">
                <small>branch: {normalizedTaskSlug ? `feature/${normalizedTaskSlug}` : "feature/<task>"}</small>
                <small>worktree: {normalizedTaskSlug ? `.claude/worktrees/${normalizedTaskSlug}` : ".claude/worktrees/<task>"}</small>
              </div>
              <button type="submit" disabled={busy || !normalizedTaskSlug}>
                Create
              </button>
            </form>
          </div>
        </SidebarSection>
      ) : null}

      {tasks.length > 0 ? (
        <SidebarSection
          title="Tasks"
          open={openSidebarSection === "tasks"}
          onOpenChange={(open) => handleSidebarSectionChange("tasks", open)}
        >
          <TaskNav tasks={tasks} activeTaskSlug={activeTaskSlug} onSelect={onSelectTask} />
        </SidebarSection>
      ) : null}

      {project && activeTask ? (
        <SessionStatusDock task={activeTask} roundState={roundState} />
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

function getLaunchTemplateBadge(template: LaunchTemplate): string {
  const parts = [
    template.autoOrchestration ? "auto" : "manual"
  ];
  return parts.join(" + ");
}

function getLaunchTemplateSummary(template: LaunchTemplate): string {
  const roles = Object.entries(template.roles)
    .map(([role, config]) => `${role}: ${config.permissionMode} / ${config.model} / ${config.effort}`)
    .join("; ");
  return `Launch template: ${getLaunchTemplateBadge(template)}; ${roles}`;
}

function TranslationControlsPanel({
  autoSendEnabled,
  baseUnavailableReason,
  busy,
  enabled,
  memoryInitialized,
  outputMode,
  targetLanguage,
  translatorSession,
  onAutoSendChange,
  onCreateBootstrap,
  onEnabledChange,
  onUpdateMemory,
  onOutputModeChange,
  onTargetLanguageChange,
  onOpenFileTranslation,
  onOpenTranslatorSession
}: {
  autoSendEnabled: boolean;
  baseUnavailableReason: string | null;
  busy?: boolean;
  enabled: boolean;
  memoryInitialized: boolean;
  outputMode: TranslationOutputMode;
  targetLanguage: TranslationTargetLanguage;
  translatorSession: RoleSessionRecord | null;
  onAutoSendChange(enabled: boolean): void;
  onCreateBootstrap(): void;
  onEnabledChange(enabled: boolean): void;
  onUpdateMemory(): void;
  onOutputModeChange(outputMode: TranslationOutputMode): void;
  onTargetLanguageChange(targetLanguage: TranslationTargetLanguage): void;
  onOpenFileTranslation(): void;
  onOpenTranslatorSession(): void;
}) {
  const baseDisabled = Boolean(busy || baseUnavailableReason);
  const sessionRunning = translatorSession?.status === "running";
  const conversationEnabled = Boolean(enabled && !baseUnavailableReason && sessionRunning);
  const sessionUnavailableReason = baseUnavailableReason ?? (sessionRunning ? null : "Start Translator session first.");
  const sessionActionsDisabled = Boolean(busy || sessionUnavailableReason);
  const baseReadyTitle = "Open Translator session";
  const baseUnavailableTitle = baseUnavailableReason ?? baseReadyTitle;
  const sessionActionTitle = sessionUnavailableReason ?? "Translation tools are ready";

  return (
    <div className="sidebar-settings">
      <SwitchControl
        checked={conversationEnabled}
        className="sidebar-switch"
        disabled={baseDisabled || !sessionRunning}
        label="Conversation translation"
        title={sessionActionTitle}
        onChange={onEnabledChange}
      />
      <SwitchControl
        checked={autoSendEnabled}
        className="sidebar-switch"
        disabled={baseDisabled}
        label="Auto-send"
        onChange={onAutoSendChange}
      />
      <label className="settings-select-row">
        <span>Language</span>
        <select
          value={targetLanguage}
          disabled={baseDisabled}
          onChange={(event) => onTargetLanguageChange(event.target.value as TranslationTargetLanguage)}
        >
          {TRANSLATION_TARGET_LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-select-row">
        <span>Reply scope</span>
        <select
          value={outputMode}
          disabled={baseDisabled}
          onChange={(event) => onOutputModeChange(event.target.value as TranslationOutputMode)}
        >
          {TRANSLATION_OUTPUT_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button
        className="settings-toggle"
        disabled={sessionActionsDisabled}
        title={sessionActionTitle}
        type="button"
        onClick={onOpenFileTranslation}
      >
        <span>File translation</span>
        <span>open</span>
      </button>
      {!memoryInitialized ? (
        <button
          className="settings-toggle"
          disabled={sessionActionsDisabled}
          title={sessionActionTitle}
          type="button"
          onClick={onCreateBootstrap}
        >
          <span>Bootstrap</span>
          <span>run</span>
        </button>
      ) : null}
      <button
        className="settings-toggle"
        disabled={sessionActionsDisabled}
        title={sessionActionTitle}
        type="button"
        onClick={onUpdateMemory}
      >
        <span>Update memory</span>
        <span>run</span>
      </button>
      {sessionUnavailableReason ? (
        <p className="settings-help-text">{sessionUnavailableReason}</p>
      ) : null}
      <div className="settings-status-row">
        <span>Session status</span>
        <strong>{getTranslatorSessionStatus(translatorSession)}</strong>
      </div>
      <button
        className="settings-toggle"
        disabled={baseDisabled}
        title={baseUnavailableTitle}
        type="button"
        onClick={onOpenTranslatorSession}
      >
        <span>Open Session</span>
        <span>open</span>
      </button>
    </div>
  );
}

function getTranslatorSessionStatus(session: RoleSessionRecord | null): string {
  if (!session) {
    return "not started";
  }
  if (session.status === "running") {
    return session.activityStatus ?? "idle";
  }
  return session.status;
}

function getTranslationBaseUnavailableReason(
  project: ProjectSummary | null,
  activeTaskSlug: string | null,
  harnessStatus: HarnessStatusReport | null
): string | null {
  if (!project) {
    return "Connect a repository first.";
  }
  if (!activeTaskSlug) {
    return "Create or select a task first.";
  }
  if (!harnessStatus) {
    return "Load VCM Harness status first.";
  }
  if (!harnessStatus.initialized) {
    return "Initialize VCM Harness first.";
  }
  return null;
}

function GateReviewGateSettings({
  busy,
  onGateEnabledChange,
  state
}: {
  busy?: boolean;
  onGateEnabledChange(gate: GateReviewGate, enabled: boolean): void;
  state: GateReviewIndex | null;
}) {
  return (
    <div className="sidebar-settings">
      {GATE_REVIEW_GATES.map((gate) => {
        const record = state?.gates[gate];
        const enabled = Boolean(record?.required);
        return (
          <SwitchControl
            checked={enabled}
            className="sidebar-switch"
            disabled={busy || !state}
            key={gate}
            label={getGateReviewGateLabel(gate)}
            title={record?.status ? `status: ${record.status}` : undefined}
            onChange={(checked) => onGateEnabledChange(gate, checked)}
          />
        );
      })}
    </div>
  );
}

function getGateReviewGateLabel(gate: GateReviewGate): string {
  switch (gate) {
    case "architecture-plan":
      return "Architecture plan";
    case "validation-adequacy":
      return "Validation adequacy";
    case "final-diff":
      return "Final diff";
  }
  return gate;
}

function GatewayPanel({
  busy,
  onEnabledChange,
  onResetBinding,
  onStartQrLogin,
  onTranslationChange,
  qrCheck,
  qrLogin,
  status
}: {
  busy?: boolean;
  onEnabledChange(enabled: boolean): void;
  onResetBinding(): void;
  onStartQrLogin(): void;
  onTranslationChange(enabled: boolean): void;
  qrCheck: CheckGatewayQrLoginResult | null;
  qrLogin: StartGatewayQrLoginResult | null;
  status: GatewayStatus | null;
}) {
  const canEnable = Boolean(status?.binding.tokenConfigured);
  const isBound = Boolean(status?.binding.tokenConfigured);

  return (
    <div className="gateway-panel">
      <div className="gateway-actions">
        <SwitchControl
          checked={Boolean(status?.enabled)}
          className="sidebar-switch"
          disabled={busy || !status || (!status.enabled && !canEnable)}
          label="Gateway"
          title={canEnable ? "Enable or disable PM messages and task-changing Gateway commands" : "Scan and confirm iLink login first"}
          onChange={(checked) => onEnabledChange(checked)}
        />
        <SwitchControl
          checked={Boolean(status?.translationEnabled)}
          className="sidebar-switch"
          disabled={busy || !status}
          label="Translation"
          onChange={(checked) => onTranslationChange(checked)}
        />
        {isBound ? (
          <button className="danger-button" type="button" disabled={busy} onClick={onResetBinding}>
            Reset Binding
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={onStartQrLogin}>Start QR Login</button>
        )}
      </div>

      {qrLogin ? (
        <p className="muted">QR login started. Use the login dialog to confirm binding.</p>
      ) : null}
      {qrCheck ? (
        <p className="muted">
          QR status: {qrCheck.status}{qrCheck.message ? ` · ${qrCheck.message}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function ConnectedRepositoryPanel({
  busy,
  onPull,
  project
}: {
  busy?: boolean;
  onPull(): Promise<void>;
  project: ProjectSummary;
}) {
  const pullDisabledReason = project.pullDisabledReason;
  const canPull = Boolean(project.canPull);

  return (
    <div className="project-summary">
      <dl>
        <div>
          <dt>Base path</dt>
          <dd>{project.repoRoot}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{formatBranchLabel(project)}</dd>
        </div>
        <div>
          <dt>Remote</dt>
          <dd>{project.upstreamBranch ?? "no upstream"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{formatBranchStatus(project)}</dd>
        </div>
        <div>
          <dt>Commit</dt>
          <dd>{project.shortHeadCommit ?? project.headCommit ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Working tree</dt>
          <dd>{project.isDirty ? "uncommitted changes" : "clean"}</dd>
        </div>
      </dl>
      <div className="connected-repo-actions">
        <button
          type="button"
          disabled={busy || !canPull}
          title={pullDisabledReason ?? "Pull latest changes with git pull --ff-only"}
          onClick={() => void onPull()}
        >
          Pull
        </button>
        <span className="muted">
          {project.checkedAt ? `checked ${formatTime(project.checkedAt)}` : "status not refreshed"}
        </span>
      </div>
      {pullDisabledReason ? <p className="muted">{pullDisabledReason}</p> : null}
      {project.warnings.length > 0 ? (
        <ul className="warnings">
          {project.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatBranchLabel(project: ProjectSummary): string {
  return project.branch || "unknown";
}

function formatBranchStatus(project: ProjectSummary): string {
  if (!project.upstreamBranch) {
    return "no upstream";
  }
  const ahead = project.ahead ?? 0;
  const behind = project.behind ?? 0;
  if (ahead === 0 && behind === 0) {
    return "up to date";
  }
  if (ahead > 0 && behind > 0) {
    return `ahead ${ahead}, behind ${behind}`;
  }
  if (ahead > 0) {
    return `ahead ${ahead}`;
  }
  return `behind ${behind}`;
}

function SessionStatusDock({
  roundState,
  task
}: {
  roundState: VcmSessionRoundState | null;
  task: TaskRecord;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const showRound = Boolean(roundState?.startedAt);
  const sessionElapsedMs = getElapsedMs(task.createdAt, nowMs);
  const totalCcActiveMs = getLiveCcActiveMs(roundState, roundState?.totalCcActiveMs ?? 0, nowMs);
  const currentRoundCcActiveMs = showRound && roundState
    ? getLiveCcActiveMs(roundState, roundState.currentRoundCcActiveMs, nowMs)
    : 0;
  const currentRoundElapsedMs = showRound && roundState
    ? getRoundElapsedMs(roundState, nowMs)
    : 0;
  const sessionTitle = task.title?.trim() || task.taskSlug;

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="task-status-dock" aria-label="VCM Session status">
      <div className="task-status-dock-title">
        <strong title={sessionTitle}>{sessionTitle}</strong>
        <span className={`status-badge status-${task.status}`}>{task.status}</span>
      </div>

      <dl className="task-status-stats">
        <div>
          <dt>Session start</dt>
          <dd>{formatTime(task.createdAt)}</dd>
        </div>
        <div>
          <dt>Session total</dt>
          <dd>{formatDuration(sessionElapsedMs)}</dd>
        </div>
        <div>
          <dt>Rounds</dt>
          <dd>{roundState?.totalRoundCount ?? 0}</dd>
        </div>
        <div>
          <dt>Role runtime</dt>
          <dd>{formatDuration(totalCcActiveMs)}</dd>
        </div>
      </dl>

      {showRound && roundState ? (
        <div className="current-round-status">
          <div className="current-round-title">
            <span>{roundState.status === "running" ? "Current Round" : "Last Round"}</span>
            <span className={`status-badge status-${roundState.status}`}>{roundState.status}</span>
          </div>
          <dl className="task-status-stats">
            <div>
              <dt>Started</dt>
              <dd>{formatTime(roundState.startedAt)}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{formatDuration(currentRoundElapsedMs)}</dd>
            </div>
            <div>
              <dt>Role runtime</dt>
              <dd>{formatDuration(currentRoundCcActiveMs)}</dd>
            </div>
            <div>
              <dt>Turn count</dt>
              <dd>{roundState.turnCount}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </section>
  );
}

function getLiveCcActiveMs(
  roundState: VcmSessionRoundState | null,
  baseMs: number,
  nowMs: number
): number {
  if (!roundState?.activeTurnStartedAt || roundState.status !== "running") {
    return baseMs;
  }
  const updatedAtMs = Date.parse(roundState.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return baseMs;
  }
  return baseMs + Math.max(0, nowMs - updatedAtMs);
}

function getRoundElapsedMs(roundState: VcmSessionRoundState, nowMs: number): number {
  const endMs = roundState.status === "running"
    ? nowMs
    : Date.parse(roundState.stoppedAt ?? roundState.lastTurnEndedAt ?? "");
  return getElapsedMs(roundState.startedAt ?? "", Number.isFinite(endMs) ? endMs : nowMs);
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
  onOpenChange,
  open,
  title
}: {
  children: ReactNode;
  onOpenChange?(open: boolean): void;
  open: boolean;
  title: string;
}) {
  return (
    <section className="sidebar-section">
      <button
        aria-expanded={open}
        className="sidebar-section-toggle"
        type="button"
        onClick={() => {
          onOpenChange?.(!open);
        }}
      >
        <span>{title}</span>
        <span aria-hidden="true" className="sidebar-section-chevron" />
      </button>
      {open ? <div className="sidebar-section-content">{children}</div> : null}
    </section>
  );
}
