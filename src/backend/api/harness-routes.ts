import type { FastifyInstance } from "fastify";
import type {
  CommitAndRebaseHarnessTaskRequest,
  HarnessBootstrapStatusReport,
  HarnessStatusReport,
  RestartHarnessBootstrapRequest,
  StartHarnessBootstrapRequest,
  UpdateHarnessFileContentRequest
} from "../../shared/types/harness.js";
import { isOpenFileLimitError, VcmError } from "../errors.js";
import type { HarnessService } from "../services/harness-service.js";
import type { ProjectService } from "../services/project-service.js";
import type { SessionService } from "../services/session-service.js";
import type { TaskService } from "../services/task-service.js";
import type { StartRoleSessionRequest } from "../../shared/types/session.js";

export interface HarnessRouteDeps {
  projectService: ProjectService;
  harnessService: HarnessService;
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
  app.get("/api/projects/harness", async () => {
    const project = await requireCurrentProject(deps.projectService);
    try {
      return await deps.harnessService.getHarnessStatus(project.repoRoot);
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return degradedHarnessStatus(error);
      }
      throw error;
    }
  });

  app.post("/api/projects/harness/apply", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.applyHarness(project.repoRoot);
  });

  app.get<{ Querystring: { path?: string } }>("/api/projects/harness/file", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.getHarnessFileContent(project.repoRoot, request.query.path ?? "");
  });

  app.put<{
    Querystring: { path?: string };
    Body: UpdateHarnessFileContentRequest;
  }>("/api/projects/harness/file", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    if (typeof request.body?.content !== "string") {
      throw new VcmError({
        code: "HARNESS_FILE_CONTENT_INVALID",
        message: "Harness file content must be a string.",
        statusCode: 400
      });
    }
    return deps.harnessService.updateHarnessFileContent(project.repoRoot, request.query.path ?? "", request.body.content);
  });

  app.post<{
    Params: { taskSlug: string };
    Body: CommitAndRebaseHarnessTaskRequest;
  }>("/api/projects/harness/tasks/:taskSlug/commit-and-rebase", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
    return deps.harnessService.commitAndRebaseTask(project.repoRoot, {
      taskSlug: task.taskSlug,
      branch: task.branch,
      worktreePath: task.worktreePath,
      changedFiles: request.body?.changedFiles ?? []
    });
  });

  app.get("/api/projects/harness/bootstrap", async () => {
    const project = await requireCurrentProject(deps.projectService);
    try {
      return await deps.harnessService.getBootstrapStatus(project.repoRoot);
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return degradedBootstrapStatus(error);
      }
      throw error;
    }
  });

  app.post<{ Body: StartHarnessBootstrapRequest }>("/api/projects/harness/bootstrap/start", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.startHarnessBootstrap(project.repoRoot, request.body ?? {});
  });

  app.post<{ Body: RestartHarnessBootstrapRequest }>("/api/projects/harness/bootstrap/restart", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.restartHarnessBootstrap(project.repoRoot, request.body ?? {});
  });

  app.post("/api/projects/harness/bootstrap/stop", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.stopHarnessBootstrap(project.repoRoot);
  });

  app.post("/api/projects/harness/bootstrap/run", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.runHarnessBootstrap(project.repoRoot);
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
