import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerCodexHookRoutes } from "../../../src/backend/api/codex-hook-routes.js";
import type { CodexHookService } from "../../../src/backend/services/codex-hook-service.js";

describe("codex hook routes", () => {
  it("returns the empty Stop hook contract after recording Codex Stop", async () => {
    const calls: string[] = [];
    const app = Fastify({ logger: false });
    registerCodexHookRoutes(app, {
      codexHookService: {
        async handleHook() {
          throw new Error("not used");
        },
        async handleStopHook(input) {
          calls.push(`${input.taskSlug}:${input.role}:${input.event.hook_event_name}`);
          return {
            ok: true,
            eventName: "Stop",
            taskSlug: input.taskSlug,
            role: input.role,
            sessionUpdated: true
          };
        }
      } as CodexHookService
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/hooks/codex-reviewer/stop",
      payload: {
        taskSlug: "demo-task",
        role: "codex-reviewer",
        event: { hook_event_name: "Stop" }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
    expect(calls).toEqual(["demo-task:codex-reviewer:Stop"]);
    await app.close();
  });
});
