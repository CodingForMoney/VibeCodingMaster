import type { FastifyInstance } from "fastify";
import { isRoleName } from "../../shared/constants.js";
import type {
  SendTranslatedInputRequest,
  TranslateUserInputRequest,
  TranslationSecretSettings,
  TranslationSettings
} from "../../shared/types/translation.js";
import { VcmError } from "../errors.js";
import type { ProjectService } from "../services/project-service.js";
import type { TaskService } from "../services/task-service.js";
import type { TranslationService } from "../services/translation-service.js";

export interface TranslationRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  translationService: TranslationService;
}

export function registerTranslationRoutes(app: FastifyInstance, deps: TranslationRouteDeps): void {
  app.get("/api/translation/settings", async () => {
    await requireCurrentProject(deps.projectService);
    return deps.translationService.getSettings();
  });

  app.put<{ Body: Partial<TranslationSettings> & TranslationSecretSettings }>("/api/translation/settings", async (request) => {
    await requireCurrentProject(deps.projectService);
    const { apiKey, ...settings } = request.body ?? {};
    return deps.translationService.updateSettings(settings, apiKey !== undefined ? { apiKey } : undefined);
  });

  app.post("/api/translation/test", async () => {
    await requireCurrentProject(deps.projectService);
    return deps.translationService.testProvider();
  });

  app.post<{ Params: { taskSlug: string; role: string }; Body: TranslateUserInputRequest }>(
    "/api/tasks/:taskSlug/sessions/:role/translation/input",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      return deps.translationService.translateUserInput({
        repoRoot: project.repoRoot,
        taskSlug: request.params.taskSlug,
        role,
        ...(request.body ?? { text: "" })
      });
    }
  );

  app.post<{ Params: { taskSlug: string; role: string }; Body: SendTranslatedInputRequest }>(
    "/api/tasks/:taskSlug/sessions/:role/translation/send",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      await deps.translationService.sendTranslatedInput({
        repoRoot: project.repoRoot,
        taskSlug: request.params.taskSlug,
        role,
        englishText: request.body?.englishText ?? ""
      });
      return { ok: true };
    }
  );

  app.post<{ Params: { sessionId: string } }>("/api/translation/sessions/:sessionId/clear", async (request) => {
    await requireCurrentProject(deps.projectService);
    deps.translationService.clearSession(request.params.sessionId);
    return { ok: true };
  });

  app.post<{ Params: { sessionId: string; translationId: string } }>(
    "/api/translation/sessions/:sessionId/retry/:translationId",
    async (request) => {
      await requireCurrentProject(deps.projectService);
      return deps.translationService.retryTranslation(request.params.sessionId, request.params.translationId);
    }
  );
}

function parseRole(role: string) {
  if (!isRoleName(role)) {
    throw new VcmError({
      code: "UNKNOWN_ROLE",
      message: `Unknown role: ${role}`,
      statusCode: 400
    });
  }
  return role;
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

