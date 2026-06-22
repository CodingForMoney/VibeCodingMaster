import type { FastifyInstance } from "fastify";
import type {
  CreateTranslationBootstrapRequest,
  CreateFileTranslationRequest,
  CreateTranslationMemoryUpdateRequest
} from "../../shared/types/translation.js";
import { VcmError } from "../errors.js";
import type { TranslationWorkerService } from "../services/translation-worker-service.js";
import type { ProjectService } from "../services/project-service.js";
import type { SessionService } from "../services/session-service.js";
import type { StartRoleSessionRequest } from "../../shared/types/session.js";

export interface TranslationWorkerRouteDeps {
  projectService: ProjectService;
  translationWorkerService: TranslationWorkerService;
  sessionService: Pick<
    SessionService,
    | "getProjectTranslatorSession"
    | "ensureProjectTranslatorSession"
    | "startProjectTranslatorSession"
    | "resumeProjectTranslatorSession"
    | "restartProjectTranslatorSession"
    | "stopProjectTranslatorSession"
  >;
}

export function registerTranslationWorkerRoutes(app: FastifyInstance, deps: TranslationWorkerRouteDeps): void {
  app.get("/api/translation/state", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.translationWorkerService.getState(project.repoRoot, {
      visibility: "public"
    });
  });

  app.get("/api/translation/session", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return (await deps.sessionService.getProjectTranslatorSession(project.repoRoot)) ?? null;
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/translation/session/ensure", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.ensureProjectTranslatorSession(project.repoRoot, request.body);
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/translation/session/start", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.startProjectTranslatorSession(project.repoRoot, request.body);
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/translation/session/resume", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.resumeProjectTranslatorSession(project.repoRoot, request.body);
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/translation/session/restart", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.restartProjectTranslatorSession(project.repoRoot, request.body);
  });

  app.post("/api/translation/session/stop", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.stopProjectTranslatorSession(project.repoRoot);
  });

  app.get<{ Querystring: { path?: string; query?: string; limit?: string } }>(
    "/api/translation/source-files",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      return deps.translationWorkerService.browseSourceFiles(project.repoRoot, {
        path: request.query.path,
        query: request.query.query,
        limit: request.query.limit === undefined ? undefined : Number(request.query.limit)
      });
    }
  );

  app.post<{ Body: CreateFileTranslationRequest }>("/api/translation/files", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.translationWorkerService.createFileJob(project.repoRoot, request.body);
  });

  app.post<{ Body: CreateTranslationBootstrapRequest }>("/api/translation/bootstrap", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.translationWorkerService.createBootstrapRun(project.repoRoot, request.body);
  });

  app.post<{ Body: CreateTranslationMemoryUpdateRequest }>("/api/translation/memory-update", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.translationWorkerService.createMemoryUpdate(project.repoRoot, request.body);
  });

  app.get<{ Params: { jobId: string } }>("/api/translation/files/:jobId", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.translationWorkerService.readFileJobOutput(project.repoRoot, request.params.jobId);
  });

  app.post<{ Params: { jobId: string }; Body: { targetPath?: string } }>(
    "/api/translation/files/:jobId/promote",
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
      return deps.translationWorkerService.promoteFileJob(project.repoRoot, request.params.jobId, targetPath);
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
