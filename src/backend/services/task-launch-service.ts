import { CORE_VCM_ROLE_DEFINITIONS, GATE_REVIEWER_ROLE_DEFINITION, VCM_ROLE_NAMES } from "../../shared/constants.js";
import type { RoleLaunchTemplateEntry } from "../../shared/types/app-settings.js";
import type { VcmOrchestrationMode } from "../../shared/types/message.js";
import type { RoleName } from "../../shared/types/role.js";
import type { OneClickStartTaskResult } from "../../shared/types/task.js";
import { VcmError } from "../errors.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { MessageService } from "./message-service.js";
import type { ProjectService } from "./project-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";

const ONE_CLICK_SESSION_COLS = 100;
const ONE_CLICK_SESSION_ROWS = 28;

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

/**
 * Structured payload attached to a `TASK_ONE_CLICK_PARTIAL_START` error: the roles
 * already started before the failure plus the role that failed. Lets callers (e.g.
 * the gateway) rewrap the failure and lets tests assert no silent partial start.
 */
export interface OneClickStartPartialFailure {
  startedRoles: RoleName[];
  failedRole: RoleName;
}

export interface TaskLaunchServiceDeps {
  projectService: Pick<ProjectService, "loadConfig">;
  taskService: Pick<TaskService, "loadTask">;
  appSettings: Pick<AppSettingsService, "getPreferences" | "getGateReviewSettings">;
  sessionService: Pick<SessionService, "getRoleSession" | "startRoleSession" | "resumeRoleSession" | "listRoleSessions">;
  messageService: Pick<MessageService, "updateOrchestrationState">;
}

export function createTaskLaunchService(deps: TaskLaunchServiceDeps): TaskLaunchService {
  async function assertNoExistingRoleSessions(repoRoot: string, taskSlug: string): Promise<void> {
    const sessions = await deps.sessionService.listRoleSessions(repoRoot, taskSlug);
    if (sessions.some((session) => VCM_ROLE_NAMES.some((role) => role === session.role))) {
      throw new VcmError({
        code: "TASK_ONE_CLICK_REQUIRES_FRESH_START",
        message: "One-click start is only available before any role session has started.",
        statusCode: 409
      });
    }
  }

  async function applyOrchestrationMode(repoRoot: string, taskSlug: string, mode: VcmOrchestrationMode) {
    const config = await deps.projectService.loadConfig(repoRoot);
    const task = await deps.taskService.loadTask(repoRoot, taskSlug);
    return deps.messageService.updateOrchestrationState({
      repoRoot,
      stateRepoRoot: getTaskRuntimeRepoRoot(task),
      stateRoot: config.stateRoot,
      taskSlug,
      mode
    });
  }

  function composeRoleDefinitions(gateReviewerEnabled: boolean) {
    return [
      ...CORE_VCM_ROLE_DEFINITIONS,
      ...(gateReviewerEnabled ? [GATE_REVIEWER_ROLE_DEFINITION] : [])
    ];
  }

  // Skip a running role, resume one that has a prior Claude session, otherwise
  // start it fresh — using the launch-template entry's permission/model/effort.
  async function launchRole(
    repoRoot: string,
    taskSlug: string,
    role: RoleName,
    roleTemplate: RoleLaunchTemplateEntry
  ): Promise<void> {
    const sessionInput = {
      cols: ONE_CLICK_SESSION_COLS,
      rows: ONE_CLICK_SESSION_ROWS,
      permissionMode: roleTemplate.permissionMode,
      model: roleTemplate.model,
      effort: roleTemplate.effort
    };
    const existing = await deps.sessionService.getRoleSession(repoRoot, taskSlug, role);
    if (existing?.status === "running") {
      return;
    }
    if (existing?.claudeSessionId) {
      await deps.sessionService.resumeRoleSession(repoRoot, taskSlug, role, sessionInput);
      return;
    }
    await deps.sessionService.startRoleSession(repoRoot, taskSlug, role, sessionInput);
  }

  return {
    async startTaskRoleSessions(repoRoot, input) {
      const { taskSlug, requireFreshStart } = input;
      if (requireFreshStart) {
        await assertNoExistingRoleSessions(repoRoot, taskSlug);
      }
      const preferences = await deps.appSettings.getPreferences();
      const template = preferences.launchTemplate;
      const orchestration = await applyOrchestrationMode(
        repoRoot,
        taskSlug,
        template.autoOrchestration ? "auto" : "manual"
      );
      const gateReview = await deps.appSettings.getGateReviewSettings(repoRoot, taskSlug);
      const roleDefinitions = composeRoleDefinitions(gateReview.enabled);

      const startedRoles: RoleName[] = [];
      for (const definition of roleDefinitions) {
        try {
          await launchRole(repoRoot, taskSlug, definition.name, template.roles[definition.name]);
          startedRoles.push(definition.name);
        } catch (cause) {
          throw partialStartError(definition.name, startedRoles, cause);
        }
      }

      const sessions = await deps.sessionService.listRoleSessions(repoRoot, taskSlug);
      return { taskSlug, orchestration, startedRoles, sessions };
    }
  };
}

function partialStartError(failedRole: RoleName, startedRoles: RoleName[], cause: unknown): VcmError {
  return new VcmError({
    code: "TASK_ONE_CLICK_PARTIAL_START",
    message: `${failedRole} failed to start.`,
    statusCode: 409,
    hint: errorMessage(cause),
    details: { startedRoles: [...startedRoles], failedRole } satisfies OneClickStartPartialFailure
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
