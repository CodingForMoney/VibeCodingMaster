import type { FastifyInstance } from "fastify";
import type {
  HarnessApplyRequest,
  HarnessBootstrapStatusReport,
  HarnessFeedbackDecisionRequest,
  MergeRepositoryDiffToMainRequest,
  HarnessStatusReport,
  RestartHarnessBootstrapRequest,
  StartHarnessBootstrapRequest,
  UpdateHarnessFileContentRequest
} from "../../shared/types/harness.js";
import { isOpenFileLimitError, VcmError } from "../errors.js";
import type { HarnessService } from "../services/harness-service.js";
import type { HarnessFeedbackService } from "../services/harness-feedback-service.js";
import type { ProjectService } from "../services/project-service.js";
import type { SessionService } from "../services/session-service.js";
import type { TaskService } from "../services/task-service.js";
import type { StartRoleSessionRequest } from "../../shared/types/session.js";

export interface HarnessRouteDeps {
  projectService: ProjectService;
  harnessService: HarnessService;
  harnessFeedbackService: HarnessFeedbackService;
  sessionService: Pick<
    SessionService,
    | "getProjectHarnessEngineerSession"
    | "ensureProjectHarnessEngineerSession"
    | "startProjectHarnessEngineerSession"
    | "resumeProjectHarnessEngineerSession"
    | "restartProjectHarnessEngineerSession"
    | "stopProjectHarnessEngineerSession"
    | "notifyProjectHarnessEngineerHarnessUpdated"
  >;
  taskService: Pick<TaskService, "loadTask">;
}

