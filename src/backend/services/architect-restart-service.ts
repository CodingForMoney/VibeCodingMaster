import path from "node:path";
import type { VcmRoleMessage } from "../../shared/types/message.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import { resolveRepoPath, type FileSystemAdapter } from "../adapters/filesystem.js";
import { VcmError } from "../errors.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";
import type { AppSettingsService } from "./app-settings-service.js";
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
  status: "scheduled";
  memoryCandidatePath?: string;
}

export interface ArchitectRestartService {
  schedule(repoRoot: string, taskSlug: string): Promise<ArchitectRestartScheduleResult>;
  recordArchitectStop(repoRoot: string, taskSlug: string, sessionId: string): Promise<void>;
  recordRouteDelivered(repoRoot: string, taskSlug: string, message: VcmRoleMessage): Promise<void>;
  recordRouteAccepted(repoRoot: string, taskSlug: string, message: VcmRoleMessage): Promise<void>;
  recordArchitectureGateDisposition(repoRoot: string, taskSlug: string, accepted: boolean): Promise<void>;
  clear(repoRoot: string, taskSlug: string): void;
}

export interface ArchitectRestartServiceDeps {
  fs: FileSystemAdapter;
  taskService: Pick<TaskService, "loadTask">;
  sessionService: Pick<SessionService, "getRoleSession" | "restartRoleSession">;
  appSettings: Pick<AppSettingsService, "getPreferences">;
}

interface PendingArchitectRestart {
  repoRoot: string;
  taskSlug: string;
  sessionId: string;
  stopped: boolean;
  deliveredMessageId?: string;
  acceptedMessageId?: string;
  gateAccepted: boolean;
  executing: boolean;
  memoryCandidatePath?: string;
}

export function createArchitectRestartService(deps: ArchitectRestartServiceDeps): ArchitectRestartService {
  const pendingByTask = new Map<string, PendingArchitectRestart>();

  return {
    async schedule(repoRoot, taskSlug) {
      const session = await requireRunningArchitect(repoRoot, taskSlug);
      await requireCompletePlan(repoRoot, taskSlug);
      const memoryCandidatePath = (await deps.appSettings.getPreferences()).autoMemoryEnabled
        ? ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH
        : undefined;
      const task = await deps.taskService.loadTask(repoRoot, taskSlug);
      const candidatePath = resolveRepoPath(
        getTaskRuntimeRepoRoot(task),
        ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH
      );
      if (deps.fs.removePath) {
        await deps.fs.removePath(candidatePath, { force: true });
      } else if (await deps.fs.pathExists(candidatePath)) {
        await deps.fs.writeText(candidatePath, "");
      }
      const key = taskKey(repoRoot, taskSlug);
      const existing = pendingByTask.get(key);
      if (existing?.sessionId === session.id) {
        existing.stopped = false;
        existing.deliveredMessageId = undefined;
        existing.acceptedMessageId = undefined;
        existing.gateAccepted = false;
        existing.executing = false;
        existing.memoryCandidatePath = memoryCandidatePath;
        return {
          taskSlug,
          sessionId: session.id,
          status: "scheduled",
          ...(memoryCandidatePath ? { memoryCandidatePath } : {})
        };
      }
      pendingByTask.set(key, {
        repoRoot,
        taskSlug,
        sessionId: session.id,
        stopped: false,
        gateAccepted: false,
        executing: false,
        memoryCandidatePath
      });
      return {
        taskSlug,
        sessionId: session.id,
        status: "scheduled",
        ...(memoryCandidatePath ? { memoryCandidatePath } : {})
      };
    },

    async recordArchitectStop(repoRoot, taskSlug, sessionId) {
      const pending = pendingByTask.get(taskKey(repoRoot, taskSlug));
      if (!pending || pending.sessionId !== sessionId) {
        return;
      }
      pending.stopped = true;
      await tryRestart(pending);
    },

    async recordRouteDelivered(repoRoot, taskSlug, message) {
      if (!isArchitectToPm(message)) {
        return;
      }
      const pending = pendingByTask.get(taskKey(repoRoot, taskSlug));
      if (!pending) {
        return;
      }
      pending.deliveredMessageId = message.id;
      await tryRestart(pending);
    },

    async recordRouteAccepted(repoRoot, taskSlug, message) {
      if (!isArchitectToPm(message)) {
        return;
      }
      const pending = pendingByTask.get(taskKey(repoRoot, taskSlug));
      if (!pending) {
        return;
      }
      pending.acceptedMessageId = message.id;
      await tryRestart(pending);
    },

    async recordArchitectureGateDisposition(repoRoot, taskSlug, accepted) {
      const pending = pendingByTask.get(taskKey(repoRoot, taskSlug));
      if (!pending) {
        return;
      }
      pending.gateAccepted = accepted;
      await tryRestart(pending);
    },

    clear(repoRoot, taskSlug) {
      pendingByTask.delete(taskKey(repoRoot, taskSlug));
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
    if (
      pending.executing
      || !pending.stopped
      || !pending.deliveredMessageId
      || pending.deliveredMessageId !== pending.acceptedMessageId
      || !pending.gateAccepted
    ) {
      return;
    }

    const session = await deps.sessionService.getRoleSession(
      pending.repoRoot,
      pending.taskSlug,
      ARCHITECT_ROLE
    );
    if (
      !session
      || session.id !== pending.sessionId
      || session.status !== "running"
      || session.activityStatus !== "idle"
    ) {
      return;
    }

    pending.executing = true;
    try {
      await requireCompletePlan(pending.repoRoot, pending.taskSlug);
      await requirePlanningMemoryCandidate(pending);
      await deps.sessionService.restartRoleSession(
        pending.repoRoot,
        pending.taskSlug,
        ARCHITECT_ROLE,
        {
          permissionMode: session.permissionMode,
          model: session.model,
          effort: session.effort,
          appendSystemPrompt: ARCHITECT_RESTORE_PROMPT
        }
      );
      pendingByTask.delete(taskKey(pending.repoRoot, pending.taskSlug));
    } catch {
      pending.executing = false;
    }
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
