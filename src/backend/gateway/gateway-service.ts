import { readFile } from "node:fs/promises";
import { VCM_ROLE_DEFINITIONS } from "../../shared/constants.js";
import type {
  GatewayDiagnostics
} from "../../shared/types/diagnostics.js";
import type {
  CheckGatewayQrLoginRequest,
  CheckGatewayQrLoginResult,
  GatewayStatus,
  StartGatewayQrLoginResult,
  UpdateGatewaySettingsRequest
} from "../../shared/types/gateway.js";
import type { ProjectSummary } from "../../shared/types/project.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { VcmError } from "../errors.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { MessageService } from "../services/message-service.js";
import type { ProjectService } from "../services/project-service.js";
import type { RoundService } from "../services/round-service.js";
import type { SessionService } from "../services/session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";
import type { TranslationService } from "../services/translation-service.js";
import type { AppSettingsService } from "../services/app-settings-service.js";
import {
  parseAssistantContent,
  resolveExistingClaudeTranscriptPath
} from "../services/claude-transcript-service.js";
import { parseGatewayCommand, type GatewayCommand } from "./gateway-command-parser.js";
import type { GatewayAuditLog } from "./gateway-audit-log.js";
import type {
  WeixinIlinkAccount,
  WeixinIlinkChannel,
  WeixinIlinkUpdate
} from "./channels/weixin-ilink-channel.js";
import type {
  GatewayLatestPmReply,
  GatewaySettingsFile,
  GatewaySettingsService
} from "./gateway-settings-service.js";

export interface GatewayService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<GatewayStatus>;
  updateSettings(input: UpdateGatewaySettingsRequest): Promise<GatewayStatus>;
  resetBinding(): Promise<GatewayStatus>;
  startQrLogin(): Promise<StartGatewayQrLoginResult>;
  checkQrLogin(input?: CheckGatewayQrLoginRequest): Promise<CheckGatewayQrLoginResult>;
  handlePmStop(input: GatewayPmStopInput): Promise<void>;
  getDiagnostics(): GatewayDiagnostics;
}

export interface GatewayPmStopInput {
  repoRoot: string;
  taskSlug: string;
  session: RoleSessionRecord;
}

export interface GatewayServiceDeps {
  fs: FileSystemAdapter;
  settings: GatewaySettingsService;
  audit: GatewayAuditLog;
  channel: WeixinIlinkChannel;
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: Pick<SessionService, "getRoleSession" | "listRoleSessions" | "startRoleSession" | "stopRoleSession">;
  messageService: Pick<MessageService, "updateOrchestrationState">;
  translationService: Pick<TranslationService, "translateUserInput" | "translateGatewayOutput" | "stopTask">;
  roundService: Pick<RoundService, "stopTask">;
  runtime: Pick<TerminalRuntime, "write">;
  appSettings: Pick<AppSettingsService, "getPreferences" | "updatePreferences">;
  now?: () => string;
}

interface QrLoginState {
  qrcode: string;
  qrcodeUrl: string;
  baseUrl: string;
  expiresAt: string;
}

interface TranscriptTextEvent {
  id: string;
  timestamp: string;
  text: string;
}

interface LatestPmReplyCandidate {
  transcriptEventId: string | null;
  transcriptTimestamp: string | null;
  text: string;
  truncated: boolean;
}

interface LastFailedGatewayTranslation {
  repoRoot: string;
  taskSlug: string;
  role: "project-manager";
  sourceText: string;
  failedAt: string;
  error: string;
  retryCount: number;
}

