import type { FastifyInstance } from "fastify";
import type { CreateTaskRequest } from "../../shared/types/task.js";
import { VcmError } from "../errors.js";
import type { ProjectService } from "../services/project-service.js";
import type { StatusService } from "../services/status-service.js";
import type { TaskService } from "../services/task-service.js";

export interface TaskRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  statusService: StatusService;
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
