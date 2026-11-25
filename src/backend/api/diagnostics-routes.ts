import type { FastifyInstance } from "fastify";
import type { DiagnosticsService } from "../services/diagnostics-service.js";

export interface DiagnosticsRouteDeps {
  diagnosticsService: DiagnosticsService;
}

export function registerDiagnosticsRoutes(app: FastifyInstance, deps: DiagnosticsRouteDeps): void {
  app.get("/api/diagnostics/runtime", async () => {
    return deps.diagnosticsService.getRuntimeDiagnostics();
  });

  app.get<{ Querystring: { taskSlug?: string; role?: string; limit?: string } }>(
    "/api/diagnostics/hook-events",
    async (request) => {
      const limit = Number.parseInt(request.query.limit ?? "", 10);
      return deps.diagnosticsService.getHookEventDiagnostics({
        taskSlug: request.query.taskSlug || undefined,
        role: request.query.role || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined
      });
    }
  );
}
