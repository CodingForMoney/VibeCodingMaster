import path from "node:path";
import type {
  ArchitectRestartBlocker,
  ArchitectRestartState,
  ArchitectRestartStatus
} from "../../shared/types/architect-restart.js";
import type { VcmRoleMessage } from "../../shared/types/message.js";
import type {
  ClaudePermissionMode,
  RoleSessionRecord,
  SessionEffort,
  SessionModel
} from "../../shared/types/session.js";
import { resolveRepoPath, type FileSystemAdapter } from "../adapters/filesystem.js";
import { toVcmError, VcmError } from "../errors.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { ProjectService } from "./project-service.js";
import { ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH } from "./memory-review-paths.js";
import { validateMemoryProposal } from "./memory-proposal-validation.js";

const ARCHITECT_ROLE = "architect";
const PM_ROLE = "project-manager";
const COMPLETE_PLAN_PATTERN = /^Planning Result:\s*complete\s*$/im;

export const ARCHITECT_RESTORE_PROMPT = `This Architect session continues the current task after completed architecture planning.

Before performing any assigned work, read:
- .ai/vcm/handoffs/architecture-brief.md
- .ai/vcm/handoffs/architecture-evidence.md
- .ai/vcm/handoffs/architecture-plan.md
- the current scaffold commit and worktree state
- the latest Gate Review report when present

Treat the current artifacts and worktree as the source of truth. The architecture-plan Gate has accepted the current planning artifacts or VCM recorded an explicit Gate exception. Do not repeat the completed interview or planning work unless a later route explicitly reopens it.`;

export interface ArchitectRestartScheduleResult {
  taskSlug: string;
  sessionId: string;
  status: "scheduled" | "already_scheduled";
  memoryCandidatePath?: string;
}

export interface ArchitectRestartService {
  schedule(repoRoot: string, taskSlug: string): Promise<ArchitectRestartScheduleResult>;
  getState(repoRoot: string, taskSlug: string): ArchitectRestartState | null;
  recoverTask(repoRoot: string, taskSlug: string): Promise<void>;
  recordArchitectStop(repoRoot: string, taskSlug: string, sessionId: string): Promise<void>;
  recordRouteDelivered(repoRoot: string, taskSlug: string, message: VcmRoleMessage): Promise<void>;
  recordRouteAccepted(repoRoot: string, taskSlug: string, message: VcmRoleMessage): Promise<void>;
  recordArchitectureGateDisposition(repoRoot: string, taskSlug: string, accepted: boolean): Promise<void>;
  recordReplacementPromptSubmitted(repoRoot: string, taskSlug: string, sessionId: string): Promise<void>;
  clear(repoRoot: string, taskSlug: string): Promise<void>;
}

export interface ArchitectRestartServiceDeps {
  fs: FileSystemAdapter;
  taskService: Pick<TaskService, "loadTask">;
  projectService: Pick<ProjectService, "loadConfig">;
  sessionService: Pick<
    SessionService,
    "getRoleSession" | "restartRoleSession"
  >;
  appSettings: Pick<AppSettingsService, "getPreferences">;
}

interface PendingArchitectRestart {
  version: 1;
  repoRoot: string;
  taskSlug: string;
  sourceSessionId: string;
  sourceClaudeSessionId?: string;
  stopped: boolean;
  deliveredMessageId?: string;
  acceptedMessageId?: string;
  gateAccepted: boolean;
  status: ArchitectRestartStatus;
  permissionMode: ClaudePermissionMode;
  model?: SessionModel;
  effort?: SessionEffort;
  replacementSessionId?: string;
  memoryCandidatePath?: string;
  blocker?: ArchitectRestartBlocker;
  updatedAt: string;
}

type StoredArchitectRestart = Omit<PendingArchitectRestart, "repoRoot">;

const ARCHITECT_RESTART_STATE_FILE = "architect-restart.json";

