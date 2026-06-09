import { randomUUID } from "node:crypto";
import path from "node:path";
import { ROLE_NAMES, isDispatchableRole } from "../../shared/constants.js";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import type { RoleName } from "../../shared/types/role.js";
import type {
  ClaudePermissionMode,
  RoleSessionRecord,
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
  recordClaudeHookEvent(repoRoot: string, input: RecordClaudeHookEventInput): Promise<RoleSessionRecord | undefined>;
  markRoleActivityRunning(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord | undefined>;
}

export interface SessionServiceDeps {
  fs: FileSystemAdapter;
  runtime: TerminalRuntime;
  registry: SessionRegistry;
  claude: ClaudeAdapter;
  artifactService: ArtifactService;
  projectService: Pick<ProjectService, "loadConfig">;
  taskService: Pick<TaskService, "loadTask" | "updateTaskStatus">;
  apiUrl?: string;
  now?: () => string;
}

type LaunchMode = "fresh" | "resume";

export interface RecordClaudeHookEventInput {
  taskSlug: string;
  role: RoleName;
  eventName: ClaudeHookEventName;
  claudeSessionId?: string;
  transcriptPath?: string;
  cwd?: string;
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
    const permissionMode = normalizeClaudePermissionMode(input.permissionMode ?? persisted?.permissionMode);
    const claudeSessionId = launchMode === "resume"
      ? persisted?.claudeSessionId
      : randomUUID();

    if (!claudeSessionId) {
      throw new VcmError({
        code: "CLAUDE_SESSION_MISSING",
        message: `${role} does not have a Claude session id to resume.`,
        statusCode: 409,
        hint: "Start the role once before using Resume."
      });
    }
    const transcriptPath = launchMode === "resume" && persisted?.transcriptPath
      ? persisted.transcriptPath
      : claudeTranscriptPath(taskRepoRoot, claudeSessionId);

    const startCommand = deps.claude.buildRoleStartCommand(
      role,
      config.claudeCommand,
      permissionMode,
      claudeSessionId,
      launchMode === "resume"
    );
    const runtimeSession = await deps.runtime.createSession({
      taskSlug,
      role,
      command: startCommand.command,
      args: startCommand.args,
      cwd: taskRepoRoot,
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
      cwd: taskRepoRoot,
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
    await deps.taskService.updateTaskStatus(repoRoot, taskSlug, "running");
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
    async recordClaudeHookEvent(repoRoot, input) {
      const current = await this.getRoleSession(repoRoot, input.taskSlug, input.role);
      if (!current || !matchesClaudeHookSession(current, input)) {
        return undefined;
      }

      const timestamp = now();
      const isStop = input.eventName === "Stop";
      const updated: RoleSessionRecord = {
        ...current,
        activityStatus: isStop ? "idle" : "running",
        lastHookEventAt: timestamp,
        lastStopAt: isStop ? timestamp : current.lastStopAt,
        lastPromptSubmittedAt: isStop ? current.lastPromptSubmittedAt : timestamp,
        updatedAt: timestamp
      };
      deps.registry.upsert(updated);

      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, input.taskSlug);
      await persistTaskSession(deps.fs, getTaskRuntimeRepoRoot(task), config.stateRoot, updated);
      return updated;
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
        lastPromptSubmittedAt: timestamp,
        lastHookEventAt: timestamp,
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

function matchesClaudeHookSession(record: RoleSessionRecord, input: RecordClaudeHookEventInput): boolean {
  if (input.claudeSessionId && record.claudeSessionId === input.claudeSessionId) {
    return true;
  }
  if (input.transcriptPath && record.transcriptPath === input.transcriptPath) {
    return true;
  }
  if (!input.claudeSessionId && !input.transcriptPath) {
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
  return record
    ? {
        ...record,
        permissionMode: normalizeClaudePermissionMode(record.permissionMode)
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
