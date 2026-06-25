import type { OneClickStartTaskResult } from "../../shared/types/task.js";
import { VcmError } from "../errors.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { MessageService } from "./message-service.js";
import type { ProjectService } from "./project-service.js";
import type { SessionService } from "./session-service.js";
import type { TaskService } from "./task-service.js";

/**
 * Backend owner of the one-click task start orchestration. This is the single
 * source of truth for: composing the canonical role roster (CORE roles plus
 * gate-reviewer when gate review is enabled), applying the launch-template
 * orchestration mode, and starting/resuming each role. Both the GUI endpoint
 * (`POST /api/tasks/:taskSlug/one-click-start`) and the mobile gateway call this
 * method so the two paths can no longer drift.
 *
 * It lives in its own service because the obvious homes create dependency cycles:
 * `runtime-coordinator-service` already depends on the gateway (which must call
 * this), and `session-service` cannot depend on `message-service`. This service
 * depends only on leaf services and nothing depends back on it except routes and
 * the gateway, so it stays cycle-free.
 */
export interface TaskLaunchService {
  /**
   * Compose and start the task's role roster.
   *
   * Behavior contract:
   * - Roster = CORE roles + gate-reviewer iff gate review is enabled for the task.
   * - Orchestration mode is set from the launch template (`auto`/`manual`).
   * - Per role: skip when already running, resume when a `claudeSessionId` exists,
   *   otherwise start; using the launch template's permissionMode/model/effort.
   * - `requireFreshStart: true` rejects with 409 when any role session already
   *   exists (the GUI one-click precondition); `false` is tolerant (gateway path
   *   on a freshly created task).
   * - On a per-role start/resume failure, throw `TASK_ONE_CLICK_PARTIAL_START`
   *   (409) carrying the roles started so far and the role that failed; callers
   *   that need bespoke wording (gateway → `GATEWAY_TASK_PARTIAL_START`) rewrap it.
   */
  startTaskRoleSessions(repoRoot: string, input: StartTaskRoleSessionsInput): Promise<OneClickStartTaskResult>;
}

export interface StartTaskRoleSessionsInput {
  taskSlug: string;
  /** Reject when any role session already exists (GUI one-click precondition). */
  requireFreshStart: boolean;
}

export interface TaskLaunchServiceDeps {
  projectService: Pick<ProjectService, "loadConfig">;
  taskService: Pick<TaskService, "loadTask">;
  appSettings: Pick<AppSettingsService, "getPreferences" | "getGateReviewSettings">;
  sessionService: Pick<SessionService, "getRoleSession" | "startRoleSession" | "resumeRoleSession" | "listRoleSessions">;
  messageService: Pick<MessageService, "updateOrchestrationState">;
}

export function createTaskLaunchService(deps: TaskLaunchServiceDeps): TaskLaunchService {
  return {
    async startTaskRoleSessions(repoRoot, input) {
      // VCM:CODE SCF-102
      void deps;
      void repoRoot;
      void input;
      throw new VcmError({
        code: "NOT_IMPLEMENTED",
        message: "task-launch-service.startTaskRoleSessions is not implemented yet.",
        statusCode: 501
      });
    }
  };
}