interface GatewayOutputRenderResult {
  text: string;
  translationFailed: boolean;
  translationError?: string;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const QR_LOGIN_TTL_MS = 8 * 60 * 1000;
const CLOSE_CONFIRM_TTL_MS = 10 * 60 * 1000;
const POLL_ERROR_BACKOFF_MS = 2_000;
const POLL_LONG_BACKOFF_MS = 30_000;
const MAX_FAILURES_BEFORE_LONG_BACKOFF = 3;
const DEFAULT_POLL_TIMEOUT_MS = 35_000;
const MAX_LATEST_PM_REPLY_CHARS = 8_000;
const GATEWAY_TRANSLATION_FAILURE_TEXT = "PM 回复已收到，但翻译失败。\n发送 /retry 重新翻译。";
const COMMANDS_ALLOWED_WHEN_DISABLED = new Set<GatewayCommand["kind"]>([
  "help",
  "start",
  "status",
  "projects",
  "tasks"
]);

export function createGatewayService(deps: GatewayServiceDeps): GatewayService {
  const now = deps.now ?? (() => new Date().toISOString());
  let pollAbort: AbortController | null = null;
  let pollLoopPromise: Promise<void> | null = null;
  let pollStartingPromise: Promise<void> | null = null;
  let qrLogin: QrLoginState | null = null;
  let lastFailedTranslation: LastFailedGatewayTranslation | null = null;

  function isRunning(): boolean {
    return Boolean(pollAbort && !pollAbort.signal.aborted);
  }

  async function ensurePolling(): Promise<void> {
    if (isRunning()) {
      return;
    }
    if (pollStartingPromise) {
      await pollStartingPromise;
      return;
    }

    pollStartingPromise = (async () => {
      const settings = await deps.settings.loadSettings();
      if (!settings.binding.token || isRunning()) {
        return;
      }
      const controller = new AbortController();
      pollAbort = controller;
      const loop = pollLoop(controller.signal).finally(() => {
        if (pollAbort === controller) {
          pollAbort = null;
        }
        if (pollLoopPromise === loop) {
          pollLoopPromise = null;
        }
      });
      pollLoopPromise = loop;
    })().finally(() => {
      pollStartingPromise = null;
    });

    await pollStartingPromise;
  }

  async function stopPolling(): Promise<void> {
    await pollStartingPromise?.catch(() => undefined);
    if (!pollAbort) {
      return;
    }
    const controller = pollAbort;
    controller.abort();
    await pollLoopPromise?.catch(() => undefined);
    if (pollAbort === controller) {
      pollAbort = null;
    }
  }

  function toAccount(settings: GatewaySettingsFile): WeixinIlinkAccount | undefined {
    if (!settings.binding.token) {
      return undefined;
    }
    return {
      accountId: settings.binding.accountId,
      baseUrl: settings.binding.baseUrl || DEFAULT_BASE_URL,
      token: settings.binding.token
    };
  }

  async function pollLoop(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    let timeoutMs = DEFAULT_POLL_TIMEOUT_MS;
    await savePollStatus("running");

    while (!signal.aborted) {
      const settings = await deps.settings.loadSettings();
      const account = toAccount(settings);
      if (!account) {
        await savePollStatus("idle");
        return;
      }

      try {
        const result = await deps.channel.getUpdates({
          account,
          cursor: settings.binding.getUpdatesBuf,
          timeoutMs,
          signal
        });
        consecutiveFailures = 0;
        timeoutMs = result.timeoutMs ?? timeoutMs;
        const nextSettings = await deps.settings.loadSettings();
        await deps.settings.saveSettings({
          ...nextSettings,
          binding: {
            ...nextSettings.binding,
            getUpdatesBuf: result.cursor
          },
          lastPollStatus: {
            state: "running",
            checkedAt: now()
          },
          updatedAt: now()
        });

        for (const update of result.updates) {
          if (signal.aborted) {
            return;
          }
          await handleInbound(update).catch(() => undefined);
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        consecutiveFailures += 1;
        const message = errorMessage(error);
        const expired = message.toLowerCase().includes("expired");
        const settingsAfterError = await deps.settings.loadSettings();
        await deps.settings.saveSettings({
          ...settingsAfterError,
          enabled: expired ? false : settingsAfterError.enabled,
          binding: expired
            ? {
                ...settingsAfterError.binding,
                token: null,
                getUpdatesBuf: ""
              }
            : settingsAfterError.binding,
          lastPollStatus: {
            state: expired ? "expired" : "error",
            checkedAt: now(),
            error: message
          },
          updatedAt: now()
        });
        await deps.audit.record({
          type: "gateway.poll",
          result: "error",
          error: message
        });
        if (expired) {
          return;
        }
        await sleep(consecutiveFailures >= MAX_FAILURES_BEFORE_LONG_BACKOFF ? POLL_LONG_BACKOFF_MS : POLL_ERROR_BACKOFF_MS, signal);
        if (consecutiveFailures >= MAX_FAILURES_BEFORE_LONG_BACKOFF) {
          consecutiveFailures = 0;
        }
      }
    }
  }

  async function savePollStatus(state: GatewaySettingsFile["lastPollStatus"]["state"], error?: string): Promise<void> {
    const settings = await deps.settings.loadSettings();
    await deps.settings.saveSettings({
      ...settings,
      lastPollStatus: {
        state,
        checkedAt: now(),
        error
      },
      updatedAt: now()
    });
  }

  async function handleInbound(update: WeixinIlinkUpdate): Promise<void> {
    let settings = await deps.settings.loadSettings();
    if (settings.dedupe.recentInboundMessageIds.includes(update.messageId)) {
      await deps.audit.record({
        type: "gateway.inbound",
        result: "ignored",
        messageId: update.messageId,
        userId: update.fromUserId,
        preview: update.text
      });
      return;
    }

    settings = await deps.settings.saveSettings({
      ...settings,
      binding: {
        ...settings.binding,
        boundUserId: settings.binding.boundUserId ?? update.fromUserId,
        contextTokens: update.contextToken
          ? {
              ...settings.binding.contextTokens,
              [update.fromUserId]: update.contextToken
            }
          : settings.binding.contextTokens
      },
      dedupe: {
        recentInboundMessageIds: [...settings.dedupe.recentInboundMessageIds, update.messageId].slice(-1000)
      },
      updatedAt: now()
    });

    if (settings.binding.boundUserId !== update.fromUserId) {
      await reply(settings, update.fromUserId, "This VCM gateway is already bound to another Weixin DM.");
      await recordMessageStatus("inbound", "ignored", update.text, "unbound user");
      return;
    }

    const command = parseGatewayCommand(update.text);
    try {
      const output = await executeCommand(command, settings);
      await reply(await deps.settings.loadSettings(), update.fromUserId, output);
      await recordMessageStatus("inbound", "ok", update.text, undefined, command.kind);
      await deps.audit.record({
        type: "gateway.command",
        result: "ok",
        messageId: update.messageId,
        userId: update.fromUserId,
        command: command.kind,
        preview: update.text
      });
    } catch (error) {
      const message = errorMessage(error);
      await reply(await deps.settings.loadSettings(), update.fromUserId, `Error: ${message}`);
      await recordMessageStatus("inbound", "error", update.text, message, command.kind);
      await deps.audit.record({
        type: "gateway.command",
        result: "error",
        messageId: update.messageId,
        userId: update.fromUserId,
        command: command.kind,
        preview: update.text,
        error: message
      });
    }
  }

  async function executeCommand(command: GatewayCommand, settings: GatewaySettingsFile): Promise<string> {
    if (!settings.enabled && !COMMANDS_ALLOWED_WHEN_DISABLED.has(command.kind)) {
      return [
        "Gateway is connected but off.",
        "Available commands while off: /help, /start, /status, /projects, /tasks.",
        "Turn Gateway on in desktop VCM to send PM messages or run task-changing commands."
      ].join("\n");
    }

    switch (command.kind) {
      case "help":
        return helpText(settings.enabled);
      case "start":
        return startGateway();
      case "retry":
        return retryFailedTranslation();
      case "status":
        return statusText(await deps.settings.loadSettings());
      case "projects":
        return projectsText(await listProjectOptions());
      case "use-project":
        return useProject(command.selector);
      case "pull-current":
        return pullCurrent();
      case "tasks":
        return tasksText(await ensureProject());
      case "use-task":
        return useTask(command.selector);
      case "create-task":
        return createTask(command.taskSlug, command.title);
      case "close-task":
        return closeTaskPrompt();
      case "close-task-confirm":
        return closeTaskConfirm(command.taskSlug);
      case "translate":
        return setGatewayTranslation(command.enabled);
      case "plain":
        return sendPlainTextToPm(command.text);
      case "unknown":
        return `Unknown command: ${command.name}. Send /help for available commands.`;
    }
  }

  async function ensureProject(): Promise<ProjectSummary> {
    const settings = await deps.settings.loadSettings();
    let project = await deps.projectService.getCurrentProject();
    if (!project && settings.currentProjectId) {
      project = await deps.projectService.connectProject({ repoPath: settings.currentProjectId });
    }
    if (!project) {
      throw new VcmError({
        code: "PROJECT_NOT_CONNECTED",
        message: "No project is selected. Use /projects and /use-project first.",
        statusCode: 409
      });
    }
    if (settings.currentProjectId !== project.repoRoot) {
      await deps.settings.saveSettings({
        ...settings,
        currentProjectId: project.repoRoot,
        updatedAt: now()
      });
    }
    return project;
  }

  async function syncDesktopContext(settings: GatewaySettingsFile): Promise<GatewaySettingsFile> {
    const project = await deps.projectService.getCurrentProject();
    if (!project) {
      return settings;
    }

    const tasks = await deps.taskService.listTasks(project.repoRoot);
    const usableTasks = tasks.filter((task) => task.cleanupStatus !== "cleaned");
    const selectedTask = settings.currentTaskSlug
      ? usableTasks.find((task) => task.taskSlug === settings.currentTaskSlug) ?? usableTasks[0]
      : usableTasks[0];
    const nextTaskSlug = selectedTask?.taskSlug ?? null;

    if (settings.currentProjectId === project.repoRoot && settings.currentTaskSlug === nextTaskSlug) {
      return settings;
    }

    return deps.settings.saveSettings({
      ...settings,
      currentProjectId: project.repoRoot,
      currentTaskSlug: nextTaskSlug,
      updatedAt: now()
    });
  }

  async function listProjectOptions(): Promise<string[]> {
    const project = await deps.projectService.getCurrentProject();
    const recent = await deps.projectService.getRecentRepositoryPaths();
    const paths = [project?.repoRoot, ...recent].filter((value): value is string => Boolean(value));
    return [...new Set(paths)];
  }

  async function useProject(selector: string): Promise<string> {
    const options = await listProjectOptions();
    const index = Number.parseInt(selector, 10);
    const repoPath = Number.isFinite(index) && String(index) === selector.trim()
      ? options[index - 1]
      : selector.trim();
    if (!repoPath) {
      throw new VcmError({
        code: "PROJECT_SELECTION_INVALID",
        message: `Project not found: ${selector}`,
        statusCode: 404
      });
    }
    const project = await deps.projectService.connectProject({ repoPath });
    const settings = await deps.settings.loadSettings();
    await deps.settings.saveSettings({
      ...settings,
      currentProjectId: project.repoRoot,
      currentTaskSlug: null,
      updatedAt: now()
    });
    return `Selected project:\n${project.repoRoot}\nbranch: ${project.branch}\ncommit: ${project.shortHeadCommit ?? project.headCommit ?? "unknown"}`;
  }

  async function pullCurrent(): Promise<string> {
    const project = await ensureProject();
    const settings = await syncDesktopContext(await deps.settings.loadSettings());
    if (settings.currentTaskSlug) {
      const task = await deps.taskService.loadTask(project.repoRoot, settings.currentTaskSlug);
      if (!task.worktreePath && task.cleanupStatus !== "cleaned") {
        throw new VcmError({
          code: "GATEWAY_PULL_BLOCKED_BY_INLINE_TASK",
          message: `Inline task "${task.taskSlug}" uses the base repository.`,
          statusCode: 409
        });
      }
    }
    const pulled = await deps.projectService.pullCurrentProject();
    return [
      "Connected repository updated.",
      `branch: ${pulled.branch}`,
      `remote: ${pulled.upstreamBranch ?? "no upstream"}`,
      `status: ${formatAheadBehind(pulled)}`,
      `commit: ${pulled.shortHeadCommit ?? pulled.headCommit ?? "unknown"}`
    ].join("\n");
  }

  async function tasksText(project: ProjectSummary): Promise<string> {
    const tasks = await deps.taskService.listTasks(project.repoRoot);
    if (tasks.length === 0) {
      return "No tasks. Use /create-task <task-slug> [title] to create one.";
    }
    return tasks.map((task, index) => `${index + 1}. ${task.taskSlug} [${task.status}] ${task.worktreePath ? "worktree" : "inline"}`).join("\n");
  }

  async function useTask(selector: string): Promise<string> {
    const project = await ensureProject();
    const tasks = await deps.taskService.listTasks(project.repoRoot);
    const index = Number.parseInt(selector, 10);
    const task = Number.isFinite(index) && String(index) === selector.trim()
      ? tasks[index - 1]
      : tasks.find((candidate) => candidate.taskSlug === selector.trim());
    if (!task) {
      throw new VcmError({
        code: "TASK_NOT_FOUND",
        message: `Task not found: ${selector}`,
        statusCode: 404
      });
    }
    const settings = await deps.settings.loadSettings();
    await deps.settings.saveSettings({
      ...settings,
      currentTaskSlug: task.taskSlug,
      updatedAt: now()
    });
    return `Selected task: ${task.taskSlug}\nstatus: ${task.status}\nbranch: ${task.branch}`;
  }

  async function createTask(taskSlug: string, title?: string): Promise<string> {
    const project = await ensureProject();
    const task = await deps.taskService.createTask(project.repoRoot, {
      taskSlug,
      title,
      createWorktree: true
    });
    const config = await deps.projectService.loadConfig(project.repoRoot);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    const preferences = await deps.appSettings.getPreferences();
    const template = preferences.launchTemplate;

    await deps.messageService.updateOrchestrationState({
      repoRoot: project.repoRoot,
      stateRepoRoot: taskRepoRoot,
      stateRoot: config.stateRoot,
      taskSlug: task.taskSlug,
      mode: template.autoOrchestration ? "auto" : "manual"
    });

    const startedRoles: string[] = [];
    for (const definition of VCM_ROLE_DEFINITIONS) {
      const roleTemplate = template.roles[definition.name];
      try {
        await deps.sessionService.startRoleSession(project.repoRoot, task.taskSlug, definition.name, {
          cols: 100,
          rows: 28,
          permissionMode: roleTemplate.permissionMode,
          model: roleTemplate.model,
          effort: roleTemplate.effort
        });
        startedRoles.push(definition.name);
      } catch (error) {
        const settings = await deps.settings.loadSettings();
        await deps.settings.saveSettings({
          ...settings,
          currentProjectId: project.repoRoot,
          currentTaskSlug: task.taskSlug,
          translationEnabled: preferences.translationEnabled,
          updatedAt: now()
        });
        throw new VcmError({
          code: "GATEWAY_TASK_PARTIAL_START",
          message: `Task was created, but ${definition.name} failed to start.`,
          statusCode: 409,
          hint: errorMessage(error)
        });
      }
    }

    const settings = await deps.settings.loadSettings();
    await deps.settings.saveSettings({
      ...settings,
      currentProjectId: project.repoRoot,
      currentTaskSlug: task.taskSlug,
      translationEnabled: preferences.translationEnabled,
      updatedAt: now()
    });

    return [
      `Task created and initialized: ${task.taskSlug}`,
      `branch: ${task.branch}`,
      `worktree: ${task.worktreePath ?? task.repoRoot}`,
      `orchestration: ${template.autoOrchestration ? "auto" : "manual"}`,
      `translation: ${preferences.translationEnabled ? "on" : "off"}`,
      `sessions: ${startedRoles.join(", ")}`
    ].join("\n");
  }

  async function closeTaskPrompt(): Promise<string> {
    const project = await ensureProject();
    const settings = await syncDesktopContext(await deps.settings.loadSettings());
    const taskSlug = settings.currentTaskSlug;
    if (!taskSlug) {
      throw new VcmError({
        code: "TASK_NOT_SELECTED",
        message: "No task is selected. Use /tasks and /use-task first.",
        statusCode: 409
      });
    }
    await deps.taskService.loadTask(project.repoRoot, taskSlug);
    const createdAt = now();
    const expiresAt = new Date(Date.parse(createdAt) + CLOSE_CONFIRM_TTL_MS).toISOString();
    await deps.settings.saveSettings({
      ...settings,
      pendingConfirmations: {
        ...settings.pendingConfirmations,
        closeTask: {
          taskSlug,
          createdAt,
          expiresAt
        }
      },
      updatedAt: now()
    });
    return [
      `Close task "${taskSlug}"?`,
      "This stops VCM-managed role sessions and removes the task worktree/branch when owned by the task.",
      `Confirm with: /close-task confirm ${taskSlug}`
    ].join("\n");
  }

  async function closeTaskConfirm(taskSlug: string): Promise<string> {
    const project = await ensureProject();
    const settings = await deps.settings.loadSettings();
    const confirmation = settings.pendingConfirmations.closeTask;
    if (!confirmation || confirmation.taskSlug !== taskSlug || Date.parse(confirmation.expiresAt) < Date.now()) {
      throw new VcmError({
        code: "GATEWAY_CLOSE_CONFIRMATION_INVALID",
        message: `No active close confirmation for ${taskSlug}. Run /close-task first.`,
        statusCode: 409
      });
    }
    if (settings.currentTaskSlug !== taskSlug) {
      throw new VcmError({
        code: "GATEWAY_CLOSE_TASK_MISMATCH",
        message: `Current task is ${settings.currentTaskSlug ?? "not selected"}.`,
        statusCode: 409,
        hint: settings.currentTaskSlug ? `Use /close-task confirm ${settings.currentTaskSlug}` : undefined
      });
    }

    const task = await deps.taskService.loadTask(project.repoRoot, taskSlug);
    await stopRunningRoleSessions(project.repoRoot, taskSlug);
    await deps.translationService.stopTask(getTaskRuntimeRepoRoot(task), taskSlug, { clearCache: true });
    deps.roundService.stopTask(taskSlug);
    const result = await deps.taskService.cleanupTask(project.repoRoot, taskSlug, {
      force: true,
      deleteBranch: Boolean(task.worktreePath),
      forceDeleteBranch: true
    });
    clearFailedTranslation(project.repoRoot, taskSlug);
    const latestPmReplies = { ...settings.latestPmReplies };
    delete latestPmReplies[latestPmReplyKey(project.repoRoot, taskSlug)];
    await deps.settings.saveSettings({
      ...settings,
      currentTaskSlug: null,
      latestPmReplies,
      pendingConfirmations: {
        ...settings.pendingConfirmations,
        closeTask: null
      },
      updatedAt: now()
    });
    return [
      `Closed task: ${result.taskSlug}`,
      result.removedWorktreePath ? `removed worktree: ${result.removedWorktreePath}` : "removed worktree: none",
      result.deletedBranch ? `deleted branch: ${result.deletedBranch}` : "deleted branch: none",
      `removed state paths: ${result.removedStatePaths.length}`
    ].join("\n");
  }

  async function stopRunningRoleSessions(repoRoot: string, taskSlug: string): Promise<void> {
    const sessions = await deps.sessionService.listRoleSessions(repoRoot, taskSlug);
    for (const session of sessions) {
      if (session.status === "running") {
        await deps.sessionService.stopRoleSession(repoRoot, taskSlug, session.role);
      }
    }
  }

  async function setGatewayTranslation(enabled: boolean): Promise<string> {
    const settings = await deps.settings.updateSettings({ translationEnabled: enabled });
    return `Gateway translation ${settings.translationEnabled ? "on" : "off"}.`;
  }

  async function startGateway(): Promise<string> {
    const settings = await deps.settings.loadSettings();
    if (!settings.binding.token) {
      return "Gateway is not bound. Start QR login from desktop VCM first.";
    }
    if (settings.enabled) {
      return "Gateway is already on.";
    }
    const enabled = await syncDesktopContext(await deps.settings.updateSettings({ enabled: true }));
    await ensurePolling();
    await deps.appSettings.updatePreferences({ flowPauseAlerts: false });
    const lines = [
      "Gateway started.",
      "Full mobile commands and PM messages are now enabled.",
      `Project: ${enabled.currentProjectId ?? "none"}`,
      `Task: ${enabled.currentTaskSlug ?? "none"}`
    ];
    const latestReply = getLatestPmReply(enabled);
    if (latestReply) {
      const rendered = await renderLatestPmReply(enabled, latestReply);
      lines.push("", "Latest PM reply:", rendered.text);
    }
    return lines.join("\n");
  }

  async function sendPlainTextToPm(text: string): Promise<string> {
    if (!text.trim()) {
      return "Empty message ignored.";
    }
    const project = await ensureProject();
    const settings = await syncDesktopContext(await deps.settings.loadSettings());
    if (!settings.currentTaskSlug) {
      throw new VcmError({
        code: "TASK_NOT_SELECTED",
        message: "No task is selected. Use /tasks and /use-task first.",
        statusCode: 409
      });
    }
    const task = await deps.taskService.loadTask(project.repoRoot, settings.currentTaskSlug);
    const session = await deps.sessionService.getRoleSession(project.repoRoot, task.taskSlug, "project-manager");
    if (!session || session.status !== "running") {
      throw new VcmError({
        code: "PM_SESSION_NOT_RUNNING",
        message: "The current task's PM session is not running.",
        statusCode: 409
      });
    }
    if (session.activityStatus === "running") {
      return "PM is still working on the current turn. Please wait and send again later.";
    }

    const englishText = settings.translationEnabled
      ? (await deps.translationService.translateUserInput({
          repoRoot: project.repoRoot,
          taskRepoRoot: getTaskRuntimeRepoRoot(task),
          taskSlug: task.taskSlug,
          role: "project-manager",
          text,
          useContext: false,
          send: false
        })).englishPreview
      : text;

    await submitTerminalInput(deps.runtime, session.id, `[VCM Gateway]\n${englishText}`);
    return "Sent to PM.";
  }

  async function reply(settings: GatewaySettingsFile, userId: string, text: string): Promise<void> {
    const account = toAccount(settings);
    if (!account) {
      return;
    }
    const contextToken = settings.binding.contextTokens[userId];
    await deps.channel.sendText({
      account,
      toUserId: userId,
      contextToken,
      text
    });
    await recordMessageStatus("outbound", "ok", text);
  }

  async function recordMessageStatus(
    direction: "inbound" | "outbound",
    result: "ok" | "ignored" | "error",
    preview: string,
    error?: string,
    command?: string
  ): Promise<void> {
    const settings = await deps.settings.loadSettings();
    await deps.settings.saveSettings({
      ...settings,
      lastMessageStatus: {
        checkedAt: now(),
        direction,
        result,
        preview: preview.slice(0, 160),
        error,
        command
      },
      updatedAt: now()
    });
  }

  async function statusText(settings: GatewaySettingsFile): Promise<string> {
    const synced = await syncDesktopContext(settings);
    const project = await deps.projectService.getCurrentProject();
    return [
      `Gateway: ${synced.enabled ? "on" : "off"}${isRunning() ? " / polling" : ""}`,
      `Binding: ${synced.binding.boundUserId ? "bound" : "not bound"}`,
      `Translation: ${synced.translationEnabled ? "on" : "off"}`,
      `Project: ${project?.repoRoot ?? synced.currentProjectId ?? "none"}`,
      `Task: ${synced.currentTaskSlug ?? "none"}`,
      `Last poll: ${synced.lastPollStatus.state}${synced.lastPollStatus.error ? ` (${synced.lastPollStatus.error})` : ""}`
    ].join("\n");
  }

  return {
    async start() {
      await ensurePolling();
    },
    stop() {
      return stopPolling();
    },
    async getStatus() {
      const settings = await syncDesktopContext(await deps.settings.loadSettings());
      await ensurePolling();
      return deps.settings.expose(settings, isRunning());
    },
    async updateSettings(input) {
      let settings = await deps.settings.updateSettings(input);
      if (settings.enabled) {
        settings = await syncDesktopContext(settings);
      }
      if (settings.binding.token) {
        await ensurePolling();
      } else {
        await stopPolling();
      }
      return deps.settings.expose(settings, isRunning());
    },
    async resetBinding() {
      await stopPolling();
      lastFailedTranslation = null;
      const settings = await deps.settings.resetBinding();
      return deps.settings.expose(settings, isRunning());
    },
    async startQrLogin() {
      const settings = await deps.settings.loadSettings();
      const login = await deps.channel.startQrLogin({
        localTokenList: settings.binding.token ? [settings.binding.token] : []
      });
      qrLogin = {
        qrcode: login.qrcode,
        qrcodeUrl: login.qrcodeUrl,
        baseUrl: settings.binding.baseUrl || DEFAULT_BASE_URL,
        expiresAt: new Date(Date.now() + QR_LOGIN_TTL_MS).toISOString()
      };
      return {
        status: "wait",
        qrcode: login.qrcode,
        qrcodeUrl: login.qrcodeUrl,
        expiresAt: qrLogin.expiresAt
      };
    },
    async checkQrLogin(input: CheckGatewayQrLoginRequest = {}) {
      if (!qrLogin || Date.parse(qrLogin.expiresAt) < Date.now()) {
        return {
          status: "expired",
          message: "QR login expired. Start a new QR login."
        };
      }
      const result = await deps.channel.checkQrLogin({
        baseUrl: qrLogin.baseUrl,
        qrcode: qrLogin.qrcode,
        verifyCode: input.verifyCode
      });
      if (result.status === "scaned_but_redirect" && result.redirectHost) {
        qrLogin = {
          ...qrLogin,
          baseUrl: normalizeBaseUrl(result.redirectHost)
        };
      }
      if (result.status === "confirmed" || result.status === "binded_redirect") {
        const settings = await deps.settings.loadSettings();
        const token = result.token ?? settings.binding.token;
        if (token) {
          await deps.settings.saveSettings({
            ...settings,
            binding: {
              ...settings.binding,
              accountId: result.accountId ?? settings.binding.accountId,
              baseUrl: normalizeBaseUrl(result.baseUrl ?? settings.binding.baseUrl),
              loginUserId: result.loginUserId ?? settings.binding.loginUserId,
              boundUserId: result.loginUserId ?? settings.binding.boundUserId,
              token
            },
            updatedAt: now()
          });
          qrLogin = null;
          await ensurePolling();
        }
      }
      return {
        status: result.status,
        qrcodeUrl: qrLogin?.qrcodeUrl,
        accountId: result.accountId,
        boundUserId: result.loginUserId,
        loginUserId: result.loginUserId
      };
    },
    async handlePmStop(input) {
      if (input.session.role !== "project-manager") {
        return;
      }

      const transcriptPath = resolveExistingClaudeTranscriptPath(input.session);
      if (!transcriptPath) {
        return;
      }
      const events = await readTranscriptTextEvents(transcriptPath);
      const latestReply = selectLatestTurnReply(events, input.session);
      if (latestReply) {
        await saveLatestPmReply(input, latestReply);
      }

      const settings = await deps.settings.loadSettings();
      const account = toAccount(settings);
      const boundUserId = settings.binding.boundUserId;
      if (!settings.enabled || !account || !boundUserId) {
        return;
      }

      const cursorKey = `${input.taskSlug}:project-manager:${input.session.claudeSessionId}`;
      const cursor = settings.pushCursors[cursorKey];
      const nextEvents = selectEventsAfterCursor(events, cursor?.lastTranscriptEventId);
      if (nextEvents.length === 0) {
        return;
      }
      const text = nextEvents.map((event) => event.text).join("\n\n").trim();
      if (!text) {
        return;
      }

      const output = await renderGatewayPmOutput({
        settings,
        repoRoot: input.repoRoot,
        taskSlug: input.taskSlug,
        sourceText: text
      });

      await deps.channel.sendText({
        account,
        toUserId: boundUserId,
        contextToken: settings.binding.contextTokens[boundUserId],
        text: output.text
      });
      const lastEvent = nextEvents.at(-1);
      const current = await deps.settings.loadSettings();
      await deps.settings.saveSettings({
        ...current,
        pushCursors: {
          ...current.pushCursors,
          [cursorKey]: {
            lastTranscriptEventId: lastEvent?.id ?? null,
            lastTranscriptTimestamp: lastEvent?.timestamp ?? null
          }
        },
        lastMessageStatus: {
          checkedAt: now(),
          direction: "outbound",
          result: output.translationFailed ? "error" : "ok",
          command: "pm-stop",
          preview: output.text.slice(0, 160),
          error: output.translationError
        },
        updatedAt: now()
      });
      await deps.audit.record({
        type: "gateway.pm_push",
        result: output.translationFailed ? "error" : "ok",
        command: "pm-stop",
        preview: output.text,
        error: output.translationError
      });
    },
    getDiagnostics() {
      return {
        polling: isRunning()
      };
    }
  };

  function getLatestPmReply(settings: GatewaySettingsFile): GatewayLatestPmReply | undefined {
    if (!settings.currentProjectId || !settings.currentTaskSlug) {
      return undefined;
    }
    return settings.latestPmReplies[latestPmReplyKey(settings.currentProjectId, settings.currentTaskSlug)];
  }

  async function renderLatestPmReply(
    settings: GatewaySettingsFile,
    reply: GatewayLatestPmReply
  ): Promise<GatewayOutputRenderResult> {
    const rendered = await renderGatewayPmOutput({
      settings,
      repoRoot: reply.repoRoot,
      taskSlug: reply.taskSlug,
      sourceText: reply.text
    });
    return {
      ...rendered,
      text: reply.truncated && !rendered.translationFailed ? `${rendered.text}\n\n[truncated]` : rendered.text
    };
  }

  async function renderGatewayPmOutput(input: {
    settings: GatewaySettingsFile;
    repoRoot: string;
    taskSlug: string;
    sourceText: string;
  }): Promise<GatewayOutputRenderResult> {
    if (!input.settings.translationEnabled) {
      clearFailedTranslation(input.repoRoot, input.taskSlug);
      return {
        text: input.sourceText,
        translationFailed: false
      };
    }

    try {
      const text = await deps.translationService.translateGatewayOutput({
        repoRoot: input.repoRoot,
        taskSlug: input.taskSlug,
        role: "project-manager",
        text: input.sourceText
      });
      clearFailedTranslation(input.repoRoot, input.taskSlug);
      return {
        text,
        translationFailed: false
      };
    } catch (error) {
      const message = errorMessage(error);
      lastFailedTranslation = {
        repoRoot: input.repoRoot,
        taskSlug: input.taskSlug,
        role: "project-manager",
        sourceText: input.sourceText,
        failedAt: now(),
        error: message,
        retryCount: 0
      };
      return {
        text: GATEWAY_TRANSLATION_FAILURE_TEXT,
        translationFailed: true,
        translationError: message
      };
    }
  }

  async function retryFailedTranslation(): Promise<string> {
    if (!lastFailedTranslation) {
      return "没有可重试的翻译失败内容。";
    }

    const failed = lastFailedTranslation;
    try {
      const text = await deps.translationService.translateGatewayOutput({
        repoRoot: failed.repoRoot,
        taskSlug: failed.taskSlug,
        role: failed.role,
        text: failed.sourceText
      });
      lastFailedTranslation = null;
      return `重新翻译成功：\n\n${text}`;
    } catch (error) {
      lastFailedTranslation = {
        ...failed,
        failedAt: now(),
        error: errorMessage(error),
        retryCount: failed.retryCount + 1
      };
      return "重新翻译失败。\n稍后可继续发送 /retry。";
    }
  }

  function clearFailedTranslation(repoRoot: string, taskSlug: string): void {
    if (lastFailedTranslation?.repoRoot === repoRoot && lastFailedTranslation.taskSlug === taskSlug) {
      lastFailedTranslation = null;
    }
  }

  async function saveLatestPmReply(input: GatewayPmStopInput, reply: LatestPmReplyCandidate): Promise<void> {
    const settings = await deps.settings.loadSettings();
    const key = latestPmReplyKey(input.repoRoot, input.taskSlug);
    await deps.settings.saveSettings({
      ...settings,
      latestPmReplies: {
        ...settings.latestPmReplies,
        [key]: {
          repoRoot: input.repoRoot,
          taskSlug: input.taskSlug,
          sessionId: input.session.id,
          claudeSessionId: input.session.claudeSessionId,
          transcriptEventId: reply.transcriptEventId,
          transcriptTimestamp: reply.transcriptTimestamp,
          capturedAt: now(),
          text: reply.text,
          truncated: reply.truncated
        }
      },
      updatedAt: now()
    });
  }
}

async function readTranscriptTextEvents(transcriptPath: string): Promise<TranscriptTextEvent[]> {
  const raw = await readFile(transcriptPath, "utf8");
  const events: TranscriptTextEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    for (const event of parseAssistantContent(line)) {
      if (event.kind === "text") {
        events.push({
          id: event.id,
          timestamp: event.timestamp,
          text: event.text
        });
      }
    }
  }
  return events;
}

function selectEventsAfterCursor(events: TranscriptTextEvent[], cursorId: string | null | undefined): TranscriptTextEvent[] {
  if (events.length === 0) {
    return [];
  }
  if (!cursorId) {
    return [events[events.length - 1] as TranscriptTextEvent];
  }
  const index = events.findIndex((event) => event.id === cursorId);
  if (index < 0) {
    return [events[events.length - 1] as TranscriptTextEvent];
  }
  return events.slice(index + 1);
}

function selectLatestTurnReply(events: TranscriptTextEvent[], session: RoleSessionRecord): LatestPmReplyCandidate | undefined {
  if (events.length === 0) {
    return undefined;
  }

  const startMs = timestampMs(session.lastTurnStartedAt);
  const endMs = timestampMs(session.lastTurnEndedAt);
  const selected = startMs === undefined
    ? events.slice(-1)
    : events.filter((event) => {
        const eventMs = timestampMs(event.timestamp);
        return eventMs !== undefined
          && eventMs >= startMs - 1_000
          && (endMs === undefined || eventMs <= endMs + 1_000);
      });
  if (selected.length === 0) {
    return undefined;
  }

  const text = selected.map((event) => event.text).join("\n\n").trim();
  if (!text) {
    return undefined;
  }

  const limited = limitLatestPmReply(text);
  const lastEvent = selected.at(-1);
  return {
    transcriptEventId: lastEvent?.id ?? null,
    transcriptTimestamp: lastEvent?.timestamp ?? null,
    text: limited.text,
    truncated: limited.truncated
  };
}

function latestPmReplyKey(repoRoot: string, taskSlug: string): string {
  return JSON.stringify([repoRoot, taskSlug]);
}

function limitLatestPmReply(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_LATEST_PM_REPLY_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, MAX_LATEST_PM_REPLY_CHARS).trimEnd(),
    truncated: true
  };
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function projectsText(projects: string[]): string {
  if (projects.length === 0) {
    return "No recent projects. Connect a repository from desktop VCM first.";
  }
  return projects.map((repoPath, index) => `${index + 1}. ${repoPath}`).join("\n");
}

function helpText(enabled: boolean): string {
  if (!enabled) {
    return [
      "VCM Gateway is connected but off.",
      "Available commands:",
      "/help",
      "/start",
      "/status",
      "/projects",
      "/tasks",
      "Send /start to enable PM messages and task-changing commands."
    ].join("\n");
  }

  return [
    "VCM Gateway commands:",
    "/help",
    "/start",
    "/retry",
    "/status",
    "/projects",
    "/use-project <index-or-path>",
    "/pull-current",
    "/tasks",
    "/use-task <index-or-task-slug>",
    "/create-task <task-slug> [title]",
    "/close-task",
    "/close-task confirm <task-slug>",
    "/translate on",
    "/translate off"
  ].join("\n");
}

function formatAheadBehind(project: ProjectSummary): string {
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
  return ahead > 0 ? `ahead ${ahead}` : `behind ${behind}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/+$/, "");
  }
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof VcmError) {
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
