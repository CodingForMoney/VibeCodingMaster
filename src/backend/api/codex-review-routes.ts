import type { FastifyInstance } from "fastify";
import type { CodexReviewExceptionRequest } from "../../shared/types/codex-review.js";
import { VcmError } from "../errors.js";
import { isCodexReviewGate, type CodexReviewService } from "../services/codex-review-service.js";
import type { ProjectService } from "../services/project-service.js";

export interface CodexReviewRouteDeps {
  projectService: ProjectService;
  codexReviewService: CodexReviewService;
}

export function registerCodexReviewRoutes(app: FastifyInstance, deps: CodexReviewRouteDeps): void {
  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/codex-review", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.codexReviewService.getState(project.repoRoot, request.params.taskSlug);
  });

  app.post<{ Params: { taskSlug: string; gate: string } }>(
    "/api/tasks/:taskSlug/codex-review/:gate/request",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const gate = parseGate(request.params.gate);
      return deps.codexReviewService.requestReviewGate(project.repoRoot, request.params.taskSlug, gate);
    }
  );

  app.post<{ Params: { taskSlug: string; gate: string } }>(
    "/api/tasks/:taskSlug/codex-review/:gate/retry",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const gate = parseGate(request.params.gate);
      return deps.codexReviewService.retryReviewGate(project.repoRoot, request.params.taskSlug, gate);
    }
  );

  app.post<{ Params: { taskSlug: string; gate: string }; Body: CodexReviewExceptionRequest }>(
    "/api/tasks/:taskSlug/codex-review/:gate/skip",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const gate = parseGate(request.params.gate);
      return deps.codexReviewService.skipReviewGate(project.repoRoot, request.params.taskSlug, gate, request.body);
    }
  );

  app.post<{ Params: { taskSlug: string; gate: string }; Body: CodexReviewExceptionRequest }>(
    "/api/tasks/:taskSlug/codex-review/:gate/override",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const gate = parseGate(request.params.gate);
      return deps.codexReviewService.overrideReviewGate(project.repoRoot, request.params.taskSlug, gate, request.body);
    }
  );

  app.get<{ Params: { taskSlug: string; gate: string } }>(
    "/api/tasks/:taskSlug/codex-review/:gate/report",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const gate = parseGate(request.params.gate);
      return deps.codexReviewService.readReport(project.repoRoot, request.params.taskSlug, gate);
    }
  );
}

function parseGate(gate: string) {
  if (!isCodexReviewGate(gate)) {
    throw new VcmError({
      code: "UNKNOWN_CODEX_REVIEW_GATE",
      message: `Unknown Codex review gate: ${gate}`,
      statusCode: 400
    });
  }
  return gate;
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
