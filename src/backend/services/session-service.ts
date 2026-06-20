import { randomUUID } from "node:crypto";
import path from "node:path";
import { ROLE_NAMES, isCodexRoleName, isDispatchableRole } from "../../shared/constants.js";
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
  sandboxMode?: string;
  now?: () => string;
}

type LaunchMode = "fresh" | "resume";

const CODEX_REVIEWER_ROLE: RoleName = "codex-reviewer";
const CODEX_TRANSLATOR_ROLE: RoleName = "codex-translator";
const CODEX_DIR = ".ai/codex";
const CODEX_REVIEW_DIR = ".ai/vcm/codex-reviews";
const CODEX_CONFIG_PATH = ".ai/codex/config.toml";
const CODEX_TRANSLATOR_DIR = ".ai/codex-translator";
const CODEX_TRANSLATION_DIR = ".ai/vcm/translations";
const CODEX_TRANSLATOR_SESSION_PATH = ".ai/vcm/translations/runtime/session.json";
const LEGACY_CODEX_TRANSLATOR_SESSION_PATH = ".ai/vcm/translations/session.json";
const CODEX_TRANSLATOR_LOG_PATHS = [
  ".ai/vcm/translations/runtime/codex-translator.log",
  ".ai/vcm/translations/codex-translator.log"
] as const;
const CODEX_TRANSLATOR_CONFIG_PATH = ".ai/codex-translator/config.toml";

interface ProjectRoleSessionFile {
  version: 1;
  role: RoleName;
  updatedAt: string;
  record: RoleSessionRecord;
}

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
    const live = toRoleSessionRecordView(
      getRegisteredRoleSession(deps.registry, deps.runtime, taskSlug, role),
      deps.runtime
    );
    if (live && live.status === "running") {
      return live;
    }

    const config = await deps.projectService.loadConfig(repoRoot);
    const task = await deps.taskService.loadTask(repoRoot, taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    const paths = deps.artifactService.getHandoffPaths(taskRepoRoot, task.handoffDir);
    const persisted = await loadPersistedRoleRecordForRole(deps.fs, repoRoot, taskRepoRoot, config.stateRoot, taskSlug, role);
    const isCodexRole = isCodexRoleName(role);
    const isTranslator = role === CODEX_TRANSLATOR_ROLE;
    const sessionRepoRoot = isTranslator ? repoRoot : taskRepoRoot;
    const sessionLogPath = isTranslator ? undefined : paths.roleLogPaths[role];
    const permissionMode = normalizeClaudePermissionMode(input.permissionMode ?? persisted?.permissionMode);
    const model: SessionModel = isCodexRole
      ? normalizeCodexModel(input.model ?? persisted?.model)
      : normalizeClaudeModel(input.model ?? persisted?.model);
    const effort = isCodexRole
      ? normalizeCodexEffort(input.effort ?? persisted?.effort)
      : normalizeClaudeEffort(input.effort ?? persisted?.effort);
    if (isTranslator) {
      await cleanupCodexTranslatorLogs(deps.fs, repoRoot);
    }
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
      : isCodexRole ? undefined : claudeTranscriptPath(taskRepoRoot, claudeSessionId);

    const startCommand = isCodexRole
      ? await buildCodexStartCommand(
          deps.fs,
          repoRoot,
          taskRepoRoot,
          role,
          launchMode,
          model as CodexModel,
          effort,
          deps.sandboxMode,
          launchMode === "resume" && hasCapturedCodexSession(persisted) ? claudeSessionId : undefined
        )
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
        VCM_TASK_REPO_ROOT: sessionRepoRoot,
        VCM_TASK_SLUG: taskSlug,
        VCM_ROLE: role,
        VCM_SESSION_ID: claudeSessionId
      },
      cols: input.cols,
      rows: input.rows,
      ...(sessionLogPath ? { logPath: resolveRepoPath(sessionRepoRoot, sessionLogPath) } : {})
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
      ...(sessionLogPath ? { logPath: sessionLogPath } : {}),
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
    await persistRoleSessionRecord(deps.fs, repoRoot, taskRepoRoot, config.stateRoot, record);
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
      await persistRoleSessionRecord(deps.fs, repoRoot, getTaskRuntimeRepoRoot(task), config.stateRoot, updated);
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
      const record = getRegisteredRoleSession(deps.registry, deps.runtime, taskSlug, role)
        ?? await loadPersistedRoleRecordForRole(deps.fs, repoRoot, taskRepoRoot, config.stateRoot, taskSlug, role);
      if (!record) {
        return undefined;
      }

      return toRoleSessionRecordView(record, deps.runtime);
    },
    async listRoleSessions(repoRoot, taskSlug) {
      const sessions: RoleSessionRecord[] = [];
      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      const persistedTaskSession = await loadPersistedTaskSessionRecord(deps.fs, taskRepoRoot, config.stateRoot, taskSlug);
      for (const role of ROLE_NAMES) {
        const record = role === CODEX_TRANSLATOR_ROLE
          ? getRegisteredRoleSession(deps.registry, deps.runtime, taskSlug, role)
            ?? await loadPersistedCodexTranslatorSession(deps.fs, repoRoot, taskSlug)
          : deps.registry.getByRole(taskSlug, role)
            ?? normalizePersistedRoleRecord(persistedTaskSession?.roles[role]?.record);
        const session = toRoleSessionRecordView(
          record,
          deps.runtime
        );
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
      await persistRoleSessionRecord(deps.fs, repoRoot, getTaskRuntimeRepoRoot(task), config.stateRoot, updated);
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
      await persistRoleSessionRecord(deps.fs, repoRoot, getTaskRuntimeRepoRoot(task), config.stateRoot, updated);
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
      await persistRoleSessionRecord(deps.fs, repoRoot, getTaskRuntimeRepoRoot(task), config.stateRoot, updated);
      return updated;
    }
  };
}

