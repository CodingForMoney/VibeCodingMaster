import path from "node:path";
import { VCM_ROLE_NAMES, isDispatchableRole } from "../../shared/constants.js";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import type { RoleName } from "../../shared/types/role.js";
import type {
  ClaudeModel,
  ClaudePermissionMode,
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
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { ArtifactService } from "./artifact-service.js";
import { claudeTranscriptPath } from "./claude-transcript-service.js";
import { readHarnessRevisionState } from "./harness-revision.js";
import type { ProjectService } from "./project-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";

export interface SessionService {
  startProjectTranslatorSession(repoRoot: string, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  resumeProjectTranslatorSession(repoRoot: string, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  stopProjectTranslatorSession(repoRoot: string): Promise<RoleSessionRecord>;
  moveProjectTranslatorSessionToSafeCwd(repoRoot: string): Promise<RoleSessionRecord>;
  restartProjectTranslatorSession(repoRoot: string, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  getProjectTranslatorSession(repoRoot: string): Promise<RoleSessionRecord | undefined>;
  ensureProjectTranslatorSession(repoRoot: string, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  recordProjectTranslatorHookEvent(repoRoot: string, input: RecordProjectTranslatorHookEventInput): Promise<RoleSessionRecord | undefined>;
  notifyProjectTranslatorHarnessUpdated(repoRoot: string): Promise<RoleSessionRecord>;
  startProjectHarnessEngineerSession(repoRoot: string, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  resumeProjectHarnessEngineerSession(repoRoot: string, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  stopProjectHarnessEngineerSession(repoRoot: string): Promise<RoleSessionRecord>;
  moveProjectHarnessEngineerSessionToSafeCwd(repoRoot: string): Promise<RoleSessionRecord>;
  restartProjectHarnessEngineerSession(repoRoot: string, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  getProjectHarnessEngineerSession(repoRoot: string): Promise<RoleSessionRecord | undefined>;
  ensureProjectHarnessEngineerSession(repoRoot: string, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  recordProjectHarnessEngineerHookEvent(repoRoot: string, input: RecordProjectToolHookEventInput): Promise<RoleSessionRecord | undefined>;
  notifyProjectHarnessEngineerHarnessUpdated(repoRoot: string): Promise<RoleSessionRecord>;
  startRoleSession(repoRoot: string, taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  resumeRoleSession(repoRoot: string, taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  stopRoleSession(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord>;
  restartRoleSession(repoRoot: string, taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  getRoleSession(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord | undefined>;
  listRoleSessions(repoRoot: string, taskSlug: string): Promise<RoleSessionRecord[]>;
  notifyRoleHarnessUpdated(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord>;
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

const TRANSLATOR_ROLE: RoleName = "translator";
const HARNESS_ENGINEER_ROLE: RoleName = "harness-engineer";
const TRANSLATION_DIR = ".ai/vcm/translations";
const TRANSLATOR_SESSION_PATH = ".ai/vcm/translations/session.json";
const HARNESS_ENGINEER_DIR = ".ai/vcm/harness-engineer";
const HARNESS_ENGINEER_SESSION_PATH = ".ai/vcm/harness-engineer/session.json";
const PROJECT_TRANSLATOR_SCOPE = "__project__";
const PROJECT_HARNESS_ENGINEER_SCOPE = "__project_harness_engineer__";
const PROJECT_TOOL_CD_ENTER_DELAY_MS = 500;

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

export interface RecordProjectTranslatorHookEventInput {
  eventName: ClaudeHookEventName;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
}

export type RecordProjectToolHookEventInput = RecordProjectTranslatorHookEventInput;

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const now = deps.now ?? (() => new Date().toISOString());

  async function readCurrentHarnessRevision(repoRoot: string): Promise<number> {
    return (await readHarnessRevisionState(deps.fs, repoRoot)).revision;
  }

  async function withHarnessRevisionView(
    repoRoot: string,
    record: RoleSessionRecord
  ): Promise<RoleSessionRecord> {
    const currentRevision = await readCurrentHarnessRevision(repoRoot);
    const sessionRevision = normalizeHarnessRevision(record.harnessRevision);
    return {
      ...record,
      harnessRevision: sessionRevision,
      harnessCurrentRevision: currentRevision,
      harnessOutdated: sessionRevision < currentRevision
    };
  }

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
      return withHarnessRevisionView(repoRoot, live);
    }

    const config = await deps.projectService.loadConfig(repoRoot);
    const task = await deps.taskService.loadTask(repoRoot, taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    const paths = deps.artifactService.getHandoffPaths(taskRepoRoot, task.handoffDir);
    const persisted = await loadPersistedRoleRecordForRole(deps.fs, repoRoot, taskRepoRoot, config.stateRoot, taskSlug, role);
    const permissionMode = normalizeClaudePermissionMode(input.permissionMode ?? persisted?.permissionMode);
    const model: SessionModel = normalizeClaudeModel(input.model ?? persisted?.model);
    const effort = normalizeClaudeEffort(input.effort ?? persisted?.effort);
    const resumeClaudeSessionId = launchMode === "resume"
      ? persisted?.claudeSessionId
      : undefined;

    if (launchMode === "resume" && !resumeClaudeSessionId) {
      throw new VcmError({
        code: "CLAUDE_SESSION_MISSING",
        message: `${role} does not have a session id to resume.`,
        statusCode: 409,
        hint: "Start the role once before using Resume."
      });
    }
    const claudeSessionId = resumeClaudeSessionId ?? "";
    const transcriptPath = launchMode === "resume" && persisted?.transcriptPath
      ? persisted.transcriptPath
      : resumeClaudeSessionId
        ? claudeTranscriptPath(taskRepoRoot, resumeClaudeSessionId)
        : undefined;

    const startCommand = {
      ...deps.claude.buildRoleStartCommand(
        role,
        config.claudeCommand,
        permissionMode,
        resumeClaudeSessionId,
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
        VCM_BASE_REPO_ROOT: repoRoot,
        VCM_TASK_REPO_ROOT: taskRepoRoot,
        VCM_TASK_SLUG: taskSlug,
        VCM_ROLE: role,
        VCM_SESSION_ID: claudeSessionId || undefined
      },
      cols: input.cols,
      rows: input.rows
    });
    const timestamp = now();
    const harnessRevision = await readCurrentHarnessRevision(repoRoot);
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
      roleCommandPath: isDispatchableRole(role)
        ? paths.roleCommandPaths[role]
        : undefined,
      handoffArtifactPath: getHandoffArtifactPath(paths, role),
      startedAt: runtimeSession.startedAt,
      updatedAt: timestamp,
      lastOutputAt: runtimeSession.lastOutputAt,
      harnessRevision,
      exitCode: runtimeSession.exitCode
    };

    deps.registry.upsert(record);
    await persistRoleSessionRecord(deps.fs, repoRoot, taskRepoRoot, config.stateRoot, record);
    return withHarnessRevisionView(repoRoot, record);
  }

  async function launchProjectTranslatorSession(
    repoRoot: string,
    input: StartRoleSessionRequest,
    launchMode: LaunchMode
  ): Promise<RoleSessionRecord> {
    const taskContext = await resolveProjectToolTaskContext(repoRoot, input, "Translator");
    const live = toRoleSessionRecordView(
      getRegisteredProjectTranslatorSession(deps.registry, deps.runtime),
      deps.runtime
    );
    if (live && live.status === "running") {
      return withHarnessRevisionView(
        repoRoot,
        await migrateRunningProjectToolSessionCwd(repoRoot, live, taskContext.taskRepoRoot)
      );
    }

    const config = await deps.projectService.loadConfig(repoRoot);
    const persisted = await loadPersistedTranslatorSession(deps.fs, repoRoot);
    const permissionMode = normalizeClaudePermissionMode(input.permissionMode ?? persisted?.permissionMode);
    const model = normalizeClaudeModel(input.model ?? persisted?.model);
    const effort = normalizeClaudeEffort(input.effort ?? persisted?.effort ?? "medium");
    const resumeClaudeSessionId = launchMode === "resume"
      ? persisted?.claudeSessionId
      : undefined;

    if (launchMode === "resume" && !resumeClaudeSessionId) {
      throw new VcmError({
        code: "TRANSLATOR_SESSION_MISSING",
        message: "Translator does not have a session id to resume.",
        statusCode: 409,
        hint: "Start the translator once before using Resume."
      });
    }

    await deps.fs.ensureDir(resolveRepoPath(repoRoot, TRANSLATION_DIR));
    // Project-level tool sessions always launch (and resume) from the base
    // repoRoot. Claude anchors a session transcript to its first-launch cwd and
    // `/cd` never relocates that transcript, so a constant repoRoot anchor keeps
    // `claude --resume` valid even after the prior task worktree is deleted. The
    // active task worktree is entered afterwards via `/cd`
    // (migrateRunningProjectToolSessionCwd), and the task root is also exposed
    // independently of pty cwd via VCM_TASK_REPO_ROOT.
    const launchCwd = repoRoot;
    // `claude --resume` restores the session's last working directory, so a resumed
    // session is already at its persisted cwd (not the repoRoot spawn cwd). Track that
    // restored cwd so the `/cd` migrate below fires only on an actual switch; a fresh
    // session genuinely starts at repoRoot.
    const sessionCwd = launchMode === "resume" ? persisted?.cwd ?? launchCwd : launchCwd;
    const claudeSessionId = resumeClaudeSessionId ?? "";
    const transcriptPath = resumeClaudeSessionId
      ? claudeTranscriptPath(repoRoot, resumeClaudeSessionId)
      : undefined;
    const startCommand = {
      ...deps.claude.buildRoleStartCommand(
        TRANSLATOR_ROLE,
        config.claudeCommand,
        permissionMode,
        resumeClaudeSessionId,
        launchMode === "resume",
        model,
        effort
      ),
      cwd: launchCwd
    };
    const runtimeSession = await deps.runtime.createSession({
      taskSlug: PROJECT_TRANSLATOR_SCOPE,
      role: TRANSLATOR_ROLE,
      command: startCommand.command,
      args: startCommand.args,
      cwd: startCommand.cwd,
      env: {
        VCM_API_URL: deps.apiUrl,
        VCM_BASE_REPO_ROOT: repoRoot,
        VCM_TASK_REPO_ROOT: taskContext.taskRepoRoot,
        // Project-scoped sessions report their project sentinel as VCM_TASK_SLUG so
        // hook payloads match this session's record and cannot be attributed to the
        // active task; VCM_TASK_REPO_ROOT remains the active worktree.
        VCM_TASK_SLUG: PROJECT_TRANSLATOR_SCOPE,
        VCM_ROLE: TRANSLATOR_ROLE,
        VCM_SESSION_ID: claudeSessionId || undefined
      },
      cols: input.cols,
      rows: input.rows
    });
    const timestamp = now();
    const harnessRevision = await readCurrentHarnessRevision(repoRoot);
    const record: RoleSessionRecord = {
      id: runtimeSession.id,
      claudeSessionId,
      transcriptPath,
      taskSlug: PROJECT_TRANSLATOR_SCOPE,
      role: TRANSLATOR_ROLE,
      status: runtimeSession.status,
      activityStatus: "idle",
      command: startCommand.display,
      permissionMode,
      model,
      effort,
      cwd: sessionCwd,
      terminalBackend: "node-pty",
      pid: runtimeSession.pid,
      startedAt: runtimeSession.startedAt,
      updatedAt: timestamp,
      lastOutputAt: runtimeSession.lastOutputAt,
      harnessRevision,
      exitCode: runtimeSession.exitCode
    };

    deps.registry.upsert(record);
    await persistTranslatorSession(deps.fs, repoRoot, record);
    return withHarnessRevisionView(
      repoRoot,
      await migrateRunningProjectToolSessionCwd(repoRoot, record, taskContext.taskRepoRoot)
    );
  }

  async function launchProjectHarnessEngineerSession(
    repoRoot: string,
    input: StartRoleSessionRequest,
    launchMode: LaunchMode
  ): Promise<RoleSessionRecord> {
    const taskContext = await resolveProjectToolTaskContext(repoRoot, input, "Harness Engineer");
    const live = toRoleSessionRecordView(
      getRegisteredProjectHarnessEngineerSession(deps.registry, deps.runtime),
      deps.runtime
    );
    if (live && live.status === "running") {
      return withHarnessRevisionView(
        repoRoot,
        await migrateRunningProjectToolSessionCwd(repoRoot, live, taskContext.taskRepoRoot)
      );
    }

    const config = await deps.projectService.loadConfig(repoRoot);
    const persisted = await loadPersistedHarnessEngineerSession(deps.fs, repoRoot);
    const permissionMode = normalizeClaudePermissionMode(input.permissionMode ?? persisted?.permissionMode);
    const model = normalizeClaudeModel(input.model ?? persisted?.model);
    const effort = normalizeClaudeEffort(input.effort ?? persisted?.effort ?? "medium");
    const resumeClaudeSessionId = launchMode === "resume"
      ? persisted?.claudeSessionId
      : undefined;

    if (launchMode === "resume" && !resumeClaudeSessionId) {
      throw new VcmError({
        code: "HARNESS_ENGINEER_SESSION_MISSING",
        message: "Harness Engineer does not have a session id to resume.",
        statusCode: 409,
        hint: "Start Harness Engineer once before using Resume."
      });
    }

    await deps.fs.ensureDir(resolveRepoPath(repoRoot, HARNESS_ENGINEER_DIR));
    // See launchProjectTranslatorSession: project-level tool sessions launch and
    // resume from the base repoRoot so the transcript anchor stays stable and
    // resume never depends on a possibly-deleted task worktree. The active task
    // worktree is entered afterwards via `/cd`.
    const launchCwd = repoRoot;
    // `claude --resume` restores the session's last working directory, so a resumed
    // session is already at its persisted cwd (not the repoRoot spawn cwd). Track that
    // restored cwd so the `/cd` migrate below fires only on an actual switch.
    const sessionCwd = launchMode === "resume" ? persisted?.cwd ?? launchCwd : launchCwd;
    const claudeSessionId = resumeClaudeSessionId ?? "";
    const transcriptPath = resumeClaudeSessionId
      ? claudeTranscriptPath(repoRoot, resumeClaudeSessionId)
      : undefined;
    const startCommand = {
      ...deps.claude.buildRoleStartCommand(
        HARNESS_ENGINEER_ROLE,
        config.claudeCommand,
        permissionMode,
        resumeClaudeSessionId,
        launchMode === "resume",
        model,
        effort
      ),
      cwd: launchCwd
    };
    const runtimeSession = await deps.runtime.createSession({
      taskSlug: PROJECT_HARNESS_ENGINEER_SCOPE,
      role: HARNESS_ENGINEER_ROLE,
      command: startCommand.command,
      args: startCommand.args,
      cwd: startCommand.cwd,
      env: {
        VCM_API_URL: deps.apiUrl,
        VCM_BASE_REPO_ROOT: repoRoot,
        VCM_TASK_REPO_ROOT: taskContext.taskRepoRoot,
        // Project-scoped sessions report their project sentinel as VCM_TASK_SLUG so
        // hook payloads match this session's record and cannot be attributed to the
        // active task; VCM_TASK_REPO_ROOT remains the active worktree.
        VCM_TASK_SLUG: PROJECT_HARNESS_ENGINEER_SCOPE,
        VCM_ROLE: HARNESS_ENGINEER_ROLE,
        VCM_SESSION_ID: claudeSessionId || undefined
      },
      cols: input.cols,
      rows: input.rows
    });
    const timestamp = now();
    const harnessRevision = await readCurrentHarnessRevision(repoRoot);
    const record: RoleSessionRecord = {
      id: runtimeSession.id,
      claudeSessionId,
      transcriptPath,
      taskSlug: PROJECT_HARNESS_ENGINEER_SCOPE,
      role: HARNESS_ENGINEER_ROLE,
      status: runtimeSession.status,
      activityStatus: "idle",
      command: startCommand.display,
      permissionMode,
      model,
      effort,
      cwd: sessionCwd,
      terminalBackend: "node-pty",
      pid: runtimeSession.pid,
      startedAt: runtimeSession.startedAt,
      updatedAt: timestamp,
      lastOutputAt: runtimeSession.lastOutputAt,
      harnessRevision,
      exitCode: runtimeSession.exitCode
    };

    deps.registry.upsert(record);
    await persistHarnessEngineerSession(deps.fs, repoRoot, record);
    return withHarnessRevisionView(
      repoRoot,
      await migrateRunningProjectToolSessionCwd(repoRoot, record, taskContext.taskRepoRoot)
    );
  }

  async function resolveProjectToolTaskContext(
    repoRoot: string,
    input: StartRoleSessionRequest,
    roleLabel: string
  ): Promise<{ taskSlug: string; taskRepoRoot: string }> {
    const taskSlug = input.taskSlug?.trim();
    if (!taskSlug) {
      throw new VcmError({
        code: "PROJECT_TOOL_TASK_REQUIRED",
        message: `${roleLabel} requires an active task worktree.`,
        statusCode: 409,
        hint: "Create or select a task, then start or resume this project tool session."
      });
    }
    const task = await deps.taskService.loadTask(repoRoot, taskSlug);
    return {
      taskSlug: task.taskSlug,
      taskRepoRoot: getTaskRuntimeRepoRoot(task)
    };
  }

  async function migrateRunningProjectToolSessionCwd(
    repoRoot: string,
    session: RoleSessionRecord,
    targetCwd: string
  ): Promise<RoleSessionRecord> {
    if (
      session.role !== TRANSLATOR_ROLE
      && session.role !== HARNESS_ENGINEER_ROLE
    ) {
      return session;
    }
    if (samePath(session.cwd, targetCwd)) {
      return session;
    }

    const runtimeSession = deps.runtime.getSession(session.id);
    if (!runtimeSession || runtimeSession.status !== "running") {
      return session;
    }

    assertSafeCwdTarget(targetCwd);
    const timestamp = now();
    await submitTerminalInput(deps.runtime, session.id, formatClaudeCdCommand(targetCwd), {
      enterDelayMs: PROJECT_TOOL_CD_ENTER_DELAY_MS
    });
    // `cwd` tracks the logical `/cd` target only. The transcript stays anchored at
    // the first-launch cwd (repoRoot for project tools), so transcriptPath must
    // not be recomputed from targetCwd here.
    const updated: RoleSessionRecord = {
      ...session,
      cwd: targetCwd,
      previousCwd: session.cwd,
      updatedAt: timestamp
    };
    deps.registry.upsert(normalizeProjectScopedRecordForPersistence(updated));
    await persistProjectScopedToolSession(repoRoot, updated);
    return updated;
  }

  async function resumeProjectToolSessionAtCwd(
    repoRoot: string,
    session: RoleSessionRecord,
    targetCwd: string
  ): Promise<RoleSessionRecord> {
    const live = toRoleSessionRecordView(
      session.role === TRANSLATOR_ROLE
        ? getRegisteredProjectTranslatorSession(deps.registry, deps.runtime)
        : getRegisteredProjectHarnessEngineerSession(deps.registry, deps.runtime),
      deps.runtime
    );
    if (live?.status === "running") {
      return migrateRunningProjectToolSessionCwd(repoRoot, live, targetCwd);
    }

    const config = await deps.projectService.loadConfig(repoRoot);
    const permissionMode = normalizeClaudePermissionMode(session.permissionMode);
    const model = normalizeClaudeModel(session.model);
    const effort = normalizeClaudeEffort(session.effort);
    // Spawn (`claude --resume`) always anchors at the base repoRoot so resume works
    // even if the persisted task cwd was deleted. `--resume` then restores the
    // session's own last cwd (tracked on `session.cwd`), so the `/cd` migrate below
    // fires only when that restored cwd differs from the target worktree.
    const launchCwd = repoRoot;
    const startCommand = {
      ...deps.claude.buildRoleStartCommand(
        session.role,
        config.claudeCommand,
        permissionMode,
        session.claudeSessionId,
        true,
        model,
        effort
      ),
      cwd: launchCwd
    };
    const runtimeSession = await deps.runtime.createSession({
      taskSlug: normalizeProjectScopedRecordForPersistence(session).taskSlug,
      role: session.role,
      command: startCommand.command,
      args: startCommand.args,
      cwd: startCommand.cwd,
      env: {
        VCM_API_URL: deps.apiUrl,
        VCM_BASE_REPO_ROOT: repoRoot,
        VCM_TASK_REPO_ROOT: targetCwd,
        VCM_TASK_SLUG: normalizeProjectScopedRecordForPersistence(session).taskSlug,
        VCM_ROLE: session.role,
        VCM_SESSION_ID: session.claudeSessionId
      }
    });
    const timestamp = now();
    const resumed: RoleSessionRecord = {
      ...session,
      id: runtimeSession.id,
      status: runtimeSession.status,
      activityStatus: "idle",
      command: startCommand.display,
      permissionMode,
      model,
      effort,
      pid: runtimeSession.pid,
      startedAt: runtimeSession.startedAt,
      updatedAt: timestamp,
      lastOutputAt: runtimeSession.lastOutputAt,
      exitCode: runtimeSession.exitCode,
      transcriptPath: session.claudeSessionId
        ? claudeTranscriptPath(repoRoot, session.claudeSessionId)
        : session.transcriptPath
    };
    deps.registry.upsert(normalizeProjectScopedRecordForPersistence(resumed));
    await persistProjectScopedToolSession(repoRoot, resumed);
    return migrateRunningProjectToolSessionCwd(repoRoot, resumed, targetCwd);
  }

  async function persistProjectScopedToolSession(repoRoot: string, session: RoleSessionRecord): Promise<void> {
    if (session.role === TRANSLATOR_ROLE) {
      await persistTranslatorSession(deps.fs, repoRoot, session);
      return;
    }
    if (session.role === HARNESS_ENGINEER_ROLE) {
      await persistHarnessEngineerSession(deps.fs, repoRoot, session);
    }
  }

  async function notifyHarnessUpdatedForSession(
    repoRoot: string,
    session: RoleSessionRecord
  ): Promise<RoleSessionRecord> {
    const runtimeSession = deps.runtime.getSession(session.id);
    if (!runtimeSession || runtimeSession.status !== "running") {
      throw new VcmError({
        code: "SESSION_NOT_RUNNING",
        message: `${session.role} must be running before VCM can notify it about harness updates.`,
        statusCode: 409,
        hint: "Resume or restart the role to load the latest harness settings."
      });
    }

    const currentRevision = await readCurrentHarnessRevision(repoRoot);
    const timestamp = now();
    await submitTerminalInput(deps.runtime, session.id, buildHarnessRefreshPrompt(session.role));

    const updated: RoleSessionRecord = {
      ...session,
      harnessRevision: currentRevision,
      harnessCurrentRevision: currentRevision,
      harnessOutdated: false,
      lastHarnessNotifyAt: timestamp,
      updatedAt: timestamp
    };
    deps.registry.upsert(normalizeProjectScopedRecordForPersistence(updated));
    await persistNotifiedHarnessSession(repoRoot, updated);
    return withHarnessRevisionView(repoRoot, updated);
  }

  async function persistNotifiedHarnessSession(
    repoRoot: string,
    session: RoleSessionRecord
  ): Promise<void> {
    if (session.role === TRANSLATOR_ROLE) {
      await persistTranslatorSession(deps.fs, repoRoot, {
        ...session,
        taskSlug: PROJECT_TRANSLATOR_SCOPE
      });
      return;
    }
    if (session.role === HARNESS_ENGINEER_ROLE) {
      await persistHarnessEngineerSession(deps.fs, repoRoot, {
        ...session,
        taskSlug: PROJECT_HARNESS_ENGINEER_SCOPE
      });
      return;
    }

    const config = await deps.projectService.loadConfig(repoRoot);
    const task = await deps.taskService.loadTask(repoRoot, session.taskSlug);
    await persistRoleSessionRecord(deps.fs, repoRoot, getTaskRuntimeRepoRoot(task), config.stateRoot, session);
  }

  return {
    startProjectTranslatorSession(repoRoot, input = {}) {
      return launchProjectTranslatorSession(repoRoot, input, "fresh");
    },
    resumeProjectTranslatorSession(repoRoot, input = {}) {
      return launchProjectTranslatorSession(repoRoot, input, "resume");
    },
    async stopProjectTranslatorSession(repoRoot) {
      const existing = await this.getProjectTranslatorSession(repoRoot);
      if (!existing) {
        throw new VcmError({
          code: "SESSION_MISSING",
          message: "Translator session has not been started.",
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
      await persistTranslatorSession(deps.fs, repoRoot, updated);
      return updated;
    },
    async moveProjectTranslatorSessionToSafeCwd(repoRoot) {
      const existing = await this.getProjectTranslatorSession(repoRoot);
      if (!existing) {
        throw new VcmError({
          code: "SESSION_MISSING",
          message: "Translator session has not been started.",
          statusCode: 404
        });
      }
      if (samePath(existing.cwd, repoRoot)) {
        return existing;
      }
      return withHarnessRevisionView(
        repoRoot,
        await resumeProjectToolSessionAtCwd(repoRoot, {
          ...existing,
          taskSlug: PROJECT_TRANSLATOR_SCOPE
        }, repoRoot)
      );
    },
    async restartProjectTranslatorSession(repoRoot, input = {}) {
      const existing = await this.getProjectTranslatorSession(repoRoot);
      if (!existing) {
        return launchProjectTranslatorSession(repoRoot, input, "fresh");
      }

      if (deps.runtime.getSession(existing.id)) {
        await deps.runtime.stop(existing.id);
      }
      deps.registry.remove(existing.id);
      await clearPersistedTranslatorSession(deps.fs, repoRoot);

      return launchProjectTranslatorSession(repoRoot, input, "fresh");
    },
    async getProjectTranslatorSession(repoRoot) {
      const record = getRegisteredProjectTranslatorSession(deps.registry, deps.runtime)
        ?? await loadPersistedTranslatorSession(deps.fs, repoRoot);
      const view = toRoleSessionRecordView(record, deps.runtime);
      return view ? withHarnessRevisionView(repoRoot, view) : undefined;
    },
    async ensureProjectTranslatorSession(repoRoot, input = {}) {
      const existing = await this.getProjectTranslatorSession(repoRoot);
      if (existing?.status === "running") {
        if (input.taskSlug) {
          return this.resumeProjectTranslatorSession(repoRoot, {
            taskSlug: input.taskSlug,
            permissionMode: input.permissionMode ?? existing.permissionMode,
            model: input.model ?? existing.model,
            effort: input.effort ?? existing.effort,
            cols: input.cols,
            rows: input.rows
          });
        }
        return existing;
      }
      if (existing?.claudeSessionId) {
        return this.resumeProjectTranslatorSession(repoRoot, {
          taskSlug: input.taskSlug,
          permissionMode: input.permissionMode ?? existing.permissionMode,
          model: input.model ?? existing.model,
          effort: input.effort ?? existing.effort,
          cols: input.cols,
          rows: input.rows
        });
      }
      return this.startProjectTranslatorSession(repoRoot, input);
    },
    async recordProjectTranslatorHookEvent(repoRoot, input) {
      const current = await this.getProjectTranslatorSession(repoRoot);
      if (!current) {
        return undefined;
      }

      const timestamp = now();
      const isTurnEnd = isTurnEndHook(input.eventName);
      const isCompact = isCompactHook(input.eventName);
      const sessionIdentity = nextHookSessionIdentity(current, input);
      const updated: RoleSessionRecord = {
        ...current,
        claudeSessionId: sessionIdentity.claudeSessionId,
        transcriptPath: sessionIdentity.transcriptPath,
        cwd: input.cwd ?? current.cwd,
        activityStatus: isTurnEnd ? "idle" : isCompact ? current.activityStatus : "running",
        lastHookEventAt: timestamp,
        lastTurnEndedAt: isTurnEnd ? timestamp : current.lastTurnEndedAt,
        lastTurnStartedAt: isTurnEnd || isCompact ? current.lastTurnStartedAt : timestamp,
        lastCompactAt: isCompact ? timestamp : current.lastCompactAt,
        updatedAt: timestamp
      };
      deps.registry.upsert(updated);
      await persistTranslatorSession(deps.fs, repoRoot, updated);
      return updated;
    },
    async notifyProjectTranslatorHarnessUpdated(repoRoot) {
      const current = await this.getProjectTranslatorSession(repoRoot);
      if (!current) {
        throw new VcmError({
          code: "SESSION_MISSING",
          message: "Translator session has not been started.",
          statusCode: 404
        });
      }
      return notifyHarnessUpdatedForSession(repoRoot, current);
    },
    startProjectHarnessEngineerSession(repoRoot, input = {}) {
      return launchProjectHarnessEngineerSession(repoRoot, input, "fresh");
    },
    resumeProjectHarnessEngineerSession(repoRoot, input = {}) {
      return launchProjectHarnessEngineerSession(repoRoot, input, "resume");
    },
    async stopProjectHarnessEngineerSession(repoRoot) {
      const existing = await this.getProjectHarnessEngineerSession(repoRoot);
      if (!existing) {
        throw new VcmError({
          code: "SESSION_MISSING",
          message: "Harness Engineer session has not been started.",
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
      await persistHarnessEngineerSession(deps.fs, repoRoot, updated);
      return updated;
    },
    async moveProjectHarnessEngineerSessionToSafeCwd(repoRoot) {
      const existing = await this.getProjectHarnessEngineerSession(repoRoot);
      if (!existing) {
        throw new VcmError({
          code: "SESSION_MISSING",
          message: "Harness Engineer session has not been started.",
          statusCode: 404
        });
      }
      if (samePath(existing.cwd, repoRoot)) {
        return existing;
      }
      return withHarnessRevisionView(
        repoRoot,
        await resumeProjectToolSessionAtCwd(repoRoot, {
          ...existing,
          taskSlug: PROJECT_HARNESS_ENGINEER_SCOPE
        }, repoRoot)
      );
    },
    async restartProjectHarnessEngineerSession(repoRoot, input = {}) {
      const existing = await this.getProjectHarnessEngineerSession(repoRoot);
      if (!existing) {
        return launchProjectHarnessEngineerSession(repoRoot, input, "fresh");
      }

      if (deps.runtime.getSession(existing.id)) {
        await deps.runtime.stop(existing.id);
      }
      deps.registry.remove(existing.id);
      await clearPersistedHarnessEngineerSession(deps.fs, repoRoot);

      return launchProjectHarnessEngineerSession(repoRoot, input, "fresh");
    },
    async getProjectHarnessEngineerSession(repoRoot) {
      const record = getRegisteredProjectHarnessEngineerSession(deps.registry, deps.runtime)
        ?? await loadPersistedHarnessEngineerSession(deps.fs, repoRoot);
      const view = toRoleSessionRecordView(record, deps.runtime);
      return view ? withHarnessRevisionView(repoRoot, view) : undefined;
    },
    async ensureProjectHarnessEngineerSession(repoRoot, input = {}) {
      const existing = await this.getProjectHarnessEngineerSession(repoRoot);
      if (existing?.status === "running") {
        if (input.taskSlug) {
          return this.resumeProjectHarnessEngineerSession(repoRoot, {
            taskSlug: input.taskSlug,
            permissionMode: input.permissionMode ?? existing.permissionMode,
            model: input.model ?? existing.model,
            effort: input.effort ?? existing.effort,
            cols: input.cols,
            rows: input.rows
          });
        }
        return existing;
      }
      if (existing?.claudeSessionId) {
        return this.resumeProjectHarnessEngineerSession(repoRoot, {
          taskSlug: input.taskSlug,
          permissionMode: input.permissionMode ?? existing.permissionMode,
          model: input.model ?? existing.model,
          effort: input.effort ?? existing.effort,
          cols: input.cols,
          rows: input.rows
        });
      }
      return this.startProjectHarnessEngineerSession(repoRoot, input);
    },
    async recordProjectHarnessEngineerHookEvent(repoRoot, input) {
      const current = await this.getProjectHarnessEngineerSession(repoRoot);
      if (!current) {
        return undefined;
      }

      const timestamp = now();
      const isTurnEnd = isTurnEndHook(input.eventName);
      const isCompact = isCompactHook(input.eventName);
      const sessionIdentity = nextHookSessionIdentity(current, input);
      const updated: RoleSessionRecord = {
        ...current,
        claudeSessionId: sessionIdentity.claudeSessionId,
        transcriptPath: sessionIdentity.transcriptPath,
        cwd: input.cwd ?? current.cwd,
        activityStatus: isTurnEnd ? "idle" : isCompact ? current.activityStatus : "running",
        lastHookEventAt: timestamp,
        lastTurnEndedAt: isTurnEnd ? timestamp : current.lastTurnEndedAt,
        lastTurnStartedAt: isTurnEnd || isCompact ? current.lastTurnStartedAt : timestamp,
        lastCompactAt: isCompact ? timestamp : current.lastCompactAt,
        updatedAt: timestamp
      };
      deps.registry.upsert(updated);
      await persistHarnessEngineerSession(deps.fs, repoRoot, updated);
      return updated;
    },
    async notifyProjectHarnessEngineerHarnessUpdated(repoRoot) {
      const current = await this.getProjectHarnessEngineerSession(repoRoot);
      if (!current) {
        throw new VcmError({
          code: "SESSION_MISSING",
          message: "Harness Engineer session has not been started.",
          statusCode: 404
        });
      }
      return notifyHarnessUpdatedForSession(repoRoot, current);
    },
    startRoleSession(repoRoot, taskSlug, role, input = {}) {
      if (role === TRANSLATOR_ROLE) {
        return this.startProjectTranslatorSession(repoRoot, { ...input, taskSlug });
      }
      if (role === HARNESS_ENGINEER_ROLE) {
        return this.startProjectHarnessEngineerSession(repoRoot, { ...input, taskSlug });
      }
      return launchRoleSession(repoRoot, taskSlug, role, input, "fresh");
    },
    resumeRoleSession(repoRoot, taskSlug, role, input = {}) {
      if (role === TRANSLATOR_ROLE) {
        return this.resumeProjectTranslatorSession(repoRoot, { ...input, taskSlug });
      }
      if (role === HARNESS_ENGINEER_ROLE) {
        return this.resumeProjectHarnessEngineerSession(repoRoot, { ...input, taskSlug });
      }
      return launchRoleSession(repoRoot, taskSlug, role, input, "resume");
    },
    async stopRoleSession(repoRoot, taskSlug, role) {
      if (role === TRANSLATOR_ROLE) {
        void taskSlug;
        return this.stopProjectTranslatorSession(repoRoot);
      }
      if (role === HARNESS_ENGINEER_ROLE) {
        void taskSlug;
        return this.stopProjectHarnessEngineerSession(repoRoot);
      }
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
      if (role === TRANSLATOR_ROLE) {
        return this.restartProjectTranslatorSession(repoRoot, { ...input, taskSlug });
      }
      if (role === HARNESS_ENGINEER_ROLE) {
        return this.restartProjectHarnessEngineerSession(repoRoot, { ...input, taskSlug });
      }
      const existing = await this.getRoleSession(repoRoot, taskSlug, role);
      if (!existing) {
        return launchRoleSession(repoRoot, taskSlug, role, input, "fresh");
      }

      if (deps.runtime.getSession(existing.id)) {
        await deps.runtime.stop(existing.id);
      }
      deps.registry.remove(existing.id);
      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, taskSlug);
      await clearPersistedRoleSessionRecord(
        deps.fs,
        getTaskRuntimeRepoRoot(task),
        config.stateRoot,
        taskSlug,
        role,
        now()
      );

      return launchRoleSession(repoRoot, taskSlug, role, input, "fresh");
    },
    async getRoleSession(repoRoot, taskSlug, role) {
      if (role === TRANSLATOR_ROLE) {
        void taskSlug;
        return this.getProjectTranslatorSession(repoRoot);
      }
      if (role === HARNESS_ENGINEER_ROLE) {
        void taskSlug;
        return this.getProjectHarnessEngineerSession(repoRoot);
      }
      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      const record = getRegisteredRoleSession(deps.registry, deps.runtime, taskSlug, role)
        ?? await loadPersistedRoleRecordForRole(deps.fs, repoRoot, taskRepoRoot, config.stateRoot, taskSlug, role);
      if (!record) {
        return undefined;
      }

      const view = toRoleSessionRecordView(record, deps.runtime);
      return view ? withHarnessRevisionView(repoRoot, view) : undefined;
    },
    async listRoleSessions(repoRoot, taskSlug) {
      const sessions: RoleSessionRecord[] = [];
      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      const persistedTaskSession = await loadPersistedTaskSessionRecord(deps.fs, taskRepoRoot, config.stateRoot, taskSlug);
      for (const role of VCM_ROLE_NAMES) {
        const record = deps.registry.getByRole(taskSlug, role)
          ?? normalizePersistedRoleRecord(persistedTaskSession?.roles[role]?.record);
        const session = toRoleSessionRecordView(
          record,
          deps.runtime
        );
        if (session) {
          sessions.push(session);
        }
      }
      return Promise.all(sessions.map((session) => withHarnessRevisionView(repoRoot, session)));
    },
    async notifyRoleHarnessUpdated(repoRoot, taskSlug, role) {
      const current = await this.getRoleSession(repoRoot, taskSlug, role);
      if (!current) {
        throw new VcmError({
          code: "SESSION_MISSING",
          message: `${role} session has not been started.`,
          statusCode: 404
        });
      }
      return notifyHarnessUpdatedForSession(repoRoot, current);
    },
    async recordRoleHookEvent(repoRoot, input) {
      if (input.role === TRANSLATOR_ROLE) {
        void input.taskSlug;
        return this.recordProjectTranslatorHookEvent(repoRoot, {
          eventName: input.eventName,
          sessionId: input.sessionId,
          transcriptPath: input.transcriptPath,
          cwd: input.cwd
        });
      }
      if (input.role === HARNESS_ENGINEER_ROLE) {
        void input.taskSlug;
        return this.recordProjectHarnessEngineerHookEvent(repoRoot, {
          eventName: input.eventName,
          sessionId: input.sessionId,
          transcriptPath: input.transcriptPath,
          cwd: input.cwd
        });
      }
      const current = await this.getRoleSession(repoRoot, input.taskSlug, input.role);
      if (!current || (!input.allowSessionMismatch && !matchesRoleHookSession(current, input))) {
        return undefined;
      }

      const timestamp = now();
      const isTurnEnd = isTurnEndHook(input.eventName);
      const isCompact = isCompactHook(input.eventName);
      const sessionIdentity = nextHookSessionIdentity(current, input);
      const updated: RoleSessionRecord = {
        ...current,
        claudeSessionId: sessionIdentity.claudeSessionId,
        transcriptPath: sessionIdentity.transcriptPath,
        cwd: input.cwd ?? current.cwd,
        activityStatus: isTurnEnd ? "idle" : isCompact ? current.activityStatus : "running",
        lastHookEventAt: timestamp,
        lastTurnEndedAt: isTurnEnd ? timestamp : current.lastTurnEndedAt,
        lastTurnStartedAt: isTurnEnd || isCompact ? current.lastTurnStartedAt : timestamp,
        lastCompactAt: isCompact ? timestamp : current.lastCompactAt,
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

function matchesRoleHookSession(record: RoleSessionRecord, input: RecordRoleHookEventInput): boolean {
  if (!record.claudeSessionId && !record.transcriptPath) {
    return input.eventName === "UserPromptSubmit";
  }
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

function nextHookSessionIdentity(
  current: RoleSessionRecord,
  input: {
    eventName: ClaudeHookEventName;
    sessionId?: string;
    transcriptPath?: string;
  }
): Pick<RoleSessionRecord, "claudeSessionId" | "transcriptPath"> {
  const canRecordFirstClaudeSessionId = Boolean(
    !current.claudeSessionId &&
    input.eventName === "UserPromptSubmit" &&
    input.sessionId
  );
  const hasConfirmedClaudeSessionId = Boolean(current.claudeSessionId || canRecordFirstClaudeSessionId);
  return {
    claudeSessionId: canRecordFirstClaudeSessionId
      ? input.sessionId ?? current.claudeSessionId
      : current.claudeSessionId,
    transcriptPath: hasConfirmedClaudeSessionId
      ? input.transcriptPath ?? current.transcriptPath
      : current.transcriptPath
  };
}

function isTurnEndHook(eventName: ClaudeHookEventName): boolean {
  return eventName === "Stop" || eventName === "StopFailure";
}

function isCompactHook(eventName: ClaudeHookEventName): boolean {
  return eventName === "PostCompact";
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

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function assertSafeCwdTarget(targetCwd: string): void {
  if (!targetCwd.trim() || /[\r\n]/.test(targetCwd)) {
    throw new VcmError({
      code: "SESSION_CWD_INVALID",
      message: "Session cwd target is invalid.",
      statusCode: 400
    });
  }
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
  if (role !== TRANSLATOR_ROLE && role !== HARNESS_ENGINEER_ROLE) {
    return registry.getByRole(taskSlug, role);
  }

  const candidates = registry.list().filter((session) => session.role === role);
  const live = candidates.find((session) => runtime.getSession(session.id)?.status === "running");
  const scoped = live
    ?? candidates.find((session) => session.taskSlug === taskSlug)
    ?? candidates.sort(compareSessionUpdatedAtDesc)[0];
  return scopeProjectRoleSession(scoped, taskSlug);
}

function getRegisteredProjectTranslatorSession(
  registry: SessionRegistry,
  runtime: TerminalRuntime
): RoleSessionRecord | undefined {
  const candidates = registry.list().filter((session) => session.role === TRANSLATOR_ROLE);
  const live = candidates.find((session) => runtime.getSession(session.id)?.status === "running");
  return live ?? candidates.sort(compareSessionUpdatedAtDesc)[0];
}

function getRegisteredProjectHarnessEngineerSession(
  registry: SessionRegistry,
  runtime: TerminalRuntime
): RoleSessionRecord | undefined {
  const candidates = registry.list().filter((session) => session.role === HARNESS_ENGINEER_ROLE);
  const live = candidates.find((session) => runtime.getSession(session.id)?.status === "running");
  return live ?? candidates.sort(compareSessionUpdatedAtDesc)[0];
}

function compareSessionUpdatedAtDesc(left: RoleSessionRecord, right: RoleSessionRecord): number {
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
}

function scopeProjectRoleSession(record: RoleSessionRecord | undefined, taskSlug: string): RoleSessionRecord | undefined {
  if (!record || (record.role !== TRANSLATOR_ROLE && record.role !== HARNESS_ENGINEER_ROLE)) {
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
  if (role === TRANSLATOR_ROLE) {
    void taskSlug;
    return loadPersistedTranslatorSession(fs, baseRepoRoot);
  }
  if (role === HARNESS_ENGINEER_ROLE) {
    void taskSlug;
    return loadPersistedHarnessEngineerSession(fs, baseRepoRoot);
  }

  return loadPersistedRoleRecord(fs, taskRepoRoot, stateRoot, taskSlug, role);
}

async function loadPersistedTranslatorSession(
  fs: FileSystemAdapter,
  repoRoot: string
): Promise<RoleSessionRecord | undefined> {
  const sessionPath = resolveRepoPath(repoRoot, TRANSLATOR_SESSION_PATH);
  if (!(await fs.pathExists(sessionPath))) {
    return undefined;
  }

  const payload = await fs.readJson<ProjectRoleSessionFile | RoleSessionRecord>(sessionPath);
  const record = normalizePersistedRoleRecord(isProjectRoleSessionFile(payload) ? payload.record : payload);
  if (!record) {
    return undefined;
  }
  return {
    ...record,
    taskSlug: PROJECT_TRANSLATOR_SCOPE
  };
}

async function loadPersistedHarnessEngineerSession(
  fs: FileSystemAdapter,
  repoRoot: string
): Promise<RoleSessionRecord | undefined> {
  const sessionPath = resolveRepoPath(repoRoot, HARNESS_ENGINEER_SESSION_PATH);
  if (!(await fs.pathExists(sessionPath))) {
    return undefined;
  }

  const payload = await fs.readJson<ProjectRoleSessionFile | RoleSessionRecord>(sessionPath);
  const record = normalizePersistedRoleRecord(isProjectRoleSessionFile(payload) ? payload.record : payload);
  if (!record) {
    return undefined;
  }
  return {
    ...record,
    taskSlug: PROJECT_HARNESS_ENGINEER_SCOPE
  };
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
        model: normalizeClaudeModel(record.model),
        effort: normalizeClaudeEffort(record.effort)
      }
    : undefined;
}

function normalizeProjectScopedRecordForPersistence(record: RoleSessionRecord): RoleSessionRecord {
  if (record.role === TRANSLATOR_ROLE) {
    return {
      ...record,
      taskSlug: PROJECT_TRANSLATOR_SCOPE
    };
  }
  if (record.role === HARNESS_ENGINEER_ROLE) {
    return {
      ...record,
      taskSlug: PROJECT_HARNESS_ENGINEER_SCOPE
    };
  }
  return record;
}

function normalizeHarnessRevision(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function buildHarnessRefreshPrompt(role: RoleName): string {
  return [
    "VCM harness was updated.",
    "Before continuing, re-read the current project `CLAUDE.md`, your agent definition, and any relevant VCM skills from disk.",
    `Your agent definition is \`.claude/agents/${role}.md\` when that file exists.`,
    "Follow the latest rules from disk. Briefly acknowledge when ready."
  ].join("\n");
}

async function persistTaskSession(
  fs: FileSystemAdapter,
  repoRoot: string,
  stateRoot: string,
  session: RoleSessionRecord
): Promise<void> {
  if (!hasConfirmedClaudeSessionId(session)) {
    return;
  }
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

async function clearPersistedRoleSessionRecord(
  fs: FileSystemAdapter,
  repoRoot: string,
  stateRoot: string,
  taskSlug: string,
  role: RoleName,
  updatedAt: string
): Promise<void> {
  const sessionPath = getTaskSessionPath(repoRoot, stateRoot, taskSlug);
  const current = await fs.pathExists(sessionPath)
    ? await fs.readJson<TaskSessionRecord>(sessionPath)
    : createEmptyTaskSessionRecord(taskSlug, updatedAt);

  await fs.writeJsonAtomic(sessionPath, {
    ...current,
    updatedAt,
    roles: {
      ...current.roles,
      [role]: {
        id: null,
        status: "not_started"
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
  if (session.role === TRANSLATOR_ROLE) {
    await persistTranslatorSession(fs, baseRepoRoot, session);
    return;
  }
  if (session.role === HARNESS_ENGINEER_ROLE) {
    await persistHarnessEngineerSession(fs, baseRepoRoot, session);
    return;
  }

  await persistTaskSession(fs, taskRepoRoot, stateRoot, session);
}

async function persistTranslatorSession(
  fs: FileSystemAdapter,
  repoRoot: string,
  session: RoleSessionRecord
): Promise<void> {
  if (!hasConfirmedClaudeSessionId(session)) {
    return;
  }
  await fs.writeJsonAtomic<ProjectRoleSessionFile>(
    resolveRepoPath(repoRoot, TRANSLATOR_SESSION_PATH),
    {
      version: 1,
      role: session.role,
      updatedAt: session.updatedAt,
      record: {
        ...session,
        taskSlug: PROJECT_TRANSLATOR_SCOPE
      }
    }
  );
}

async function clearPersistedTranslatorSession(
  fs: FileSystemAdapter,
  repoRoot: string
): Promise<void> {
  await removePersistedProjectSessionFile(fs, repoRoot, TRANSLATOR_SESSION_PATH);
}

async function persistHarnessEngineerSession(
  fs: FileSystemAdapter,
  repoRoot: string,
  session: RoleSessionRecord
): Promise<void> {
  if (!hasConfirmedClaudeSessionId(session)) {
    return;
  }
  await fs.writeJsonAtomic<ProjectRoleSessionFile>(
    resolveRepoPath(repoRoot, HARNESS_ENGINEER_SESSION_PATH),
    {
      version: 1,
      role: session.role,
      updatedAt: session.updatedAt,
      record: {
        ...session,
        taskSlug: PROJECT_HARNESS_ENGINEER_SCOPE
      }
    }
  );
}

async function clearPersistedHarnessEngineerSession(
  fs: FileSystemAdapter,
  repoRoot: string
): Promise<void> {
  await removePersistedProjectSessionFile(fs, repoRoot, HARNESS_ENGINEER_SESSION_PATH);
}

async function removePersistedProjectSessionFile(
  fs: FileSystemAdapter,
  repoRoot: string,
  relativePath: string
): Promise<void> {
  const sessionPath = resolveRepoPath(repoRoot, relativePath);
  if (!(await fs.pathExists(sessionPath))) {
    return;
  }
  if (!fs.removePath) {
    throw new VcmError({
      code: "SESSION_CLEAR_UNAVAILABLE",
      message: "VCM cannot clear the persisted Claude session file in this runtime.",
      statusCode: 500,
      hint: `Remove ${relativePath} manually before restarting the role.`
    });
  }
  await fs.removePath(sessionPath, { force: true });
}

function isProjectRoleSessionFile(value: ProjectRoleSessionFile | RoleSessionRecord): value is ProjectRoleSessionFile {
  return "record" in value && typeof value.record === "object" && value.record !== null;
}

function hasConfirmedClaudeSessionId(session: RoleSessionRecord): boolean {
  return session.claudeSessionId.trim().length > 0;
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
  if (value === "plan") {
    return "plan";
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

function formatClaudeCdCommand(targetCwd: string): string {
  // Claude Code's `/cd` slash command takes the literal remainder of the line as
  // the path, so the target must NOT be wrapped in quotes (quotes are taken as part
  // of the path and the cd fails). Paths with spaces are still fine unquoted; a
  // newline is the only unsafe character and is rejected by assertSafeCwdTarget.
  return `/cd ${targetCwd}`;
}
