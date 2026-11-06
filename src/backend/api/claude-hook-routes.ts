import type { FastifyInstance } from "fastify";
import type { ClaudeHookRequest, ClaudeStopHookResponse } from "../../shared/types/claude-hook.js";
import type { ClaudeHookService } from "../services/claude-hook-service.js";
import type { EnvironmentCheck } from "../services/environment-check.js";
import { VCM_HOOK_PROBE_PATH } from "../services/harness-service.js";

export interface ClaudeHookRouteDeps {
  claudeHookService: ClaudeHookService;
  environmentCheck?: Pick<EnvironmentCheck, "receiveHookProbe">;
}

export function registerClaudeHookRoutes(app: FastifyInstance, deps: ClaudeHookRouteDeps): void {
  // The hook self-test posts here through the installed hook pipeline.
  app.post<{ Body: Partial<ClaudeHookRequest> }>(VCM_HOOK_PROBE_PATH, async (request) => {
    return { received: deps.environmentCheck?.receiveHookProbe(request.body?.runtimeSessionToken) ?? false };
  });

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