export function createArchitectRestartService(deps: ArchitectRestartServiceDeps): ArchitectRestartService {
  const pendingByTask = new Map<string, PendingArchitectRestart>();
  const operationsByTask = new Map<string, Promise<unknown>>();

  return {
    async schedule(repoRoot, taskSlug) {
      const key = taskKey(repoRoot, taskSlug);
      return withTaskLock(key, async () => {
        const session = await requireRunningArchitect(repoRoot, taskSlug);
        await requireCompletePlan(repoRoot, taskSlug);
        const existing = pendingByTask.get(key);
        if (existing?.status === "executing") {
          return {
            taskSlug,
            sessionId: existing.replacementSessionId ?? existing.sourceSessionId,
            status: "already_scheduled" as const,
            ...(existing.memoryCandidatePath
              ? { memoryCandidatePath: existing.memoryCandidatePath }
              : {})
          };
        }
        if (existing && isSourceSession(existing, session)) {
          if (existing.status === "blocked") {
            existing.status = "pending";
            existing.blocker = undefined;
            existing.sourceSessionId = session.id;
            existing.updatedAt = timestamp();
            await persistPending(existing);
            await tryRestart(existing);
            return scheduleResult(existing, "scheduled");
          }
          return scheduleResult(existing, "already_scheduled");
        }
        const memoryCandidatePath = (await deps.appSettings.getPreferences()).autoMemoryEnabled
          ? ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH
          : undefined;
        const pending: PendingArchitectRestart = {
          version: 1,
          repoRoot,
          taskSlug,
          sourceSessionId: session.id,
          ...(session.claudeSessionId ? { sourceClaudeSessionId: session.claudeSessionId } : {}),
          stopped: false,
          gateAccepted: false,
          status: "pending",
          permissionMode: session.permissionMode,
          model: session.model,
          effort: session.effort,
          memoryCandidatePath: existing?.memoryCandidatePath ?? memoryCandidatePath,
          updatedAt: timestamp()
        };
        pendingByTask.set(key, pending);
        await persistPending(pending);
        return scheduleResult(pending, "scheduled");
      });
    },

    getState(repoRoot, taskSlug) {
      const pending = pendingByTask.get(taskKey(repoRoot, taskSlug));
      if (!pending) {
        return null;
      }
      return {
        taskSlug: pending.taskSlug,
        sessionId: pending.replacementSessionId ?? pending.sourceSessionId,
        status: pending.status,
        ...(pending.memoryCandidatePath
          ? { memoryCandidatePath: pending.memoryCandidatePath }
          : {}),
        ...(pending.blocker ? { blocker: { ...pending.blocker } } : {})
      };
    },

    async recoverTask(repoRoot, taskSlug) {
      const key = taskKey(repoRoot, taskSlug);
      await withTaskLock(key, async () => {
        const stored = await loadPending(repoRoot, taskSlug);
        if (!stored) {
          pendingByTask.delete(key);
          return;
        }
        const pending: PendingArchitectRestart = { ...stored, repoRoot };
        pendingByTask.set(key, pending);
        const session = await deps.sessionService.getRoleSession(repoRoot, taskSlug, ARCHITECT_ROLE);
        if (pending.status === "executing") {
          if (isConfirmedReplacement(pending, session)) {
            await removePending(pending);
            return;
          }
          if (
            session?.status === "running"
            && pending.replacementSessionId === session.id
          ) {
            return;
          }
          await launchReplacement(pending);
          return;
        }
        if (pending.status === "pending" && restartPrerequisitesMet(pending)) {
          if (session?.status === "running") {
            await tryRestart(pending);
          } else {
            await launchReplacement(pending);
          }
        }
      });
    },

    async recordArchitectStop(repoRoot, taskSlug, sessionId) {
      const key = taskKey(repoRoot, taskSlug);
      await withTaskLock(key, async () => {
        const pending = pendingByTask.get(key);
        if (!pending || pending.status !== "pending") {
          return;
        }
        const session = await deps.sessionService.getRoleSession(repoRoot, taskSlug, ARCHITECT_ROLE);
        if (!session || session.id !== sessionId || !isSourceSession(pending, session)) {
          return;
        }
        pending.sourceSessionId = session.id;
        pending.stopped = true;
        pending.updatedAt = timestamp();
        await persistPending(pending);
        await tryRestart(pending);
      });
    },

    async recordRouteDelivered(repoRoot, taskSlug, message) {
      if (!isArchitectToPm(message)) {
        return;
      }
      const key = taskKey(repoRoot, taskSlug);
      await withTaskLock(key, async () => {
        const pending = pendingByTask.get(key);
        if (!pending || pending.status !== "pending") {
          return;
        }
        pending.deliveredMessageId = message.id;
        pending.updatedAt = timestamp();
        await persistPending(pending);
        await tryRestart(pending);
      });
    },

    async recordRouteAccepted(repoRoot, taskSlug, message) {
      if (!isArchitectToPm(message)) {
        return;
      }
      const key = taskKey(repoRoot, taskSlug);
      await withTaskLock(key, async () => {
        const pending = pendingByTask.get(key);
        if (!pending || pending.status !== "pending") {
          return;
        }
        pending.acceptedMessageId = message.id;
        pending.updatedAt = timestamp();
        await persistPending(pending);
        await tryRestart(pending);
      });
    },

    async recordArchitectureGateDisposition(repoRoot, taskSlug, accepted) {
      const key = taskKey(repoRoot, taskSlug);
      await withTaskLock(key, async () => {
        const pending = pendingByTask.get(key);
        if (!pending || pending.status !== "pending") {
          return;
        }
        pending.gateAccepted = accepted;
        pending.updatedAt = timestamp();
        await persistPending(pending);
        await tryRestart(pending);
      });
    },

    async recordReplacementPromptSubmitted(repoRoot, taskSlug, sessionId) {
      const key = taskKey(repoRoot, taskSlug);
      await withTaskLock(key, async () => {
        const pending = pendingByTask.get(key);
        if (!pending || pending.status !== "executing") {
          return;
        }
        const session = await deps.sessionService.getRoleSession(repoRoot, taskSlug, ARCHITECT_ROLE);
        if (
          !session
          || session.id !== sessionId
          || !session.claudeSessionId
          || (pending.replacementSessionId && pending.replacementSessionId !== session.id)
        ) {
          return;
        }
        await removePending(pending);
      });
    },

    async clear(repoRoot, taskSlug) {
      const key = taskKey(repoRoot, taskSlug);
      await withTaskLock(key, async () => {
        const pending = pendingByTask.get(key) ?? await loadPending(repoRoot, taskSlug);
        pendingByTask.delete(key);
        if (pending) {
          await removePending({ ...pending, repoRoot });
        }
      });
    }
  };

  async function requireRunningArchitect(repoRoot: string, taskSlug: string): Promise<RoleSessionRecord> {
    const session = await deps.sessionService.getRoleSession(repoRoot, taskSlug, ARCHITECT_ROLE);
    if (!session || session.status !== "running") {
      throw new VcmError({
        code: "ARCHITECT_SESSION_NOT_RUNNING",
        message: "Architect session is not running.",
        statusCode: 409
      });
    }
    return session;
  }

  async function requireCompletePlan(repoRoot: string, taskSlug: string): Promise<void> {
    const task = await deps.taskService.loadTask(repoRoot, taskSlug);
    const planPath = resolveRepoPath(
      getTaskRuntimeRepoRoot(task),
      path.posix.join(task.handoffDir, "architecture-plan.md")
    );
    if (!(await deps.fs.pathExists(planPath))) {
      throw incompletePlanError("architecture-plan.md does not exist.");
    }
    const content = await deps.fs.readText(planPath);
    if (!COMPLETE_PLAN_PATTERN.test(content)) {
      throw incompletePlanError("architecture-plan.md is not marked complete.");
    }
  }

  async function tryRestart(pending: PendingArchitectRestart): Promise<void> {
    if (pending.status !== "pending" || !restartPrerequisitesMet(pending)) {
      return;
    }

    const session = await deps.sessionService.getRoleSession(
      pending.repoRoot,
      pending.taskSlug,
      ARCHITECT_ROLE
    );
    if (!session || !isSourceSession(pending, session)) {
      await blockPending(pending, new VcmError({
        code: "ARCHITECT_RESTART_SESSION_UNAVAILABLE",
        message: "Architect restart is blocked because the scheduled Architect session no longer exists.",
        statusCode: 409
      }));
      return;
    }
    if (session.status !== "running") {
      await blockPending(pending, new VcmError({
        code: "ARCHITECT_RESTART_SESSION_NOT_RUNNING",
        message: "Architect restart is blocked because the scheduled Architect session is not running.",
        statusCode: 409
      }));
      return;
    }
    if (session.activityStatus !== "idle") {
      return;
    }
    pending.sourceSessionId = session.id;
    await launchReplacement(pending);
  }

  async function launchReplacement(pending: PendingArchitectRestart): Promise<void> {
    pending.status = "executing";
    pending.blocker = undefined;
    pending.updatedAt = timestamp();
    await persistPending(pending);
    try {
      await requireCompletePlan(pending.repoRoot, pending.taskSlug);
      await requirePlanningMemoryCandidate(pending);
      const replacement = await deps.sessionService.restartRoleSession(
        pending.repoRoot,
        pending.taskSlug,
        ARCHITECT_ROLE,
        {
          permissionMode: pending.permissionMode,
          model: pending.model,
          effort: pending.effort,
          appendSystemPrompt: ARCHITECT_RESTORE_PROMPT
        }
      );
      pending.replacementSessionId = replacement.id;
      pending.updatedAt = timestamp();
      await persistPending(pending);
    } catch (error) {
      await blockPending(pending, error);
    }
  }

  async function blockPending(pending: PendingArchitectRestart, error: unknown): Promise<void> {
    const normalized = toVcmError(error);
    pending.status = "blocked";
    pending.blocker = {
      code: normalized.code,
      message: normalized.message,
      blockedAt: timestamp()
    };
    pending.updatedAt = timestamp();
    await persistPending(pending);
  }

  function restartPrerequisitesMet(pending: PendingArchitectRestart): boolean {
    return Boolean(
      pending.stopped
      && pending.deliveredMessageId
      && pending.deliveredMessageId === pending.acceptedMessageId
      && pending.gateAccepted
    );
  }

  function isSourceSession(pending: PendingArchitectRestart, session: RoleSessionRecord): boolean {
    return session.id === pending.sourceSessionId
      || Boolean(
        pending.sourceClaudeSessionId
        && session.claudeSessionId
        && pending.sourceClaudeSessionId === session.claudeSessionId
      );
  }

  function isConfirmedReplacement(
    pending: PendingArchitectRestart,
    session: RoleSessionRecord | undefined
  ): boolean {
    return Boolean(
      session?.claudeSessionId
      && (
        (pending.replacementSessionId && session.id === pending.replacementSessionId)
        || !pending.sourceClaudeSessionId
        || session.claudeSessionId !== pending.sourceClaudeSessionId
      )
    );
  }

  function scheduleResult(
    pending: PendingArchitectRestart,
    status: ArchitectRestartScheduleResult["status"]
  ): ArchitectRestartScheduleResult {
    return {
      taskSlug: pending.taskSlug,
      sessionId: pending.replacementSessionId ?? pending.sourceSessionId,
      status,
      ...(pending.memoryCandidatePath ? { memoryCandidatePath: pending.memoryCandidatePath } : {})
    };
  }

  async function persistPending(pending: PendingArchitectRestart): Promise<void> {
    const { repoRoot: _repoRoot, ...stored } = pending;
    await deps.fs.writeJsonAtomic(await statePath(pending.repoRoot, pending.taskSlug), stored);
    pendingByTask.set(taskKey(pending.repoRoot, pending.taskSlug), pending);
  }

  async function loadPending(repoRoot: string, taskSlug: string): Promise<StoredArchitectRestart | undefined> {
    const target = await statePath(repoRoot, taskSlug);
    if (!(await deps.fs.pathExists(target))) {
      return undefined;
    }
    const stored = await deps.fs.readJson<StoredArchitectRestart>(target);
    if (
      stored.version !== 1
      || stored.taskSlug !== taskSlug
      || !stored.sourceSessionId
      || !["pending", "executing", "blocked"].includes(stored.status)
    ) {
      throw new VcmError({
        code: "ARCHITECT_RESTART_STATE_INVALID",
        message: `Architect restart state is invalid for task ${taskSlug}.`,
        statusCode: 500
      });
    }
    return stored;
  }

  async function removePending(pending: PendingArchitectRestart): Promise<void> {
    pendingByTask.delete(taskKey(pending.repoRoot, pending.taskSlug));
    const target = await statePath(pending.repoRoot, pending.taskSlug);
    if (await deps.fs.pathExists(target)) {
      await deps.fs.removePath?.(target, { force: true });
    }
  }

  async function statePath(repoRoot: string, taskSlug: string): Promise<string> {
    const [config, task] = await Promise.all([
      deps.projectService.loadConfig(repoRoot),
      deps.taskService.loadTask(repoRoot, taskSlug)
    ]);
    return resolveRepoPath(
      getTaskRuntimeRepoRoot(task),
      path.posix.join(config.stateRoot, ARCHITECT_RESTART_STATE_FILE)
    );
  }

  async function withTaskLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = operationsByTask.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    operationsByTask.set(key, current);
    try {
      return await current;
    } finally {
      if (operationsByTask.get(key) === current) {
        operationsByTask.delete(key);
      }
    }
  }

  function timestamp(): string {
    return new Date().toISOString();
  }

  async function requirePlanningMemoryCandidate(pending: PendingArchitectRestart): Promise<void> {
    if (!pending.memoryCandidatePath) {
      return;
    }
    const task = await deps.taskService.loadTask(pending.repoRoot, pending.taskSlug);
    const candidatePath = resolveRepoPath(getTaskRuntimeRepoRoot(task), pending.memoryCandidatePath);
    if (!(await deps.fs.pathExists(candidatePath))) {
      throw invalidMemoryCandidateError("the assigned candidate file does not exist.");
    }
    const content = await deps.fs.readText(candidatePath);
    const validationError = validateMemoryProposal(content);
    if (validationError) {
      throw invalidMemoryCandidateError(`the assigned candidate ${validationError}.`);
    }
  }
}

function isArchitectToPm(message: VcmRoleMessage): boolean {
  return message.fromRole === ARCHITECT_ROLE && message.toRole === PM_ROLE;
}

function taskKey(repoRoot: string, taskSlug: string): string {
  return `${repoRoot}\0${taskSlug}`;
}

function incompletePlanError(reason: string): VcmError {
  return new VcmError({
    code: "ARCHITECT_PLAN_INCOMPLETE",
    message: `Architect restart cannot be scheduled. ${reason}`,
    statusCode: 409
  });
}

function invalidMemoryCandidateError(reason: string): VcmError {
  return new VcmError({
    code: "ARCHITECT_MEMORY_CANDIDATE_INVALID",
    message: `Architect restart is waiting for its planning-session memory candidate because ${reason}`,
    statusCode: 409
  });
}
