import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerRoundRoutes } from "../../../src/backend/api/round-routes.js";

describe("round routes", () => {
  it("degrades round state when the backend hits the open-files limit", async () => {
    const app = Fastify({ logger: false });

    registerRoundRoutes(app, {
      projectService: {
        async getCurrentProject() {
          return {
            repoRoot: "/repo"
          };
        },
        async loadConfig() {
          return {
            stateRoot: ".ai/vcm"
          };
        }
      },
      taskService: {
        async loadTask() {
          return {
            taskSlug: "demo-task",
            handoffDir: ".ai/vcm/handoffs"
          };
        }
      },
      roundService: {
        async getSessionRoundState() {
          throw Object.assign(new Error("EMFILE: too many open files"), {
            code: "EMFILE"
          });
        },
        async recordRoleTurnEvent() {
          throw new Error("not used");
        },
        async recordClaudeHookEvent() {
          throw new Error("not used");
        },
        stopSession() {},
        stopTask() {}
      }
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/demo-task/round"
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.taskSlug).toBe("demo-task");
    expect(payload.status).toBe("stopped");
    expect(payload.totalRoundCount).toBe(0);
    await app.close();
  });
});
