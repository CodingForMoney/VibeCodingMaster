import type { FastifyInstance } from "fastify";
import type { CleanupTaskRequest, CreateTaskRequest } from "../../shared/types/task.js";
import { VcmError } from "../errors.js";
import type { ProjectService } from "../services/project-service.js";
import type { SessionService } from "../services/session-service.js";
import type { StatusService } from "../services/status-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";
import type { TranslationService } from "../services/translation-service.js";
import type { RoundService } from "../services/round-service.js";

export interface TaskRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: Pick<SessionService, "listRoleSessions" | "stopRoleSession">;
  statusService: StatusService;
  translationService: Pick<TranslationService, "stopTask">;
  roundService: Pick<RoundService, "stopTask">;
}

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  app.get("/api/tasks", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.taskService.listTasks(project.repoRoot);
  });

  app.post<{ Body: CreateTaskRequest }>("/api/tasks", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.taskService.createTask(project.repoRoot, request.body);
  });

  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
  });

  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/status", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.statusService.getTaskStatus(project.repoRoot, request.params.taskSlug);
  });

  app.post<{ Params: { taskSlug: string }; Body: CleanupTaskRequest }>(
    "/api/tasks/:taskSlug/cleanup",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      await stopRunningRoleSessions(deps, project.repoRoot, request.params.taskSlug);
      await deps.translationService.stopTask(getTaskRuntimeRepoRoot(task), request.params.taskSlug, { clearCache: true });
      deps.roundService.stopTask(request.params.taskSlug);
      return deps.taskService.cleanupTask(project.repoRoot, request.params.taskSlug, request.body ?? {});
    }
  );
}

async function stopRunningRoleSessions(
  deps: Pick<TaskRouteDeps, "sessionService">,
  repoRoot: string,
  taskSlug: string
): Promise<void> {
  const sessions = await deps.sessionService.listRoleSessions(repoRoot, taskSlug);
  for (const session of sessions) {
    if (session.status === "running") {
      await deps.sessionService.stopRoleSession(repoRoot, taskSlug, session.role);
    }
  }
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