export function registerHarnessRoutes(app: FastifyInstance, deps: HarnessRouteDeps): void {
  app.get<{ Querystring: { taskSlug?: string } }>("/api/projects/harness", async (request) => {
    const { task } = await requireHarnessTaskContext(deps, request.query.taskSlug);
    try {
      return await deps.harnessService.getHarnessStatus(task.worktreePath);
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return degradedHarnessStatus(error);
      }
      throw error;
    }
  });

  app.post<{ Body: HarnessApplyRequest }>("/api/projects/harness/apply", async (request) => {
    const { task } = await requireHarnessTaskContext(deps, request.body?.taskSlug);
    return deps.harnessService.applyHarness(task.worktreePath);
  });

  app.get<{ Querystring: { path?: string; taskSlug?: string } }>("/api/projects/harness/file", async (request) => {
    const { task } = await requireHarnessTaskContext(deps, request.query.taskSlug);
    return deps.harnessService.getHarnessFileContent(task.worktreePath, request.query.path ?? "");
  });

  app.put<{
    Querystring: { path?: string; taskSlug?: string };
    Body: UpdateHarnessFileContentRequest;
  }>("/api/projects/harness/file", async (request) => {
    const { task } = await requireHarnessTaskContext(deps, request.query.taskSlug ?? request.body?.taskSlug);
    if (typeof request.body?.content !== "string") {
      throw new VcmError({
        code: "HARNESS_FILE_CONTENT_INVALID",
        message: "Harness file content must be a string.",
        statusCode: 400
      });
    }
    return deps.harnessService.updateHarnessFileContent(task.worktreePath, request.query.path ?? "", request.body.content);
  });

  app.get<{ Querystring: { commit?: string; taskSlug?: string } }>("/api/projects/harness/repository-diff", async (request) => {
    const { project, task } = await requireHarnessTaskContext(deps, request.query.taskSlug);
    return deps.harnessService.getRepositoryDiff(task.worktreePath, {
      baseRepoRoot: project.repoRoot,
      commitSha: request.query.commit
    });
  });

  app.post<{ Body: MergeRepositoryDiffToMainRequest }>("/api/projects/harness/repository-diff/merge-to-main", async (request) => {
    const { project, task } = await requireHarnessTaskContext(deps, request.body?.taskSlug);
    return deps.harnessService.mergeRepositoryDiffToMain(project.repoRoot, {
      taskRepoRoot: task.worktreePath,
      taskBranch: task.branch
    });
  });

  app.get<{ Querystring: { taskSlug?: string } }>("/api/projects/harness/bootstrap", async (request) => {
    const { project, task } = await requireHarnessTaskContext(deps, request.query.taskSlug);
    try {
      return await deps.harnessService.getBootstrapStatus(project.repoRoot, task.worktreePath);
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return degradedBootstrapStatus(error);
      }
      throw error;
    }
  });

  app.post<{ Body: StartHarnessBootstrapRequest }>("/api/projects/harness/bootstrap/start", async (request) => {
    const { project, task } = await requireHarnessTaskContext(deps, request.body?.taskSlug);
    await deps.harnessFeedbackService.assertHarnessEngineerAvailable(project.repoRoot);
    return deps.harnessService.startHarnessBootstrap(project.repoRoot, task.worktreePath, request.body ?? {});
  });

  app.post<{ Body: RestartHarnessBootstrapRequest }>("/api/projects/harness/bootstrap/restart", async (request) => {
    const { project, task } = await requireHarnessTaskContext(deps, request.body?.taskSlug);
    await deps.harnessFeedbackService.assertHarnessEngineerAvailable(project.repoRoot);
    return deps.harnessService.restartHarnessBootstrap(project.repoRoot, task.worktreePath, request.body ?? {});
  });

  app.post("/api/projects/harness/bootstrap/stop", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.stopHarnessBootstrap(project.repoRoot);
  });

  app.post<{ Body: { taskSlug?: string } }>("/api/projects/harness/bootstrap/run", async (request) => {
    const { project, task } = await requireHarnessTaskContext(deps, request.body?.taskSlug);
    await deps.harnessFeedbackService.assertHarnessEngineerAvailable(project.repoRoot);
    return deps.harnessService.runHarnessBootstrap(project.repoRoot, task.worktreePath);
  });

  app.get("/api/projects/harness/engineer/session", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return (await deps.sessionService.getProjectHarnessEngineerSession(project.repoRoot)) ?? null;
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/projects/harness/engineer/session/ensure", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.ensureProjectHarnessEngineerSession(project.repoRoot, request.body);
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/projects/harness/engineer/session/start", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.startProjectHarnessEngineerSession(project.repoRoot, request.body);
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/projects/harness/engineer/session/resume", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.resumeProjectHarnessEngineerSession(project.repoRoot, request.body);
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/projects/harness/engineer/session/restart", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.restartProjectHarnessEngineerSession(project.repoRoot, request.body);
  });

  app.post("/api/projects/harness/engineer/session/stop", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.stopProjectHarnessEngineerSession(project.repoRoot);
  });

  app.post("/api/projects/harness/engineer/session/notify-harness", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.notifyProjectHarnessEngineerHarnessUpdated(project.repoRoot);
  });

  app.get<{ Querystring: { taskSlug?: string } }>("/api/projects/harness/feedback", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const taskSlug = await normalizeOptionalTaskSlug(deps, project.repoRoot, request.query.taskSlug);
    return deps.harnessFeedbackService.getState(project.repoRoot, taskSlug);
  });

  app.post<{ Body: HarnessFeedbackDecisionRequest }>("/api/projects/harness/feedback/decision", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const action = request.body?.action;
    if (action !== "approve" && action !== "reject" && action !== "comment") {
      throw new VcmError({
        code: "HARNESS_FEEDBACK_DECISION_INVALID",
        message: "Harness feedback decision action is invalid.",
        statusCode: 400
      });
    }
    const taskSlug = await normalizeOptionalTaskSlug(deps, project.repoRoot, request.body?.taskSlug);
    return deps.harnessFeedbackService.decide(project.repoRoot, {
      action,
      taskSlug,
      comment: typeof request.body?.comment === "string" ? request.body.comment : undefined
    });
  });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function requireHarnessTaskContext(deps: HarnessRouteDeps, taskSlug: string | undefined) {
  const project = await requireCurrentProject(deps.projectService);
  const normalizedTaskSlug = taskSlug?.trim();
  if (!normalizedTaskSlug) {
    throw new VcmError({
      code: "HARNESS_TASK_REQUIRED",
      message: "Select or create an active task before changing VCM Harness.",
      statusCode: 409,
      hint: "VCM writes harness changes only to the active task worktree."
    });
  }
  const task = await deps.taskService.loadTask(project.repoRoot, normalizedTaskSlug);
  return { project, task };
}

async function normalizeOptionalTaskSlug(
  deps: HarnessRouteDeps,
  repoRoot: string,
  taskSlug: string | undefined
): Promise<string | undefined> {
  const normalizedTaskSlug = taskSlug?.trim();
  if (!normalizedTaskSlug) {
    return undefined;
  }
  await deps.taskService.loadTask(repoRoot, normalizedTaskSlug);
  return normalizedTaskSlug;
}
