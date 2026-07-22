import { isVcmRoleName } from "../../shared/constants.js";
import type { GatewayStatus } from "../../shared/types/gateway.js";
import type { RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { VcmError } from "../errors.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { AutoMemoryService } from "./auto-memory-service.js";
import type { HarnessFeedbackService } from "./harness-feedback-service.js";
import type { HarnessService } from "./harness-service.js";
import type { ProjectService } from "./project-service.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";
import type { TranslationService } from "./translation-service.js";
import type { TurnReconcilerService } from "./turn-reconciler-service.js";

export interface RuntimeCoordinatorService {
  start(): void;
  stop(): void;
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
  projectService: Pick<ProjectService, "getCurrentProject">;
  taskService: Pick<TaskService, "listTasks">;
  sessionService: Pick<
    SessionService,
    | "getRoleSession"
    | "startRoleSession"
    | "resumeRoleSession"
    | "listRoleSessions"
  >;
  translationService: Pick<TranslationService, "startSession" | "stopTask">;
  harnessService: Pick<HarnessService, "getHarnessStatus">;
  harnessFeedbackService: Pick<HarnessFeedbackService, "startTaskRetrospective">;
  autoMemoryService: Pick<AutoMemoryService, "reconcileTask" | "getTaskRetrospectiveReadiness">;
  roundService: Pick<RoundService, "getSessionRoundState">;
  gatewayService: Pick<GatewayService, "getStatus">;
  turnReconciler: Pick<TurnReconcilerService, "reconcileTask">;
  getStateRoot(repoRoot: string): Promise<string>;
  setInterval?: (callback: () => void, delayMs: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

const RUNTIME_RECONCILE_INTERVAL_MS = 10_000;

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
  const setTimer = deps.setInterval ?? ((callback, delayMs) => globalThis.setInterval(callback, delayMs));
  const clearTimer = deps.clearInterval ?? ((timer) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>));
  let reconcileTimer: unknown;

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

  function reconcileProject(
    repoRoot: string,
    input: ReconcileProjectInput = {}
  ): Promise<RuntimeCoordinatorState> {
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
      const stateRoot = await deps.getStateRoot(repoRoot);
      await deps.turnReconciler.reconcileTask(repoRoot, activeTask, stateRoot);
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

      await reconcileAutoMemory(
        repoRoot,
        activeTask,
        preferences.autoTaskHarnessReviewEnabled ? "auto" : undefined
      );
      const memoryReadiness = await getTaskRetrospectiveMemoryReadiness(repoRoot, activeTask);
      if ((preferences.autoTaskHarnessReviewEnabled || memoryReadiness.trigger) && memoryReadiness.ready) {
        await maybeStartTaskHarnessRetrospective(
          repoRoot,
          activeTask,
          memoryReadiness.trigger ?? "auto"
        );
      }

      return { activeTask, gatewayStatus };
    });
  }

  return {
    start() {
      if (reconcileTimer !== undefined) {
        return;
      }
      reconcileTimer = setTimer(() => {
        void reconcileCurrentProject().catch(() => undefined);
      }, RUNTIME_RECONCILE_INTERVAL_MS);
      void reconcileCurrentProject().catch(() => undefined);
    },
    stop() {
      if (reconcileTimer === undefined) {
        return;
      }
      clearTimer(reconcileTimer);
      reconcileTimer = undefined;
    },
    reconcileProject
  };

  async function reconcileCurrentProject(): Promise<void> {
    const project = await deps.projectService.getCurrentProject();
    if (!project) {
      return;
    }
    await reconcileProject(project.repoRoot);
  }

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
    const existing = await deps.sessionService.getRoleSession(repoRoot, task.taskSlug, "harness-engineer");
    if (!shouldAutoEnsureTaskToolSession(existing)) {
      return;
    }
    await ensureTaskToolRoleSession(repoRoot, task.taskSlug, "harness-engineer", {
      permissionMode: existing?.permissionMode,
      model: existing?.model,
      effort: existing?.effort
    });
  }

  async function reconcileTranslator(repoRoot: string, task: TaskRecord, enabled: boolean): Promise<void> {
    if (!enabled) {
      return;
    }
    const existing = await deps.sessionService.getRoleSession(repoRoot, task.taskSlug, "translator");
    if (!shouldAutoEnsureTaskToolSession(existing)) {
      return;
    }
    await ensureTaskToolRoleSession(repoRoot, task.taskSlug, "translator", {
      permissionMode: existing?.permissionMode,
      model: existing?.model,
      effort: existing?.effort
    });
  }

  function shouldAutoEnsureTaskToolSession(session: RoleSessionRecord | undefined): boolean {
    return !session || session.status === "running" || Boolean(session.claudeSessionId);
  }

  async function ensureTaskToolRoleSession(
    repoRoot: string,
    taskSlug: string,
    role: "translator" | "harness-engineer",
    input: {
      permissionMode?: RoleSessionRecord["permissionMode"];
      model?: RoleSessionRecord["model"];
      effort?: RoleSessionRecord["effort"];
    }
  ): Promise<RoleSessionRecord> {
    const existing = await deps.sessionService.getRoleSession(repoRoot, taskSlug, role);
    if (existing?.status === "running") {
      return existing;
    }
    if (existing?.claudeSessionId) {
      return deps.sessionService.resumeRoleSession(repoRoot, taskSlug, role, input);
    }
    return deps.sessionService.startRoleSession(repoRoot, taskSlug, role, input);
  }

  async function startConversationTranslationListeners(repoRoot: string, task: TaskRecord): Promise<void> {
    const translator = await deps.sessionService.getRoleSession(repoRoot, task.taskSlug, "translator");
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

  async function maybeStartTaskHarnessRetrospective(
    repoRoot: string,
    task: TaskRecord,
    trigger: "manual" | "auto"
  ): Promise<void> {
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
        trigger
      });
    } catch (error) {
      if (error instanceof VcmError && (EXPECTED_AUTO_RETROSPECTIVE_SKIP_CODES.has(error.code) || error.statusCode === 409)) {
        return;
      }
      throw error;
    }
  }

  async function reconcileAutoMemory(
    repoRoot: string,
    task: TaskRecord,
    requestTrigger?: "manual" | "auto"
  ) {
    const stateRoot = await deps.getStateRoot(repoRoot);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    const roundState = await deps.roundService.getSessionRoundState({
      repoRoot,
      stateRepoRoot: taskRepoRoot,
      stateRoot,
      taskSlug: task.taskSlug
    });
    return deps.autoMemoryService.reconcileTask({
      baseRepoRoot: repoRoot,
      taskRepoRoot,
      taskSlug: task.taskSlug,
      handoffDir: task.handoffDir,
      requestTrigger,
      roundReady: roundState.status === "stopped"
        && Boolean(roundState.roundId)
        && roundState.roleRecovery?.status !== "failed"
    });
  }

  async function getTaskRetrospectiveMemoryReadiness(repoRoot: string, task: TaskRecord) {
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    return deps.autoMemoryService.getTaskRetrospectiveReadiness({
      baseRepoRoot: repoRoot,
      taskRepoRoot,
      taskSlug: task.taskSlug,
      handoffDir: task.handoffDir,
      roundReady: true
    });
  }
}
