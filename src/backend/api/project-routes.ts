import type { FastifyInstance } from "fastify";
import type { ConnectProjectRequest } from "../../shared/types/project.js";
import type { TranslationWorkerService } from "../services/translation-worker-service.js";
import type { ProjectService } from "../services/project-service.js";

export interface ProjectRouteDeps {
  projectService: ProjectService;
  translationWorkerService?: Pick<TranslationWorkerService, "cleanupStartupRuntime">;
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/projects/recent", async () => {
    return deps.projectService.getRecentRepositoryPaths();
  });

  app.post<{ Body: ConnectProjectRequest }>("/api/projects/connect", async (request) => {
    const project = await deps.projectService.connectProject(request.body);
    await deps.translationWorkerService?.cleanupStartupRuntime(project.repoRoot);
    return project;
  });

  app.get("/api/projects/current", async () => {
    return deps.projectService.getCurrentProject();
  });

  app.post("/api/projects/current/pull", async () => {
    return deps.projectService.pullCurrentProject();
  });
}
