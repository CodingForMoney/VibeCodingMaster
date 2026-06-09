import type { FastifyInstance } from "fastify";
import { VcmError } from "../errors.js";
import type { ProjectService } from "../services/project-service.js";
import type { RoundService } from "../services/round-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";

export interface RoundRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  roundService: RoundService;
}

export function registerRoundRoutes(app: FastifyInstance, deps: RoundRouteDeps): void {
  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/round", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const config = await deps.projectService.loadConfig(project.repoRoot);
    const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    return deps.roundService.getTaskRoundState({
      stateRepoRoot: taskRepoRoot,
      stateRoot: config.stateRoot,
      taskSlug: request.params.taskSlug
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
