import type { FastifyInstance } from "fastify";
import type { ProjectRuntimeState } from "../../shared/types/api.js";
import type { HarnessBootstrapStatusReport, HarnessStatusReport } from "../../shared/types/harness.js";
import { isOpenFileLimitError, VcmError } from "../errors.js";
import type { HarnessFeedbackService } from "../services/harness-feedback-service.js";
import type { HarnessService } from "../services/harness-service.js";
import type { ProjectService } from "../services/project-service.js";
import type { RuntimeCoordinatorService } from "../services/runtime-coordinator-service.js";
import type { SessionService } from "../services/session-service.js";
import type { TaskService } from "../services/task-service.js";
import type { TranslationWorkerService } from "../services/translation-worker-service.js";

export interface RuntimeStateRouteDeps {
  projectService: ProjectService;
  taskService: Pick<TaskService, "loadTask">;
  sessionService: Pick<SessionService, "getProjectTranslatorSession" | "getProjectHarnessEngineerSession">;
  translationWorkerService: Pick<TranslationWorkerService, "getState">;
  harnessService: Pick<HarnessService, "getHarnessStatus" | "getBootstrapStatus">;
  harnessFeedbackService: Pick<HarnessFeedbackService, "getState">;
  runtimeCoordinator: Pick<RuntimeCoordinatorService, "reconcileProject">;
}

export function registerRuntimeStateRoutes(app: FastifyInstance, deps: RuntimeStateRouteDeps): void {
  app.get<{ Querystring: { taskSlug?: string } }>("/api/projects/runtime-state", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const taskSlug = request.query.taskSlug?.trim();
    const coordinated = await deps.runtimeCoordinator.reconcileProject(project.repoRoot, { taskSlug });
    const [translatorSession, translationState, harnessEngineerSession, harnessFeedbackState] = await Promise.all([
      deps.sessionService.getProjectTranslatorSession(project.repoRoot).then((session) => session ?? null),
      deps.translationWorkerService.getState(project.repoRoot, { visibility: "public" }),
      deps.sessionService.getProjectHarnessEngineerSession(project.repoRoot).then((session) => session ?? null),
      deps.harnessFeedbackService.getState(project.repoRoot, taskSlug || undefined)
    ]);

    if (!taskSlug) {
      return {
        translatorSession,
        translationState,
        harnessEngineerSession,
        harnessStatus: null,
        harnessBootstrapStatus: null,
        harnessFeedbackState,
        gatewayStatus: coordinated.gatewayStatus
      } satisfies ProjectRuntimeState;
    }

    try {
      const task = await deps.taskService.loadTask(project.repoRoot, taskSlug);
      const [harnessStatus, harnessBootstrapStatus] = await Promise.all([
        withOpenFileLimitFallback(
          () => deps.harnessService.getHarnessStatus(task.worktreePath),
          (error) => degradedHarnessStatus(error)
        ),
        withOpenFileLimitFallback(
          () => deps.harnessService.getBootstrapStatus(project.repoRoot, task.worktreePath),
          (error) => degradedBootstrapStatus(error)
        )
      ]);

      return {
        translatorSession,
        translationState,
        harnessEngineerSession,
        harnessStatus,
        harnessBootstrapStatus,
        harnessFeedbackState,
        gatewayStatus: coordinated.gatewayStatus
      } satisfies ProjectRuntimeState;
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return {
          translatorSession,
          translationState,
          harnessEngineerSession,
          harnessStatus: degradedHarnessStatus(error),
          harnessBootstrapStatus: degradedBootstrapStatus(error),
          harnessFeedbackState,
          gatewayStatus: coordinated.gatewayStatus
        } satisfies ProjectRuntimeState;
      }
      throw error;
    }
  });
}

async function requireCurrentProject(projectService: ProjectService) {
  const project = await projectService.getCurrentProject();
  if (!project) {
    throw new VcmError({
      code: "PROJECT_NOT_CONNECTED",
      message: "Connect a repository first.",
      statusCode: 409
    });
  }
  return project;
}

function degradedHarnessStatus(error: unknown): HarnessStatusReport {
  return {
    version: 1,
    harnessRevision: 0,
    initialized: false,
    files: [],
    needsApply: false,
    plannedChanges: [],
    warnings: [
      `Harness status is temporarily unavailable because the backend hit the open-files limit: ${errorMessage(error)}`
    ]
  };
}

function degradedBootstrapStatus(error: unknown): HarnessBootstrapStatusReport {
  return {
    status: "not_ready",
    canStart: false,
    checks: [{
      key: "fixed-harness",
      label: "Fixed harness",
      status: "unknown",
      detail: `Backend open-files limit reached: ${errorMessage(error)}`
    }],
    warnings: [
      `Harness bootstrap status is temporarily unavailable because the backend hit the open-files limit: ${errorMessage(error)}`
    ]
  };
}

async function withOpenFileLimitFallback<T>(
  run: () => Promise<T>,
  fallback: (error: unknown) => T
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isOpenFileLimitError(error)) {
      return fallback(error);
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
