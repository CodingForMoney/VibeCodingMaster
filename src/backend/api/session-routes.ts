import type { FastifyInstance } from "fastify";
import { isDispatchableRole, isRoleName } from "../../shared/constants.js";
import type { StartRoleSessionRequest } from "../../shared/types/session.js";
import { VcmError } from "../errors.js";
import type { CommandDispatcher } from "../services/command-dispatcher.js";
import type { ProjectService } from "../services/project-service.js";
import type { RoundService } from "../services/round-service.js";
import type { SessionService } from "../services/session-service.js";
import type { TranslationService } from "../services/translation-service.js";

export interface SessionRouteDeps {
  projectService: ProjectService;
  sessionService: SessionService;
  commandDispatcher: CommandDispatcher;
  translationService: Pick<TranslationService, "stopSession">;
  roundService: Pick<RoundService, "stopSession">;
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/sessions", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.sessionService.listRoleSessions(project.repoRoot, request.params.taskSlug);
  });

  app.post<{ Params: { taskSlug: string; role: string }; Body: StartRoleSessionRequest }>(
    "/api/tasks/:taskSlug/sessions/:role/start",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      return deps.sessionService.startRoleSession(project.repoRoot, request.params.taskSlug, role, request.body);
    }
  );

  app.post<{ Params: { taskSlug: string; role: string } }>(
    "/api/tasks/:taskSlug/sessions/:role/stop",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      const session = await deps.sessionService.stopRoleSession(project.repoRoot, request.params.taskSlug, role);
      await deps.translationService.stopSession(session.id);
      deps.roundService.stopSession(session.id);
      return session;
    }
  );

  app.post<{ Params: { taskSlug: string; role: string }; Body: StartRoleSessionRequest }>(
    "/api/tasks/:taskSlug/sessions/:role/restart",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      const existing = await deps.sessionService.getRoleSession(project.repoRoot, request.params.taskSlug, role);
      if (existing) {
        await deps.translationService.stopSession(existing.id, { clearCache: true });
        deps.roundService.stopSession(existing.id);
      }
      return deps.sessionService.restartRoleSession(project.repoRoot, request.params.taskSlug, role, request.body);
    }
  );

  app.post<{ Params: { taskSlug: string; role: string }; Body: StartRoleSessionRequest }>(
    "/api/tasks/:taskSlug/sessions/:role/resume",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      return deps.sessionService.resumeRoleSession(project.repoRoot, request.params.taskSlug, role, request.body);
    }
  );

  app.post<{ Params: { taskSlug: string; role: string } }>(
    "/api/tasks/:taskSlug/sessions/:role/notify-harness",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseRole(request.params.role);
      return deps.sessionService.notifyRoleHarnessUpdated(project.repoRoot, request.params.taskSlug, role);
    }
  );

  app.post<{ Params: { taskSlug: string; role: string } }>(
    "/api/tasks/:taskSlug/sessions/:role/dispatch",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      if (!isDispatchableRole(request.params.role)) {
        throw new VcmError({
          code: "ROLE_NOT_DISPATCHABLE",
          message: `${request.params.role} cannot receive role commands.`,
          statusCode: 400
        });
      }
      return deps.commandDispatcher.dispatchRoleCommand({
        repoRoot: project.repoRoot,
        taskSlug: request.params.taskSlug,
        role: request.params.role
      });
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
