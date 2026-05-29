import type { FastifyInstance } from "fastify";
import type { SendRoleMessageRequest, VcmOrchestrationMode } from "../../shared/types/message.js";
import { VcmError } from "../errors.js";
import type { MessageService } from "../services/message-service.js";
import type { ProjectService } from "../services/project-service.js";
import type { TaskService } from "../services/task-service.js";

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

  app.post<{ Params: { taskSlug: string }; Body: SendRoleMessageRequest }>(
    "/api/tasks/:taskSlug/messages",
    async (request) => {
      const context = await getRouteContext(deps, request.params.taskSlug);
      return deps.messageService.sendMessage({
        ...context,
        ...request.body
      });
    }
  );

  app.post<{ Params: { taskSlug: string; messageId: string } }>(
    "/api/tasks/:taskSlug/messages/:messageId/stage",
    async (request) => {
      const context = await getRouteContext(deps, request.params.taskSlug);
      return deps.messageService.stageMessage({
        ...context,
        messageId: request.params.messageId
      });
    }
  );

  app.post<{ Params: { taskSlug: string; messageId: string } }>(
    "/api/tasks/:taskSlug/messages/:messageId/approve",
    async (request) => {
      const context = await getRouteContext(deps, request.params.taskSlug);
      return deps.messageService.approveMessage({
        ...context,
        messageId: request.params.messageId
      });
    }
  );

  app.post<{ Params: { taskSlug: string; messageId: string } }>(
    "/api/tasks/:taskSlug/messages/:messageId/reject",
    async (request) => {
      const context = await getRouteContext(deps, request.params.taskSlug);
      return deps.messageService.rejectMessage({
        ...context,
        messageId: request.params.messageId
      });
    }
  );

  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/orchestration", async (request) => {
    const context = await getRouteContext(deps, request.params.taskSlug);
    return deps.messageService.getOrchestrationState(context);
  });

  app.put<{ Params: { taskSlug: string }; Body: { mode?: VcmOrchestrationMode; paused?: boolean } }>(
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
        mode: request.body.mode,
        paused: request.body.paused
      });
    }
  );

  app.post<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/orchestration/pause", async (request) => {
    const context = await getRouteContext(deps, request.params.taskSlug);
    return deps.messageService.updateOrchestrationState({
      ...context,
      paused: true
    });
  });

  app.post<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/orchestration/resume", async (request) => {
    const context = await getRouteContext(deps, request.params.taskSlug);
    return deps.messageService.updateOrchestrationState({
      ...context,
      paused: false
    });
  });
}

async function getRouteContext(deps: MessageRouteDeps, taskSlug: string) {
  const project = await requireCurrentProject(deps.projectService);
  const config = await deps.projectService.loadConfig(project.repoRoot);
  const task = await deps.taskService.loadTask(project.repoRoot, taskSlug);
  return {
    repoRoot: project.repoRoot,
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
