import type { FastifyInstance } from "fastify";
import type { VcmSessionRoundState } from "../../shared/types/round.js";
import { isOpenFileLimitError, VcmError } from "../errors.js";
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
    try {
      const project = await requireCurrentProject(deps.projectService);
      const config = await deps.projectService.loadConfig(project.repoRoot);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      return await deps.roundService.getSessionRoundState({
        repoRoot: project.repoRoot,
        stateRepoRoot: taskRepoRoot,
        stateRoot: config.stateRoot,
        taskSlug: request.params.taskSlug
      });
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return degradedRoundState(request.params.taskSlug);
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

function degradedRoundState(taskSlug: string): VcmSessionRoundState {
  return {
    taskSlug,
    status: "stopped",
    turnCount: 0,
    completedTurnCount: 0,
    totalRoundCount: 0,
    totalTurnCount: 0,
    totalCompletedTurnCount: 0,
    totalCcActiveMs: 0,
    currentRoundCcActiveMs: 0,
    roles: [],
    updatedAt: new Date().toISOString()
  };
}
