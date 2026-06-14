import type { FastifyInstance } from "fastify";
import type {
  CodexHookRequest,
  CodexStopHookResponse
} from "../../shared/types/codex-hook.js";
import type { CodexHookService } from "../services/codex-hook-service.js";

export interface CodexHookRouteDeps {
  codexHookService: CodexHookService;
}

export function registerCodexHookRoutes(app: FastifyInstance, deps: CodexHookRouteDeps): void {
  app.post<{ Body: CodexHookRequest }>("/api/hooks/codex-reviewer", async (request) => {
    return deps.codexHookService.handleHook(request.body);
  });

  app.post<{ Body: CodexHookRequest }>("/api/hooks/codex-reviewer/stop", async (request): Promise<CodexStopHookResponse> => {
    await deps.codexHookService.handleStopHook(request.body);
    return {};
  });
}
