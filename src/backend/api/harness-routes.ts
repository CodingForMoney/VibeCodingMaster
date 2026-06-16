import type { FastifyInstance } from "fastify";
import type { HarnessBootstrapStatusReport, HarnessStatusReport, StartHarnessBootstrapRequest } from "../../shared/types/harness.js";
import { isOpenFileLimitError, VcmError } from "../errors.js";
import type { HarnessService } from "../services/harness-service.js";
import type { ProjectService } from "../services/project-service.js";

export interface HarnessRouteDeps {
  projectService: ProjectService;
  harnessService: HarnessService;
}

export function registerHarnessRoutes(app: FastifyInstance, deps: HarnessRouteDeps): void {
  app.get("/api/projects/harness", async () => {
    const project = await requireCurrentProject(deps.projectService);
    try {
      return await deps.harnessService.getHarnessStatus(project.repoRoot);
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return degradedHarnessStatus(error);
      }
      throw error;
    }
  });

  app.post("/api/projects/harness/apply", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.applyHarness(project.repoRoot);
  });

  app.get("/api/projects/harness/bootstrap", async () => {
    const project = await requireCurrentProject(deps.projectService);
    try {
      return await deps.harnessService.getBootstrapStatus(project.repoRoot);
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return degradedBootstrapStatus(error);
      }
      throw error;
    }
  });

  app.post<{ Body: StartHarnessBootstrapRequest }>("/api/projects/harness/bootstrap/start", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.harnessService.startHarnessBootstrap(project.repoRoot, request.body ?? {});
  });
}

function degradedHarnessStatus(error: unknown): HarnessStatusReport {
  return {
    version: 1,
    initialized: false,
    files: [],
    needsApply: false,
    plannedChanges: [],
    warnings: [
      `Harness status is temporarily unavailable because the backend hit the open-files limit: ${errorMessage(error)}`
    ]
  };
}

function degradedBootstrapStatus(error: unknown): HarnessBootstrapStatusReport {
  return {
    status: "not_ready",
    canStart: false,
    checks: [{
      key: "fixed-harness",
      label: "Fixed harness",
      status: "unknown",
      detail: `Backend open-files limit reached: ${errorMessage(error)}`
    }],
    warnings: [
      `Harness bootstrap status is temporarily unavailable because the backend hit the open-files limit: ${errorMessage(error)}`
    ]
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
