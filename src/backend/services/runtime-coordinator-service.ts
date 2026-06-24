import { isVcmRoleName } from "../../shared/constants.js";
import type { GatewayStatus } from "../../shared/types/gateway.js";
import type { RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { VcmError } from "../errors.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { HarnessFeedbackService } from "./harness-feedback-service.js";
import type { HarnessService } from "./harness-service.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";
import type { TranslationService } from "./translation-service.js";

export interface RuntimeCoordinatorService {
  reconcileProject(repoRoot: string, input?: ReconcileProjectInput): Promise<RuntimeCoordinatorState>;
}

export interface ReconcileProjectInput {
  taskSlug?: string | null;
}

export interface RuntimeCoordinatorState {
  activeTask: TaskRecord | null;
  gatewayStatus: GatewayStatus | null;
}

export interface RuntimeCoordinatorServiceDeps {
  appSettings: Pick<AppSettingsService, "getPreferences">;
  taskService: Pick<TaskService, "listTasks">;
  sessionService: Pick<
    SessionService,
    | "getProjectTranslatorSession"
    | "ensureProjectTranslatorSession"
    | "getProjectHarnessEngineerSession"
    | "ensureProjectHarnessEngineerSession"
    | "listRoleSessions"
  >;
  translationService: Pick<TranslationService, "startSession" | "stopTask">;
  harnessService: Pick<HarnessService, "getHarnessStatus">;
  harnessFeedbackService: Pick<HarnessFeedbackService, "startTaskRetrospective">;
  roundService: Pick<RoundService, "getSessionRoundState">;
  gatewayService: Pick<GatewayService, "getStatus">;
  getStateRoot(repoRoot: string): Promise<string>;
}

const EXPECTED_AUTO_RETROSPECTIVE_SKIP_CODES = new Set([
  "HARNESS_FEEDBACK_ACTIVE",
  "TASK_HARNESS_RETROSPECTIVE_EXISTS",
  "TASK_FINAL_ACCEPTANCE_NOT_READY",
  "HARNESS_ENGINEER_BUSY",
  "HARNESS_ENGINEER_SESSION_MISSING",
  "PROJECT_TOOL_TASK_REQUIRED"
]);

export function createRuntimeCoordinatorService(deps: RuntimeCoordinatorServiceDeps): RuntimeCoordinatorService {
  const locks = new Map<string, Promise<RuntimeCoordinatorState>>();

  async function withRepoLock(repoRoot: string, run: () => Promise<RuntimeCoordinatorState>): Promise<RuntimeCoordinatorState> {
    const previous = locks.get(repoRoot) ?? Promise.resolve({
      activeTask: null,
      gatewayStatus: null
    });
    const next = previous.catch(() => ({
      activeTask: null,
      gatewayStatus: null
    })).then(run);
    locks.set(repoRoot, next);
    try {
      return await next;
    } finally {
      if (locks.get(repoRoot) === next) {
        locks.delete(repoRoot);
      }
    }
  }

  return {
    reconcileProject(repoRoot, input = {}) {
      return withRepoLock(repoRoot, async () => {
        const [activeTask, gatewayStatus] = await Promise.all([
          resolveActiveTask(repoRoot, input.taskSlug),
          deps.gatewayService.getStatus().catch(() => null)
        ]);
        const preferences = await deps.appSettings.getPreferences();

        if (!activeTask) {
          return { activeTask: null, gatewayStatus };
        }

        const taskRepoRoot = getTaskRuntimeRepoRoot(activeTask);
        const harnessInitialized = await deps.harnessService.getHarnessStatus(taskRepoRoot)
          .then((status) => status.initialized)
          .catch(() => false);

        await Promise.all([
          reconcileHarnessEngineer(repoRoot, activeTask),
          reconcileTranslator(repoRoot, activeTask, preferences.translationEnabled && harnessInitialized)
        ]);

        if (preferences.translationEnabled && harnessInitialized) {
          await startConversationTranslationListeners(repoRoot, activeTask);
        } else {
          await deps.translationService.stopTask(taskRepoRoot, activeTask.taskSlug).catch(() => undefined);
        }

        if (preferences.autoTaskHarnessReviewEnabled) {
          await maybeStartTaskHarnessRetrospective(repoRoot, activeTask);
        }

        return { activeTask, gatewayStatus };
      });
    }
  };

  async function resolveActiveTask(repoRoot: string, requestedTaskSlug?: string | null): Promise<TaskRecord | null> {
    const tasks = await deps.taskService.listTasks(repoRoot);
    const activeTasks = tasks.filter((task) => task.cleanupStatus !== "cleaned");
    if (requestedTaskSlug) {
      const requested = activeTasks.find((task) => task.taskSlug === requestedTaskSlug);
      if (requested) {
        return requested;
      }
    }
    return activeTasks[0] ?? null;
  }

  async function reconcileHarnessEngineer(repoRoot: string, task: TaskRecord): Promise<void> {
    const existing = await deps.sessionService.getProjectHarnessEngineerSession(repoRoot);
    if (!shouldAutoEnsureProjectToolSession(existing)) {
      return;
    }
    await deps.sessionService.ensureProjectHarnessEngineerSession(repoRoot, {
      taskSlug: task.taskSlug,
      permissionMode: existing?.permissionMode,
      model: existing?.model,
      effort: existing?.effort
    });
  }

  async function reconcileTranslator(repoRoot: string, task: TaskRecord, enabled: boolean): Promise<void> {
    if (!enabled) {
      return;
    }
    const existing = await deps.sessionService.getProjectTranslatorSession(repoRoot);
    if (!shouldAutoEnsureProjectToolSession(existing)) {
      return;
    }
    await deps.sessionService.ensureProjectTranslatorSession(repoRoot, {
      taskSlug: task.taskSlug,
      permissionMode: existing?.permissionMode,
      model: existing?.model,
      effort: existing?.effort
    });
  }

  function shouldAutoEnsureProjectToolSession(session: RoleSessionRecord | undefined): boolean {
    return Boolean(session && (session.status === "running" || session.claudeSessionId));
  }

  async function startConversationTranslationListeners(repoRoot: string, task: TaskRecord): Promise<void> {
    const translator = await deps.sessionService.getProjectTranslatorSession(repoRoot);
    if (translator?.status !== "running") {
      return;
    }

    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    const sessions = await deps.sessionService.listRoleSessions(repoRoot, task.taskSlug);
    await Promise.all(sessions
      .filter((session) => session.status === "running" && isVcmRoleName(session.role))
      .map((session) => startConversationTranslationListener(repoRoot, taskRepoRoot, task.taskSlug, session.role)));
  }

  async function startConversationTranslationListener(
    repoRoot: string,
    taskRepoRoot: string,
    taskSlug: string,
    role: RoleName
  ): Promise<void> {
    try {
      await deps.translationService.startSession({
        repoRoot,
        taskRepoRoot,
        taskSlug,
        role
      });
    } catch (error) {
      if (error instanceof VcmError && error.code === "SESSION_NOT_RUNNING") {
        return;
      }
      throw error;
    }
  }

  async function maybeStartTaskHarnessRetrospective(repoRoot: string, task: TaskRecord): Promise<void> {
    const stateRoot = await deps.getStateRoot(repoRoot);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    const roundState = await deps.roundService.getSessionRoundState({
      repoRoot,
      stateRepoRoot: taskRepoRoot,
      stateRoot,
      taskSlug: task.taskSlug
    });

    if (
      roundState.status !== "stopped"
      || !roundState.roundId
      || roundState.roleRecovery?.status === "failed"
    ) {
      return;
    }

    try {
      await deps.harnessFeedbackService.startTaskRetrospective(repoRoot, {
        taskSlug: task.taskSlug,
        taskRepoRoot,
        handoffDir: task.handoffDir,
        trigger: "auto"
      });
    } catch (error) {
      if (error instanceof VcmError && (EXPECTED_AUTO_RETROSPECTIVE_SKIP_CODES.has(error.code) || error.statusCode === 409)) {
        return;
      }
      throw error;
    }
  }
}
