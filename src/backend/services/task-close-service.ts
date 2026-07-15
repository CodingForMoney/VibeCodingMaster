import { VCM_ROLE_NAMES } from "../../shared/constants.js";
import type { CleanupTaskResult } from "../../shared/types/task.js";
import { VcmError } from "../errors.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";
import type { TranslationService } from "./translation-service.js";

export interface TaskCloseService {
  closeTask(repoRoot: string, taskSlug: string): Promise<CleanupTaskResult>;
}

export interface TaskCloseServiceDeps {
  taskService: Pick<TaskService, "markTaskCleaned" | "cleanupTask">;
  sessionService: Pick<
    SessionService,
    | "listRoleSessions"
    | "stopRoleSession"
    | "moveProjectTranslatorSessionToSafeCwd"
    | "moveProjectHarnessEngineerSessionToSafeCwd"
    | "stopProjectTranslatorSession"
    | "stopProjectHarnessEngineerSession"
  >;
  translationService: Pick<TranslationService, "stopTask">;
  roundService: Pick<RoundService, "stopTask">;
}

export function createTaskCloseService(deps: TaskCloseServiceDeps): TaskCloseService {
  return {
    async closeTask(repoRoot, taskSlug) {
      const task = await deps.taskService.markTaskCleaned(repoRoot, taskSlug);
      const warnings: string[] = [];

      await stopTaskRoleSessions(repoRoot, taskSlug, warnings);
      await moveOrStopProjectToolSession(
        "Translator",
        () => deps.sessionService.moveProjectTranslatorSessionToSafeCwd(repoRoot),
        () => deps.sessionService.stopProjectTranslatorSession(repoRoot),
        warnings
      );
      await moveOrStopProjectToolSession(
        "Harness Engineer",
        () => deps.sessionService.moveProjectHarnessEngineerSessionToSafeCwd(repoRoot),
        () => deps.sessionService.stopProjectHarnessEngineerSession(repoRoot),
        warnings
      );
      await bestEffort(
        "Unable to stop task translation runtime",
        () => deps.translationService.stopTask(getTaskRuntimeRepoRoot(task), taskSlug, { clearCache: true }),
        warnings
      );
      await bestEffort(
        "Unable to clear task round runtime",
        () => deps.roundService.stopTask(taskSlug),
        warnings
      );

      try {
        const result = await deps.taskService.cleanupTask(repoRoot, taskSlug);
        const combinedWarnings = [...warnings, ...(result.warnings ?? [])];
        return {
          ...result,
          warnings: combinedWarnings.length > 0 ? combinedWarnings : undefined
        };
      } catch (error) {
        warnings.push(`Task was closed, but resource cleanup did not finish: ${describeError(error)}`);
        return {
          taskSlug,
          taskClosed: true,
          worktreeRemoved: false,
          branchDeleted: false,
          stateRemoved: false,
          removedWorktreePath: null,
          removedStatePaths: [],
          deletedBranch: null,
          cleanedAt: task.cleanedAt ?? task.updatedAt,
          warnings
        };
      }
    }
  };

  async function stopTaskRoleSessions(repoRoot: string, taskSlug: string, warnings: string[]): Promise<void> {
    let sessions;
    try {
      sessions = await deps.sessionService.listRoleSessions(repoRoot, taskSlug);
    } catch (error) {
      warnings.push(`Unable to list task role sessions during close: ${describeError(error)}`);
      return;
    }

    for (const session of sessions) {
      if (session.status !== "running" || !VCM_ROLE_NAMES.some((role) => role === session.role)) {
        continue;
      }
      await bestEffort(
        `Unable to stop ${session.role} session`,
        () => deps.sessionService.stopRoleSession(repoRoot, taskSlug, session.role),
        warnings
      );
    }
  }
}

async function moveOrStopProjectToolSession(
  label: string,
  move: () => Promise<unknown>,
  stop: () => Promise<unknown>,
  warnings: string[]
): Promise<void> {
  try {
    await move();
  } catch (error) {
    if (isMissingSession(error)) {
      return;
    }
    warnings.push(`Unable to move ${label} session to the base repository: ${describeError(error)}`);
    try {
      await stop();
    } catch (stopError) {
      if (!isMissingSession(stopError)) {
        warnings.push(`Unable to stop ${label} session after cwd migration failed: ${describeError(stopError)}`);
      }
    }
  }
}

async function bestEffort(
  message: string,
  operation: () => Promise<unknown> | unknown,
  warnings: string[]
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    warnings.push(`${message}: ${describeError(error)}`);
  }
}

function isMissingSession(error: unknown): boolean {
  return error instanceof VcmError && error.code === "SESSION_MISSING";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
