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
import type { TranslationService } from "../services/translation-service.js";
import type { StartRoleSessionRequest } from "../../shared/types/session.js";
import { createDefaultToolSessionDefaults } from "../../shared/types/app-settings.js";
import type { AppSettingsService } from "../services/app-settings-service.js";

export interface TranslationWorkerRouteDeps {
  projectService: ProjectService;
  appSettings: Pick<AppSettingsService, "updateToolSessionDefaults">;
  translationWorkerService: TranslationWorkerService;
  sessionService: Pick<
    SessionService,
    | "assertModelLaunchReady"
    | "getRoleSession"
    | "startRoleSession"
    | "resumeRoleSession"
    | "restartRoleSession"
    | "stopRoleSession"
  >;
  translationService: Pick<TranslationService, "stopSession">;
}

export function registerTranslationWorkerRoutes(app: FastifyInstance, deps: TranslationWorkerRouteDeps): void {
  app.get("/api/translation/state", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.translationWorkerService.getState(project.repoRoot, {
      visibility: "public"
    });
  });

  app.get<{ Querystring: { taskSlug?: string } }>("/api/translation/session", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const taskSlug = request.query.taskSlug?.trim();
    if (!taskSlug) {
      return null;
    }
    return (await deps.sessionService.getRoleSession(project.repoRoot, taskSlug, "translator")) ?? null;
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/translation/session/ensure", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const taskSlug = requireTaskSlug(request.body?.taskSlug, "Translator");
    const existing = await deps.sessionService.getRoleSession(project.repoRoot, taskSlug, "translator");
    if (existing?.status === "running") {
      return existing;
    }
    if (existing?.claudeSessionId) {
      return deps.sessionService.resumeRoleSession(project.repoRoot, taskSlug, "translator", request.body);
    }
    return deps.sessionService.startRoleSession(project.repoRoot, taskSlug, "translator", request.body);
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/translation/session/start", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const taskSlug = requireTaskSlug(request.body?.taskSlug, "Translator");
    const session = await deps.sessionService.startRoleSession(project.repoRoot, taskSlug, "translator", request.body);
    await persistToolSessionDefaults(deps.appSettings, "translator", session);
    return session;
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/translation/session/resume", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const taskSlug = requireTaskSlug(request.body?.taskSlug, "Translator");
    return deps.sessionService.resumeRoleSession(project.repoRoot, taskSlug, "translator", request.body);
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/translation/session/restart", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const taskSlug = requireTaskSlug(request.body?.taskSlug, "Translator");
    const existing = await deps.sessionService.getRoleSession(project.repoRoot, taskSlug, "translator");
    await deps.sessionService.assertModelLaunchReady(request.body?.model ?? existing?.model);
    if (existing) {
      await deps.translationService.stopSession(existing.id, { clearCache: true });
    }
    const session = await deps.sessionService.restartRoleSession(project.repoRoot, taskSlug, "translator", request.body);
    await persistToolSessionDefaults(deps.appSettings, "translator", session);
    return session;
  });

  app.post<{ Body: StartRoleSessionRequest }>("/api/translation/session/stop", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const taskSlug = requireTaskSlug(request.body?.taskSlug, "Translator");
    const session = await deps.sessionService.stopRoleSession(project.repoRoot, taskSlug, "translator");
    await deps.translationService.stopSession(session.id);
    return session;
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

async function persistToolSessionDefaults(
  appSettings: Pick<AppSettingsService, "updateToolSessionDefaults">,
  role: "translator",
  session: Awaited<ReturnType<SessionService["startRoleSession"]>>
): Promise<void> {
  const defaults = createDefaultToolSessionDefaults().translator;
  await appSettings.updateToolSessionDefaults(role, {
    permissionMode: session.permissionMode,
    model: session.model ?? defaults.model,
    effort: session.effort ?? defaults.effort
  });
}

function requireTaskSlug(value: string | undefined, roleLabel: string): string {
  const taskSlug = value?.trim();
  if (!taskSlug) {
    throw new VcmError({
      code: "TOOL_SESSION_TASK_REQUIRED",
      message: `${roleLabel} requires an active task.`,
      statusCode: 409,
      hint: "Create or select a task before using this session."
    });
  }
  return taskSlug;
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
