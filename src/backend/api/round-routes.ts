import type { FastifyInstance } from "fastify";
import { VcmError } from "../errors.js";
import type { MessageService } from "../services/message-service.js";
import type { ProjectService } from "../services/project-service.js";
import type { RoundService } from "../services/round-service.js";
import type { SessionService } from "../services/session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";

export interface RoundRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: Pick<SessionService, "listRoleSessions">;
  messageService: Pick<MessageService, "listPendingRouteFiles">;
  roundService: RoundService;
}

export function registerRoundRoutes(app: FastifyInstance, deps: RoundRouteDeps): void {
  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/round", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const config = await deps.projectService.loadConfig(project.repoRoot);
    const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    const sessions = await deps.sessionService.listRoleSessions(project.repoRoot, request.params.taskSlug);
    const pendingRoutes = await deps.messageService.listPendingRouteFiles({
      repoRoot: project.repoRoot,
      taskRepoRoot,
      stateRepoRoot: taskRepoRoot,
      stateRoot: config.stateRoot,
      handoffDir: task.handoffDir,
      taskSlug: request.params.taskSlug
    });
    return deps.roundService.getTaskRoundState({
      taskSlug: request.params.taskSlug,
      sessions,
      pendingRouteCount: pendingRoutes.length
    });
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
