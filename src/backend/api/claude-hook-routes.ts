import type { FastifyInstance } from "fastify";
import type { ClaudeHookRequest } from "../../shared/types/claude-hook.js";
import type { ClaudeHookService } from "../services/claude-hook-service.js";

export interface ClaudeHookRouteDeps {
  claudeHookService: ClaudeHookService;
}

export function registerClaudeHookRoutes(app: FastifyInstance, deps: ClaudeHookRouteDeps): void {
  app.post<{ Body: ClaudeHookRequest }>("/api/hooks/claude-code", async (request) => {
    return deps.claudeHookService.handleHook(request.body);
  });

  app.post<{ Body: ClaudeHookRequest }>("/api/hooks/claude-code/stop", async (request) => {
    return deps.claudeHookService.handleStopHook(request.body);
  });
}
