import type { FastifyInstance } from "fastify";
import type { ConnectProjectRequest } from "../../shared/types/project.js";
import type { ProjectService } from "../services/project-service.js";
import type { RuntimeRecoveryService } from "../services/runtime-recovery-service.js";
import type { CodeIntelligenceManager } from "../services/code-intelligence-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";

export interface ProjectRouteDeps {
  projectService: ProjectService;
  runtimeRecoveryService?: Pick<RuntimeRecoveryService, "recoverProject">;
  taskService: Pick<TaskService, "listTasks">;
  codeIntelligenceManager: Pick<CodeIntelligenceManager, "activateTask" | "shutdown">;
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/projects/recent", async () => {
    return deps.projectService.getRecentRepositoryPaths();
  });

  app.post<{ Body: ConnectProjectRequest }>("/api/projects/connect", async (request) => {
    const project = await deps.projectService.connectProject(request.body);
    await deps.runtimeRecoveryService?.recoverProject(project.repoRoot);
    const activeTasks = (await deps.taskService.listTasks(project.repoRoot))
      .filter((task) => task.cleanupStatus !== "cleaned")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (activeTasks[0]) {
      await deps.codeIntelligenceManager.activateTask(getTaskRuntimeRepoRoot(activeTasks[0]));
    } else {
      await deps.codeIntelligenceManager.shutdown();
    }
    return project;
  });

  app.get("/api/projects/current", async () => {
    return deps.projectService.getCurrentProject();
  });

  app.post("/api/projects/current/pull", async () => {
    return deps.projectService.pullCurrentProject();
  });
}