function toRoleSessionRecordView(
  record: RoleSessionRecord | undefined,
  runtime: TerminalRuntime
): RoleSessionRecord | undefined {
  if (!record) {
    return undefined;
  }

  const runtimeSession = runtime.getSession(record.id);
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
}

async function buildCodexStartCommand(
  fs: FileSystemAdapter,
  baseRepoRoot: string,
  taskRepoRoot: string,
  role: RoleName,
  launchMode: LaunchMode,
  selectedModel: CodexModel,
  selectedEffort: SessionEffort,
  sandboxMode: string | undefined,
  resumeSessionId?: string
): Promise<{ command: string; args: string[]; display: string; cwd: string }> {
  const isTranslator = role === CODEX_TRANSLATOR_ROLE;
  const codexDir = resolveRepoPath(isTranslator ? baseRepoRoot : taskRepoRoot, isTranslator ? CODEX_TRANSLATOR_DIR : CODEX_DIR);
  const outputDir = resolveRepoPath(isTranslator ? baseRepoRoot : taskRepoRoot, isTranslator ? CODEX_TRANSLATION_DIR : CODEX_REVIEW_DIR);
  if (!(await fs.pathExists(codexDir))) {
    throw new VcmError({
      code: isTranslator ? "CODEX_TRANSLATOR_CONFIG_MISSING" : "CODEX_REVIEW_CONFIG_MISSING",
      message: `${isTranslator ? CODEX_TRANSLATOR_DIR : CODEX_DIR} does not exist.`,
      statusCode: 409,
      hint: `Apply the VCM harness before starting ${isTranslator ? "Codex Translator" : "Codex Reviewer"}.`
    });
  }

  await fs.ensureDir(outputDir);
  const config = await loadCodexSessionConfig(fs, isTranslator ? baseRepoRoot : taskRepoRoot, isTranslator ? CODEX_TRANSLATOR_CONFIG_PATH : CODEX_CONFIG_PATH);
  const args = launchMode === "resume"
    ? resumeSessionId ? ["resume", resumeSessionId] : ["resume", "--last"]
    : [];
  args.push("--cd", codexDir);
  if (isDevContainerSandbox(sandboxMode)) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    if (isTranslator) {
      args.push("--add-dir", baseRepoRoot);
    } else {
      args.push("--add-dir", outputDir);
    }
    args.push(
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never"
    );
  }
  args.push(
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
    cwd: isTranslator ? baseRepoRoot : taskRepoRoot,
    display: [config.command, ...args].map(formatDisplayArg).join(" ")
  };
}

function hasCapturedCodexSession(record: RoleSessionRecord | undefined): boolean {
  return Boolean(record?.lastHookEventAt || record?.transcriptPath);
}

function isDevContainerSandbox(value: string | undefined): boolean {
  const normalized = value?.toLowerCase().replace(/[\s_-]+/g, "");
  return normalized === "devcontainer" ||
    normalized === "container" ||
    normalized === "docker" ||
    normalized === "podman" ||
    normalized === "codespaces" ||
    normalized === "bypass" ||
    normalized === "nosandbox" ||
    normalized === "disabled" ||
    normalized === "off" ||
    normalized === "none";
}

