import type { FastifyInstance } from "fastify";
import type { ClaudeHookRequest, ClaudeStopHookResponse } from "../../shared/types/claude-hook.js";
import type { ClaudeHookService } from "../services/claude-hook-service.js";

export interface ClaudeHookRouteDeps {
  claudeHookService: ClaudeHookService;
}

export function registerClaudeHookRoutes(app: FastifyInstance, deps: ClaudeHookRouteDeps): void {
  app.post<{ Body: ClaudeHookRequest }>("/api/hooks/claude-code", async (request) => {
    return deps.claudeHookService.handleHook(request.body);
  });

  // The installed Stop hook pipes this response straight to Claude Code, so
  // the body must be exactly the Stop-hook stdout contract.
  app.post<{ Body: ClaudeHookRequest }>("/api/hooks/claude-code/stop", async (request): Promise<ClaudeStopHookResponse> => {
    const result = await deps.claudeHookService.handleStopHook(request.body);
    if (result.stopDecision) {
      return { decision: "block", reason: result.stopDecision.reason };
    }
    return {};
  });

  app.post<{ Body: ClaudeHookRequest }>("/api/hooks/claude-code/permission-request", async (request, reply) => {
    const result = await deps.claudeHookService.handlePermissionRequestHook(request.body);
    if (!result) {
      return reply.code(204).send();
    }
    return result;
  });
}
