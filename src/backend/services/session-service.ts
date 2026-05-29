import { randomUUID } from "node:crypto";
import path from "node:path";
import { ROLE_NAMES, isDispatchableRole } from "../../shared/constants.js";
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
import { renderRoleMessagingContext } from "../templates/role-messaging-context.js";
import type { ArtifactService } from "./artifact-service.js";
import type { ProjectService } from "./project-service.js";
import type { TaskService } from "./task-service.js";

export interface SessionService {
  startRoleSession(repoRoot: string, taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  resumeRoleSession(repoRoot: string, taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  stopRoleSession(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord>;
  restartRoleSession(repoRoot: string, taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  getRoleSession(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord | undefined>;
  listRoleSessions(repoRoot: string, taskSlug: string): Promise<RoleSessionRecord[]>;
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
  vcmctlCommand?: string;
  now?: () => string;
}

type LaunchMode = "fresh" | "resume";

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
    const paths = deps.artifactService.getHandoffPaths(repoRoot, task.handoffDir);
    const persisted = await loadPersistedRoleRecord(deps.fs, repoRoot, config.stateRoot, taskSlug, role);
    const permissionMode = input.permissionMode ?? persisted?.permissionMode ?? "default";
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
      cwd: repoRoot,
      env: {
        VCM_API_URL: deps.apiUrl,
        VCM_CTL_COMMAND: deps.vcmctlCommand,
        VCM_TASK_SLUG: taskSlug,
        VCM_ROLE: role
      },
      cols: input.cols,
      rows: input.rows,
      logPath: resolveRepoPath(repoRoot, paths.roleLogPaths[role])
    });
    const timestamp = now();
    const record: RoleSessionRecord = {
      id: runtimeSession.id,
      claudeSessionId,
      taskSlug,
      role,
      status: runtimeSession.status,
      command: startCommand.display,
      permissionMode,
      cwd: repoRoot,
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
    await persistTaskSession(deps.fs, repoRoot, config.stateRoot, record);
    await deps.taskService.updateTaskStatus(repoRoot, taskSlug, "running");
    deps.runtime.write(runtimeSession.id, `${renderRoleMessagingContext(task, paths, role, deps.vcmctlCommand)}\r`);
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
        updatedAt: now()
      };
      deps.registry.upsert(updated);
      const config = await deps.projectService.loadConfig(repoRoot);
      await persistTaskSession(deps.fs, repoRoot, config.stateRoot, updated);
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

      return existing.claudeSessionId
        ? launchRoleSession(repoRoot, taskSlug, role, input, "resume")
        : launchRoleSession(repoRoot, taskSlug, role, input, "fresh");
    },
    async getRoleSession(repoRoot, taskSlug, role) {
      const config = await deps.projectService.loadConfig(repoRoot);
      const record = deps.registry.getByRole(taskSlug, role)
        ?? await loadPersistedRoleRecord(deps.fs, repoRoot, config.stateRoot, taskSlug, role);
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
    }
  };
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
  if (role === "coder") {
    return paths.implementationLogPath;
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
  return current.roles[role]?.record;
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
