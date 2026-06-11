import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerClaudeHookRoutes } from "../../../src/backend/api/claude-hook-routes.js";
import type { ClaudeHookService } from "../../../src/backend/services/claude-hook-service.js";

describe("claude hook routes", () => {
  it("returns an empty PermissionRequest response when VCM is not auto-approving", async () => {
    const app = Fastify({ logger: false });
    registerClaudeHookRoutes(app, {
      claudeHookService: createHookServiceStub(undefined)
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/hooks/claude-code/permission-request",
      payload: {
        taskSlug: "demo-task",
        role: "coder",
        event: {
          hook_event_name: "PermissionRequest"
        }
      }
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    await app.close();
  });

  it("returns an allow decision for PermissionRequest auto-approval", async () => {
    const app = Fastify({ logger: false });
    registerClaudeHookRoutes(app, {
      claudeHookService: createHookServiceStub({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "allow"
          }
        }
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/hooks/claude-code/permission-request",
      payload: {
        taskSlug: "demo-task",
        role: "coder",
        event: {
          hook_event_name: "PermissionRequest"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow"
        }
      }
    });
    await app.close();
  });
});

function createHookServiceStub(
  permissionResult: Awaited<ReturnType<ClaudeHookService["handlePermissionRequestHook"]>>
): ClaudeHookService {
  return {
    async handleHook() {
      throw new Error("not used");
    },
    async handleStopHook() {
      throw new Error("not used");
    },
    async handlePermissionRequestHook() {
      return permissionResult;
    }
  };
}
