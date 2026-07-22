import type { FastifyInstance } from "fastify";
import { VcmError } from "../errors.js";
import type { ProjectService } from "../services/project-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";
import type { UsageAnalyticsService } from "../services/usage-analytics-service.js";

export interface UsageAnalyticsRouteDeps {
  projectService: Pick<ProjectService, "getCurrentProject" | "loadConfig">;
  taskService: Pick<TaskService, "listTasks" | "loadTask">;
  usageAnalyticsService: UsageAnalyticsService;
}

export function registerUsageAnalyticsRoutes(app: FastifyInstance, deps: UsageAnalyticsRouteDeps): void {
  app.post<{ Body: unknown }>("/api/telemetry/v1/logs", async (request) => {
    const project = await deps.projectService.getCurrentProject();
    if (!project) {
      return {};
    }
    const tasks = await deps.taskService.listTasks(project.repoRoot);
    const activeTask = tasks.find((task) => task.cleanupStatus !== "cleaned");
    if (!activeTask) {
      return {};
    }
    const config = await deps.projectService.loadConfig(project.repoRoot);
    await deps.usageAnalyticsService.ingest(
      getTaskRuntimeRepoRoot(activeTask),
      config.stateRoot,
      request.body
    );
    return {};
  });

  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/usage-analytics", async (request) => {
    const project = await deps.projectService.getCurrentProject();
    if (!project) {
      throw new VcmError({
        code: "PROJECT_NOT_CONNECTED",
        message: "Connect a repository before loading task usage analytics.",
        statusCode: 409
      });
    }
    const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
    const config = await deps.projectService.loadConfig(project.repoRoot);
    return deps.usageAnalyticsService.getReport(
      getTaskRuntimeRepoRoot(task),
      config.stateRoot,
      task.taskSlug
    );
  });
}
