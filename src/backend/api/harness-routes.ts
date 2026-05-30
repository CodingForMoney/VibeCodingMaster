import type { FastifyInstance } from "fastify";
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
