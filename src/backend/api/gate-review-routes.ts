import type { FastifyInstance } from "fastify";
import type {
  GateReviewExceptionRequest,
  GateReviewSettingsUpdateRequest
} from "../../shared/types/gate-review.js";
import { VcmError } from "../errors.js";
import { isGateReviewGate, type GateReviewService } from "../services/gate-review-service.js";
import type { ProjectService } from "../services/project-service.js";

export interface GateReviewRouteDeps {
  projectService: ProjectService;
  gateReviewService: GateReviewService;
}

export function registerGateReviewRoutes(app: FastifyInstance, deps: GateReviewRouteDeps): void {
  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/gate-review", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.gateReviewService.getState(project.repoRoot, request.params.taskSlug);
  });

  app.put<{ Params: { taskSlug: string }; Body: GateReviewSettingsUpdateRequest }>(
    "/api/tasks/:taskSlug/gate-review/settings",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      return deps.gateReviewService.updateSettings(project.repoRoot, request.params.taskSlug, request.body);
    }
  );

  app.post<{ Params: { taskSlug: string; gate: string } }>(
    "/api/tasks/:taskSlug/gate-review/:gate/request",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const gate = parseGate(request.params.gate);
      return deps.gateReviewService.requestReviewGate(project.repoRoot, request.params.taskSlug, gate);
    }
  );

  app.post<{ Params: { taskSlug: string; gate: string } }>(
    "/api/tasks/:taskSlug/gate-review/:gate/retry",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const gate = parseGate(request.params.gate);
      return deps.gateReviewService.retryReviewGate(project.repoRoot, request.params.taskSlug, gate);
    }
  );

  app.post<{ Params: { taskSlug: string; gate: string }; Body: GateReviewExceptionRequest }>(
    "/api/tasks/:taskSlug/gate-review/:gate/skip",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const gate = parseGate(request.params.gate);
      return deps.gateReviewService.skipReviewGate(project.repoRoot, request.params.taskSlug, gate, request.body);
    }
  );

  app.post<{ Params: { taskSlug: string; gate: string }; Body: GateReviewExceptionRequest }>(
    "/api/tasks/:taskSlug/gate-review/:gate/override",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const gate = parseGate(request.params.gate);
      return deps.gateReviewService.overrideReviewGate(project.repoRoot, request.params.taskSlug, gate, request.body);
    }
  );

  app.get<{ Params: { taskSlug: string; gate: string } }>(
    "/api/tasks/:taskSlug/gate-review/:gate/report",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const gate = parseGate(request.params.gate);
      return deps.gateReviewService.readReport(project.repoRoot, request.params.taskSlug, gate);
    }
  );
}

function parseGate(gate: string) {
  if (!isGateReviewGate(gate)) {
    throw new VcmError({
      code: "UNKNOWN_GATE_REVIEW_GATE",
      message: `Unknown Gate review gate: ${gate}`,
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
