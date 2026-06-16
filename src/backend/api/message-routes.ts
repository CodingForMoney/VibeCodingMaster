import type { FastifyInstance } from "fastify";
import type { VcmOrchestrationMode } from "../../shared/types/message.js";
import { isOpenFileLimitError, VcmError } from "../errors.js";
import type { MessageService } from "../services/message-service.js";
import type { ProjectService } from "../services/project-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";

export interface MessageRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  messageService: MessageService;
}

export function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps): void {
  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/messages", async (request) => {
    const context = await getRouteContext(deps, request.params.taskSlug);
    return deps.messageService.listMessages(context);
  });

  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/messages/pending-routes", async (request) => {
    const context = await getRouteContext(deps, request.params.taskSlug);
    return deps.messageService.listPendingRouteFiles(context);
  });

  app.post<{ Params: { taskSlug: string } }>(
    "/api/tasks/:taskSlug/messages/mark-all-done",
    async (request) => {
      const context = await getRouteContext(deps, request.params.taskSlug);
      return deps.messageService.markAllDone({
        ...context,
        clearRouteFiles: true
      });
    }
  );

  app.delete<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/messages/history", async (request) => {
    const context = await getRouteContext(deps, request.params.taskSlug);
    return deps.messageService.deleteMessageHistory(context);
  });

  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/orchestration", async (request) => {
    const context = await getRouteContext(deps, request.params.taskSlug);
    try {
      return await deps.messageService.getOrchestrationState(context);
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return {
          taskSlug: request.params.taskSlug,
          mode: "auto",
          updatedAt: new Date().toISOString(),
          warning: `Backend open-files limit reached while reading orchestration state: ${errorMessage(error)}`
        };
      }
      throw error;
    }
  });

  app.put<{ Params: { taskSlug: string }; Body: { mode?: VcmOrchestrationMode } }>(
    "/api/tasks/:taskSlug/orchestration",
    async (request) => {
      const context = await getRouteContext(deps, request.params.taskSlug);
      if (request.body.mode && request.body.mode !== "manual" && request.body.mode !== "auto") {
        throw new VcmError({
          code: "ORCHESTRATION_MODE_INVALID",
          message: `Invalid orchestration mode: ${request.body.mode}`,
          statusCode: 400
        });
      }
      return deps.messageService.updateOrchestrationState({
        ...context,
        mode: request.body.mode
      });
    }
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getRouteContext(deps: MessageRouteDeps, taskSlug: string) {
  const project = await requireCurrentProject(deps.projectService);
  const config = await deps.projectService.loadConfig(project.repoRoot);
  const task = await deps.taskService.loadTask(project.repoRoot, taskSlug);
  const taskRepoRoot = getTaskRuntimeRepoRoot(task);
  return {
    repoRoot: project.repoRoot,
    taskRepoRoot,
    stateRepoRoot: taskRepoRoot,
    stateRoot: config.stateRoot,
    handoffDir: task.handoffDir,
    taskSlug
  };
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