async function loadCodexSessionConfig(
  fs: FileSystemAdapter,
  repoRoot: string,
  configRelativePath: string
): Promise<{ command: string }> {
  const configPath = resolveRepoPath(repoRoot, configRelativePath);
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

function getRegisteredRoleSession(
  registry: SessionRegistry,
  runtime: TerminalRuntime,
  taskSlug: string,
  role: RoleName
): RoleSessionRecord | undefined {
  if (role !== CODEX_TRANSLATOR_ROLE) {
    return registry.getByRole(taskSlug, role);
  }

  const candidates = registry.list().filter((session) => session.role === role);
  const live = candidates.find((session) => runtime.getSession(session.id)?.status === "running");
  const scoped = live
    ?? candidates.find((session) => session.taskSlug === taskSlug)
    ?? candidates.sort(compareSessionUpdatedAtDesc)[0];
  return scopeProjectRoleSession(scoped, taskSlug);
}

function compareSessionUpdatedAtDesc(left: RoleSessionRecord, right: RoleSessionRecord): number {
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
}

function scopeProjectRoleSession(record: RoleSessionRecord | undefined, taskSlug: string): RoleSessionRecord | undefined {
  if (!record || record.role !== CODEX_TRANSLATOR_ROLE) {
    return record;
  }
  return {
    ...record,
    taskSlug
  };
}

async function loadPersistedRoleRecordForRole(
  fs: FileSystemAdapter,
  baseRepoRoot: string,
  taskRepoRoot: string,
  stateRoot: string,
  taskSlug: string,
  role: RoleName
): Promise<RoleSessionRecord | undefined> {
  if (role === CODEX_TRANSLATOR_ROLE) {
    return loadPersistedCodexTranslatorSession(fs, baseRepoRoot, taskSlug);
  }

  return loadPersistedRoleRecord(fs, taskRepoRoot, stateRoot, taskSlug, role);
}

async function loadPersistedCodexTranslatorSession(
  fs: FileSystemAdapter,
  repoRoot: string,
  taskSlug: string
): Promise<RoleSessionRecord | undefined> {
  let sessionPath = resolveRepoPath(repoRoot, CODEX_TRANSLATOR_SESSION_PATH);
  if (!(await fs.pathExists(sessionPath))) {
    const legacySessionPath = resolveRepoPath(repoRoot, LEGACY_CODEX_TRANSLATOR_SESSION_PATH);
    if (!(await fs.pathExists(legacySessionPath))) {
      return undefined;
    }
    sessionPath = legacySessionPath;
  }

  const payload = await fs.readJson<ProjectRoleSessionFile | RoleSessionRecord>(sessionPath);
  const record = normalizePersistedRoleRecord(isProjectRoleSessionFile(payload) ? payload.record : payload);
  if (!record) {
    return undefined;
  }
  if (sessionPath.endsWith(LEGACY_CODEX_TRANSLATOR_SESSION_PATH)) {
    await persistCodexTranslatorSession(fs, repoRoot, {
      ...record,
      taskSlug
    });
    await fs.removePath?.(sessionPath, { force: true });
  }
  return scopeProjectRoleSession(record, taskSlug);
}

async function cleanupCodexTranslatorLogs(fs: FileSystemAdapter, repoRoot: string): Promise<void> {
  if (!fs.removePath) {
    return;
  }
  await Promise.all(CODEX_TRANSLATOR_LOG_PATHS.map((relativePath) =>
    fs.removePath?.(resolveRepoPath(repoRoot, relativePath), { force: true })
  ));
}

async function loadPersistedRoleRecord(
  fs: FileSystemAdapter,
  repoRoot: string,
  stateRoot: string,
  taskSlug: string,
  role: RoleName
): Promise<RoleSessionRecord | undefined> {
  const current = await loadPersistedTaskSessionRecord(fs, repoRoot, stateRoot, taskSlug);
  return normalizePersistedRoleRecord(current?.roles[role]?.record);
}

async function loadPersistedTaskSessionRecord(
  fs: FileSystemAdapter,
  repoRoot: string,
  stateRoot: string,
  taskSlug: string
): Promise<TaskSessionRecord | undefined> {
  const sessionPath = getTaskSessionPath(repoRoot, stateRoot, taskSlug);
  if (!(await fs.pathExists(sessionPath))) {
    return undefined;
  }

  return fs.readJson<TaskSessionRecord>(sessionPath);
}

function normalizePersistedRoleRecord(record: RoleSessionRecord | undefined): RoleSessionRecord | undefined {
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
        model: isCodexRoleName(record.role)
          ? normalizeCodexModel(record.model)
          : normalizeClaudeModel(record.model),
        effort: isCodexRoleName(record.role)
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

async function persistRoleSessionRecord(
  fs: FileSystemAdapter,
  baseRepoRoot: string,
  taskRepoRoot: string,
  stateRoot: string,
  session: RoleSessionRecord
): Promise<void> {
  if (session.role === CODEX_TRANSLATOR_ROLE) {
    await persistCodexTranslatorSession(fs, baseRepoRoot, session);
    return;
  }

  await persistTaskSession(fs, taskRepoRoot, stateRoot, session);
}

async function persistCodexTranslatorSession(
  fs: FileSystemAdapter,
  repoRoot: string,
  session: RoleSessionRecord
): Promise<void> {
  await fs.writeJsonAtomic<ProjectRoleSessionFile>(
    resolveRepoPath(repoRoot, CODEX_TRANSLATOR_SESSION_PATH),
    {
      version: 1,
      role: session.role,
      updatedAt: session.updatedAt,
      record: {
        ...session,
        taskSlug: session.taskSlug
      }
    }
  );
}

function isProjectRoleSessionFile(value: ProjectRoleSessionFile | RoleSessionRecord): value is ProjectRoleSessionFile {
  return "record" in value && typeof value.record === "object" && value.record !== null;
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
