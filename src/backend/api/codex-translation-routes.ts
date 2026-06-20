import type { FastifyInstance } from "fastify";
import type {
  CreateCodexBootstrapRequest,
  CreateCodexFileTranslationRequest
} from "../../shared/types/translation.js";
import { VcmError } from "../errors.js";
import type { CodexTranslationService } from "../services/codex-translation-service.js";
import type { ProjectService } from "../services/project-service.js";

export interface CodexTranslationRouteDeps {
  projectService: ProjectService;
  codexTranslationService: CodexTranslationService;
}

export function registerCodexTranslationRoutes(app: FastifyInstance, deps: CodexTranslationRouteDeps): void {
  app.get("/api/translation/codex/state", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.codexTranslationService.getState(project.repoRoot);
  });

  app.get<{ Querystring: { path?: string; query?: string; limit?: string } }>(
    "/api/translation/codex/source-files",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      return deps.codexTranslationService.browseSourceFiles(project.repoRoot, {
        path: request.query.path,
        query: request.query.query,
        limit: request.query.limit === undefined ? undefined : Number(request.query.limit)
      });
    }
  );

  app.post<{ Body: CreateCodexFileTranslationRequest }>("/api/translation/codex/files", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.codexTranslationService.createFileJob(project.repoRoot, request.body);
  });

  app.post<{ Body: CreateCodexBootstrapRequest }>("/api/translation/codex/bootstrap", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.codexTranslationService.createBootstrapRun(project.repoRoot, request.body);
  });

  app.get<{ Params: { jobId: string } }>("/api/translation/codex/files/:jobId", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.codexTranslationService.readFileJobOutput(project.repoRoot, request.params.jobId);
  });

  app.post<{ Params: { jobId: string }; Body: { targetPath?: string } }>(
    "/api/translation/codex/files/:jobId/promote",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const targetPath = request.body?.targetPath?.trim();
      if (!targetPath) {
        throw new VcmError({
          code: "TRANSLATION_PROMOTE_TARGET_REQUIRED",
          message: "Promote target path is required.",
          statusCode: 400
        });
      }
      return deps.codexTranslationService.promoteFileJob(project.repoRoot, request.params.jobId, targetPath);
    }
  );
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
