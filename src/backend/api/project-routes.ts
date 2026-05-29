import type { FastifyInstance } from "fastify";
import type { ConnectProjectRequest } from "../../shared/types/project.js";
import type { ProjectService } from "../services/project-service.js";

export interface ProjectRouteDeps {
  projectService: ProjectService;
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  app.get("/api/health", async () => ({ ok: true }));

  app.post<{ Body: ConnectProjectRequest }>("/api/projects/connect", async (request) => {
    return deps.projectService.connectProject(request.body);
  });

  app.get("/api/projects/current", async () => {
    return deps.projectService.getCurrentProject();
  });

  app.get("/api/projects/harness", async () => ({
    checks: [
      {
        name: "local-gui",
        status: "ok"
      }
    ]
  }));
}
