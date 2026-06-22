import type { FastifyInstance } from "fastify";
import type { DiagnosticsService } from "../services/diagnostics-service.js";

export interface DiagnosticsRouteDeps {
  diagnosticsService: DiagnosticsService;
}

export function registerDiagnosticsRoutes(app: FastifyInstance, deps: DiagnosticsRouteDeps): void {
  app.get("/api/diagnostics/runtime", async () => {
    return deps.diagnosticsService.getRuntimeDiagnostics();
  });
}
