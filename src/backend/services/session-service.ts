import { randomUUID } from "node:crypto";
import path from "node:path";
import { ROLE_NAMES, isDispatchableRole } from "../../shared/constants.js";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import type { RoleName } from "../../shared/types/role.js";
import type {
  ClaudeModel,
  ClaudePermissionMode,
  CodexModel,
  RoleSessionRecord,
  SessionEffort,
  SessionModel,
  StartRoleSessionRequest,
  TaskSessionRecord
} from "../../shared/types/session.js";
import { VcmError } from "../errors.js";
import { resolveRepoPath } from "../adapters/filesystem.js";
import type { ClaudeAdapter } from "../adapters/claude-adapter.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { SessionRegistry } from "../runtime/session-registry.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import type { ArtifactService } from "./artifact-service.js";
import { claudeTranscriptPath } from "./claude-transcript-service.js";
import type { ProjectService } from "./project-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";

export interface SessionService {
  startRoleSession(repoRoot: string, taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  resumeRoleSession(repoRoot: string, taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  stopRoleSession(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord>;
  restartRoleSession(repoRoot: string, taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  getRoleSession(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord | undefined>;
  listRoleSessions(repoRoot: string, taskSlug: string): Promise<RoleSessionRecord[]>;
  recordRoleHookEvent(repoRoot: string, input: RecordRoleHookEventInput): Promise<RoleSessionRecord | undefined>;
  recordClaudeHookEvent(repoRoot: string, input: RecordClaudeHookEventInput): Promise<RoleSessionRecord | undefined>;
  markRoleActivityRunning(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord | undefined>;
  markRoleActivityIdle(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord | undefined>;
}

export interface SessionServiceDeps {
  fs: FileSystemAdapter;
  runtime: TerminalRuntime;
  registry: SessionRegistry;
  claude: ClaudeAdapter;
  artifactService: ArtifactService;
  projectService: Pick<ProjectService, "loadConfig">;
  taskService: Pick<TaskService, "loadTask">;
  apiUrl?: string;
  now?: () => string;
}

type LaunchMode = "fresh" | "resume";

const CODEX_REVIEWER_ROLE: RoleName = "codex-reviewer";
const CODEX_DIR = ".ai/codex";
const CODEX_REVIEW_DIR = ".ai/vcm/codex-reviews";
const CODEX_CONFIG_PATH = ".ai/codex/config.toml";

export interface RecordClaudeHookEventInput {
  taskSlug: string;
  role: RoleName;
  eventName: ClaudeHookEventName;
  claudeSessionId?: string;
  transcriptPath?: string;
  cwd?: string;
}

export interface RecordRoleHookEventInput {
  taskSlug: string;
  role: RoleName;
  eventName: ClaudeHookEventName;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  allowSessionMismatch?: boolean;
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const now = deps.now ?? (() => new Date().toISOString());

  async function launchRoleSession(
    repoRoot: string,
    taskSlug: string,
    role: RoleName,
    input: StartRoleSessionRequest,
    launchMode: LaunchMode
  ): Promise<RoleSessionRecord> {
    const live = deps.registry.getByRole(taskSlug, role);
    if (live && live.status === "running") {
      return live;
    }

    const config = await deps.projectService.loadConfig(repoRoot);
    const task = await deps.taskService.loadTask(repoRoot, taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    const paths = deps.artifactService.getHandoffPaths(taskRepoRoot, task.handoffDir);
    const persisted = await loadPersistedRoleRecord(deps.fs, taskRepoRoot, config.stateRoot, taskSlug, role);
    const isCodexReviewer = role === CODEX_REVIEWER_ROLE;
    const permissionMode = normalizeClaudePermissionMode(input.permissionMode ?? persisted?.permissionMode);
    const model: SessionModel = isCodexReviewer
      ? normalizeCodexModel(input.model ?? persisted?.model)
      : normalizeClaudeModel(input.model ?? persisted?.model);
    const effort = isCodexReviewer
      ? normalizeCodexEffort(input.effort ?? persisted?.effort)
      : normalizeClaudeEffort(input.effort ?? persisted?.effort);
    const claudeSessionId = launchMode === "resume"
      ? persisted?.claudeSessionId
      : randomUUID();

    if (!claudeSessionId) {
      throw new VcmError({
        code: "CLAUDE_SESSION_MISSING",
        message: `${role} does not have a session id to resume.`,
        statusCode: 409,
        hint: "Start the role once before using Resume."
      });
    }
    const transcriptPath = launchMode === "resume" && persisted?.transcriptPath
      ? persisted.transcriptPath
      : isCodexReviewer ? undefined : claudeTranscriptPath(taskRepoRoot, claudeSessionId);

    const startCommand = isCodexReviewer
      ? await buildCodexReviewerStartCommand(deps.fs, taskRepoRoot, launchMode, model as CodexModel, effort)
      : {
          ...deps.claude.buildRoleStartCommand(
            role,
            config.claudeCommand,
            permissionMode,
            claudeSessionId,
            launchMode === "resume",
            model as ClaudeModel,
            effort
          ),
          cwd: taskRepoRoot
        };
    const runtimeSession = await deps.runtime.createSession({
      taskSlug,
      role,
      command: startCommand.command,
      args: startCommand.args,
      cwd: startCommand.cwd,
      env: {
        VCM_API_URL: deps.apiUrl,
        VCM_TASK_REPO_ROOT: taskRepoRoot,
        VCM_TASK_SLUG: taskSlug,
        VCM_ROLE: role,
        VCM_SESSION_ID: claudeSessionId
      },
      cols: input.cols,
      rows: input.rows,
      logPath: resolveRepoPath(taskRepoRoot, paths.roleLogPaths[role])
    });
    const timestamp = now();
    const record: RoleSessionRecord = {
      id: runtimeSession.id,
      claudeSessionId,
      transcriptPath,
      taskSlug,
      role,
      status: runtimeSession.status,
      activityStatus: "idle",
      command: startCommand.display,
      permissionMode,
      model,
      effort,
      cwd: startCommand.cwd,
      terminalBackend: "node-pty",
      pid: runtimeSession.pid,
      logPath: paths.roleLogPaths[role],
      roleCommandPath: isDispatchableRole(role)
        ? paths.roleCommandPaths[role]
        : undefined,
      handoffArtifactPath: getHandoffArtifactPath(paths, role),
      startedAt: runtimeSession.startedAt,
      updatedAt: timestamp,
      lastOutputAt: runtimeSession.lastOutputAt,
      exitCode: runtimeSession.exitCode
    };

    deps.registry.upsert(record);
    await persistTaskSession(deps.fs, taskRepoRoot, config.stateRoot, record);
    return record;
  }

  return {
    startRoleSession(repoRoot, taskSlug, role, input = {}) {
      return launchRoleSession(repoRoot, taskSlug, role, input, "fresh");
    },
    resumeRoleSession(repoRoot, taskSlug, role, input = {}) {
      return launchRoleSession(repoRoot, taskSlug, role, input, "resume");
    },
    async stopRoleSession(repoRoot, taskSlug, role) {
      const existing = await this.getRoleSession(repoRoot, taskSlug, role);
      if (!existing) {
        throw new VcmError({
          code: "SESSION_MISSING",
          message: `${role} session has not been started.`,
          statusCode: 404
        });
      }

      if (deps.runtime.getSession(existing.id)) {
        await deps.runtime.stop(existing.id);
      }

      const updated: RoleSessionRecord = {
        ...existing,
        status: "exited",
        activityStatus: "idle",
        updatedAt: now()
      };
      deps.registry.upsert(updated);
      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, taskSlug);
      await persistTaskSession(deps.fs, getTaskRuntimeRepoRoot(task), config.stateRoot, updated);
      return updated;
    },
    async restartRoleSession(repoRoot, taskSlug, role, input = {}) {
      const existing = await this.getRoleSession(repoRoot, taskSlug, role);
      if (!existing) {
        return launchRoleSession(repoRoot, taskSlug, role, input, "fresh");
      }

      if (deps.runtime.getSession(existing.id)) {
        await deps.runtime.stop(existing.id);
      }
      deps.registry.remove(existing.id);

      return launchRoleSession(repoRoot, taskSlug, role, input, "fresh");
    },
    async getRoleSession(repoRoot, taskSlug, role) {
      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      const record = deps.registry.getByRole(taskSlug, role)
        ?? await loadPersistedRoleRecord(deps.fs, taskRepoRoot, config.stateRoot, taskSlug, role);
      if (!record) {
        return undefined;
      }

      const runtimeSession = deps.runtime.getSession(record.id);
      if (!runtimeSession) {
        return {
          ...record,
          status: getRecoverableStatus(record),
          pid: undefined,
          exitCode: record.exitCode ?? null
        };
      }

      return {
        ...record,
        status: runtimeSession.status,
        activityStatus: record.activityStatus ?? "idle",
        pid: runtimeSession.pid,
        lastOutputAt: runtimeSession.lastOutputAt,
        exitCode: runtimeSession.exitCode
      };
    },
    async listRoleSessions(repoRoot, taskSlug) {
      const sessions: RoleSessionRecord[] = [];
      for (const role of ROLE_NAMES) {
        const session = await this.getRoleSession(repoRoot, taskSlug, role);
        if (session) {
          sessions.push(session);
        }
      }
      return sessions;
    },
    async recordRoleHookEvent(repoRoot, input) {
      const current = await this.getRoleSession(repoRoot, input.taskSlug, input.role);
      if (!current || (!input.allowSessionMismatch && !matchesRoleHookSession(current, input))) {
        return undefined;
      }

      const timestamp = now();
      const isStop = input.eventName === "Stop";
      const updated: RoleSessionRecord = {
        ...current,
        claudeSessionId: input.sessionId ?? current.claudeSessionId,
        transcriptPath: input.transcriptPath ?? current.transcriptPath,
        cwd: input.cwd ?? current.cwd,
        activityStatus: isStop ? "idle" : "running",
        lastHookEventAt: timestamp,
        lastTurnEndedAt: isStop ? timestamp : current.lastTurnEndedAt,
        lastTurnStartedAt: isStop ? current.lastTurnStartedAt : timestamp,
        updatedAt: timestamp
      };
      deps.registry.upsert(updated);

      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, input.taskSlug);
      await persistTaskSession(deps.fs, getTaskRuntimeRepoRoot(task), config.stateRoot, updated);
      return updated;
    },
    recordClaudeHookEvent(repoRoot, input) {
      return this.recordRoleHookEvent(repoRoot, {
        taskSlug: input.taskSlug,
        role: input.role,
        eventName: input.eventName,
        sessionId: input.claudeSessionId,
        transcriptPath: input.transcriptPath,
        cwd: input.cwd
      });
    },
    async markRoleActivityRunning(repoRoot, taskSlug, role) {
      const current = await this.getRoleSession(repoRoot, taskSlug, role);
      if (!current) {
        return undefined;
      }

      const timestamp = now();
      const updated: RoleSessionRecord = {
        ...current,
        activityStatus: "running",
        lastTurnStartedAt: timestamp,
        lastHookEventAt: timestamp,
        updatedAt: timestamp
      };
      deps.registry.upsert(updated);

      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, taskSlug);
      await persistTaskSession(deps.fs, getTaskRuntimeRepoRoot(task), config.stateRoot, updated);
      return updated;
    },
    async markRoleActivityIdle(repoRoot, taskSlug, role) {
      const current = await this.getRoleSession(repoRoot, taskSlug, role);
      if (!current) {
        return undefined;
      }

      const timestamp = now();
      const updated: RoleSessionRecord = {
        ...current,
        activityStatus: "idle",
        lastTurnEndedAt: timestamp,
        updatedAt: timestamp
      };
      deps.registry.upsert(updated);

      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, taskSlug);
      await persistTaskSession(deps.fs, getTaskRuntimeRepoRoot(task), config.stateRoot, updated);
      return updated;
    }
  };
}

async function buildCodexReviewerStartCommand(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  launchMode: LaunchMode,
  selectedModel: CodexModel,
  selectedEffort: SessionEffort
): Promise<{ command: string; args: string[]; display: string; cwd: string }> {
  const codexDir = resolveRepoPath(taskRepoRoot, CODEX_DIR);
  const reviewDir = resolveRepoPath(taskRepoRoot, CODEX_REVIEW_DIR);
  if (!(await fs.pathExists(codexDir))) {
    throw new VcmError({
      code: "CODEX_REVIEW_CONFIG_MISSING",
      message: `${CODEX_DIR} does not exist.`,
      statusCode: 409,
      hint: "Apply the VCM harness before starting Codex Reviewer."
    });
  }

  await fs.ensureDir(reviewDir);
  const config = await loadCodexSessionConfig(fs, taskRepoRoot);
  const args = launchMode === "resume"
    ? ["resume", "--last"]
    : [];
  args.push(
    "--cd",
    codexDir,
    "--add-dir",
    reviewDir,
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--dangerously-bypass-hook-trust",
    "--search"
  );
  if (selectedModel !== "default") {
    args.push("--model", selectedModel);
  }
  if (selectedEffort !== "default") {
    args.push("--config", `model_reasoning_effort="${selectedEffort}"`);
  }

  return {
    command: config.command,
    args,
    cwd: taskRepoRoot,
    display: [config.command, ...args].map(formatDisplayArg).join(" ")
  };
}

async function loadCodexSessionConfig(
  fs: FileSystemAdapter,
  taskRepoRoot: string
): Promise<{ command: string }> {
  const configPath = resolveRepoPath(taskRepoRoot, CODEX_CONFIG_PATH);
  if (!(await fs.pathExists(configPath))) {
    return {
      command: "codex"
    };
  }

  const content = await fs.readText(configPath);
  const reviewSection = extractTomlSection(content, "vcm.codex_review");
  return {
    command: parseTomlString(content, "command") ?? parseTomlString(reviewSection, "command") ?? "codex"
  };
}

function matchesRoleHookSession(record: RoleSessionRecord, input: RecordRoleHookEventInput): boolean {
  if (input.sessionId && record.claudeSessionId === input.sessionId) {
    return true;
  }
  if (input.transcriptPath && record.transcriptPath === input.transcriptPath) {
    return true;
  }
  if (!input.sessionId && !input.transcriptPath) {
    return true;
  }
  return false;
}

function getRecoverableStatus(record: RoleSessionRecord): RoleSessionRecord["status"] {
  if (!record.claudeSessionId) {
    return record.status === "running" ? "missing" : record.status;
  }

  if (record.status === "done") {
    return "done";
  }

  return "resumable";
}

function getHandoffArtifactPath(paths: ReturnType<ArtifactService["getHandoffPaths"]>, role: RoleName): string | undefined {
  if (role === "architect") {
    return paths.architecturePlanPath;
  }
  if (role === "reviewer") {
    return paths.reviewReportPath;
  }
  return undefined;
}

async function loadPersistedRoleRecord(
  fs: FileSystemAdapter,
  repoRoot: string,
  stateRoot: string,
  taskSlug: string,
  role: RoleName
): Promise<RoleSessionRecord | undefined> {
  const sessionPath = getTaskSessionPath(repoRoot, stateRoot, taskSlug);
  if (!(await fs.pathExists(sessionPath))) {
    return undefined;
  }

  const current = await fs.readJson<TaskSessionRecord>(sessionPath);
  const record = current.roles[role]?.record;
  const legacy = record as (RoleSessionRecord & {
    lastPromptSubmittedAt?: unknown;
    lastStopAt?: unknown;
  }) | undefined;
  return record
    ? {
        ...record,
        lastTurnStartedAt: record.lastTurnStartedAt ?? (
          typeof legacy?.lastPromptSubmittedAt === "string"
            ? legacy.lastPromptSubmittedAt
            : undefined
        ),
        lastTurnEndedAt: record.lastTurnEndedAt ?? (
          typeof legacy?.lastStopAt === "string"
            ? legacy.lastStopAt
            : undefined
        ),
        permissionMode: normalizeClaudePermissionMode(record.permissionMode),
        model: record.role === CODEX_REVIEWER_ROLE
          ? normalizeCodexModel(record.model)
          : normalizeClaudeModel(record.model),
        effort: record.role === CODEX_REVIEWER_ROLE
          ? normalizeCodexEffort(record.effort)
          : normalizeClaudeEffort(record.effort)
      }
    : undefined;
}

async function persistTaskSession(
  fs: FileSystemAdapter,
  repoRoot: string,
  stateRoot: string,
  session: RoleSessionRecord
): Promise<void> {
  const sessionPath = getTaskSessionPath(repoRoot, stateRoot, session.taskSlug);
  const empty = createEmptyTaskSessionRecord(session.taskSlug, session.updatedAt);
  const current = await fs.pathExists(sessionPath)
    ? await fs.readJson<TaskSessionRecord>(sessionPath)
    : empty;
  const record = {
    ...session,
    updatedAt: session.updatedAt
  };

  await fs.writeJsonAtomic(sessionPath, {
    ...current,
    updatedAt: session.updatedAt,
    roles: {
      ...current.roles,
      [session.role]: {
        id: session.id,
        claudeSessionId: session.claudeSessionId,
        transcriptPath: session.transcriptPath,
        status: session.status,
        record
      }
    }
  });
}

function createEmptyTaskSessionRecord(taskSlug: string, updatedAt: string): TaskSessionRecord {
  return {
    version: 1,
    taskSlug,
    updatedAt,
    roles: {
      "project-manager": { id: null, status: "not_started" },
      architect: { id: null, status: "not_started" },
      coder: { id: null, status: "not_started" },
      reviewer: { id: null, status: "not_started" }
    }
  };
}

function getTaskSessionPath(repoRoot: string, stateRoot: string, taskSlug: string): string {
  return path.join(repoRoot, stateRoot, "sessions", `${taskSlug}.json`);
}

function normalizeClaudePermissionMode(value: unknown): ClaudePermissionMode {
  if (value === "bypassPermissions" || value === "dangerously-skip-permissions") {
    return "bypassPermissions";
  }
  return "default";
}

function normalizeClaudeModel(value: unknown): ClaudeModel {
  if (
    value === "best"
    || value === "fable"
    || value === "opus"
    || value === "opus[1m]"
    || value === "claude-opus-4-8"
    || value === "claude-opus-4-8[1m]"
  ) {
    return value;
  }
  return "default";
}

function normalizeCodexModel(value: unknown): CodexModel {
  if (value === "default" || value === "gpt-5.5") {
    return value;
  }
  return "gpt-5.5";
}

function normalizeClaudeEffort(value: unknown): SessionEffort {
  if (
    value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
    || value === "ultracode"
  ) {
    return value;
  }
  return "default";
}

function normalizeCodexEffort(value: unknown): SessionEffort {
  if (
    value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
  ) {
    return value;
  }
  return "default";
}

function extractTomlSection(content: string, sectionName: string): string {
  const lines = content.split(/\r?\n/);
  const header = `[${sectionName}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) {
    return "";
  }

  const section: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) {
      break;
    }
    section.push(line);
  }
  return section.join("\n");
}

function parseTomlString(content: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`, "m");
  return pattern.exec(content)?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDisplayArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
