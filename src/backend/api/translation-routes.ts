import type { FastifyInstance } from "fastify";
import { isVcmRoleName } from "../../shared/constants.js";
import type {
  SendTranslatedInputRequest,
  TranslateManualOutputRequest,
  TranslateUserInputRequest
} from "../../shared/types/translation.js";
import { VcmError } from "../errors.js";
import type { ProjectService } from "../services/project-service.js";
import type { SessionService } from "../services/session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";
import type { TranslationService } from "../services/translation-service.js";

export interface TranslationRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: Pick<SessionService, "notifyProjectTranslatorHarnessUpdated">;
  translationService: TranslationService;
}

export function registerTranslationRoutes(app: FastifyInstance, deps: TranslationRouteDeps): void {
  app.post<{ Params: { taskSlug: string; role: string } }>(
    "/api/tasks/:taskSlug/sessions/:role/translation/start",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      return deps.translationService.startSession({
        repoRoot: project.repoRoot,
        taskRepoRoot: getTaskRuntimeRepoRoot(task),
        taskSlug: request.params.taskSlug,
        role
      });
    }
  );

  app.get<{ Params: { sessionId: string }; Querystring: { after?: string; limit?: string } }>(
    "/api/translation/sessions/:sessionId/events",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      return deps.translationService.pollSessionEvents(
        request.params.sessionId,
        Number(request.query.after ?? "1"),
        request.query.limit === undefined ? undefined : Number(request.query.limit),
        { repoRoot: project.repoRoot }
      );
    }
  );

  app.get<{ Params: { taskSlug: string }; Querystring: { after?: string; limit?: string } }>(
    "/api/tasks/:taskSlug/translation/feed",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      return deps.translationService.pollTaskFeed({
        repoRoot: project.repoRoot,
        taskRepoRoot: getTaskRuntimeRepoRoot(task),
        taskSlug: request.params.taskSlug,
        after: Number(request.query.after ?? "1"),
        limit: request.query.limit === undefined ? undefined : Number(request.query.limit)
      });
    }
  );

  app.post<{ Params: { taskSlug: string; role: string }; Body: TranslateUserInputRequest }>(
    "/api/tasks/:taskSlug/sessions/:role/translation/input",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      return deps.translationService.translateUserInput({
        repoRoot: project.repoRoot,
        taskRepoRoot: getTaskRuntimeRepoRoot(task),
        taskSlug: request.params.taskSlug,
        role,
        ...(request.body ?? { text: "" })
      });
    }
  );

  app.post<{ Params: { taskSlug: string; role: string }; Body: TranslateManualOutputRequest }>(
    "/api/tasks/:taskSlug/sessions/:role/translation/manual-output",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      return deps.translationService.translateManualOutput({
        repoRoot: project.repoRoot,
        taskRepoRoot: getTaskRuntimeRepoRoot(task),
        taskSlug: request.params.taskSlug,
        role,
        text: request.body?.text ?? ""
      });
    }
  );

  app.post<{ Params: { taskSlug: string; role: string }; Body: SendTranslatedInputRequest }>(
    "/api/tasks/:taskSlug/sessions/:role/translation/send",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      await deps.translationService.sendTranslatedInput({
        repoRoot: project.repoRoot,
        taskRepoRoot: getTaskRuntimeRepoRoot(task),
        taskSlug: request.params.taskSlug,
        role,
        englishText: request.body?.englishText ?? ""
      });
      return { ok: true };
    }
  );

  app.post<{ Params: { sessionId: string } }>("/api/translation/sessions/:sessionId/clear", async (request) => {
    await requireCurrentProject(deps.projectService);
    await deps.translationService.clearSession(request.params.sessionId);
    return { ok: true };
  });

  app.post<{ Params: { sessionId: string } }>("/api/translation/sessions/:sessionId/stop", async (request) => {
    await requireCurrentProject(deps.projectService);
    await deps.translationService.stopSession(request.params.sessionId);
    return { ok: true };
  });

  app.post("/api/projects/translation/session/notify-harness", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.notifyProjectTranslatorHarnessUpdated(project.repoRoot);
  });

  app.post<{ Params: { sessionId: string; translationId: string } }>(
    "/api/translation/sessions/:sessionId/retry/:translationId",
    async (request) => {
      await requireCurrentProject(deps.projectService);
      return deps.translationService.retryTranslation(request.params.sessionId, request.params.translationId);
    }
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/translation/sessions/:sessionId/failures/ignore",
    async (request) => {
      await requireCurrentProject(deps.projectService);
      return deps.translationService.ignoreTranslationFailures(request.params.sessionId);
    }
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/translation/sessions/:sessionId/failures/retry",
    async (request) => {
      await requireCurrentProject(deps.projectService);
      return deps.translationService.retryFailedTranslations(request.params.sessionId);
    }
  );
}

function parseRole(role: string) {
  if (!isVcmRoleName(role)) {
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
