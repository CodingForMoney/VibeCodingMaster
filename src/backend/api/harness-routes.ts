import type { FastifyInstance } from "fastify";
import type { StartHarnessBootstrapRequest } from "../../shared/types/harness.js";
import { VcmError } from "../errors.js";
import type { HarnessService } from "../services/harness-service.js";
import type { ProjectService } from "../services/project-service.js";

export interface HarnessRouteDeps {
  projectService: ProjectService;
  harnessService: HarnessService;
}

export function registerHarnessRoutes(app: FastifyInstance, deps: HarnessRouteDeps): void {
  app.get("/api/projects/harness", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.getHarnessStatus(project.repoRoot);
  });

  app.post("/api/projects/harness/apply", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.applyHarness(project.repoRoot);
  });

  app.get("/api/projects/harness/bootstrap", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.getBootstrapStatus(project.repoRoot);
  });

  app.post<{ Body: StartHarnessBootstrapRequest }>("/api/projects/harness/bootstrap/start", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.startHarnessBootstrap(project.repoRoot, request.body ?? {});
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
