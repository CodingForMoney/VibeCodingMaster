import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerMessageRoutes } from "../../../src/backend/api/message-routes.js";

describe("message routes", () => {
  it("does not expose a public scan endpoint that can dispatch role messages", async () => {
    const app = Fastify({ logger: false });

    registerMessageRoutes(app, {
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
      messageService: {
        async listMessages() {
          return [];
        },
        async listPendingRouteFiles() {
          return [];
        },
        async scanAndDispatchPendingRouteFiles() {
          throw new Error("public scan endpoint must not call dispatch");
        },
        async markAllDone() {
          return {
            taskSlug: "demo-task",
            updatedCount: 0,
            messages: []
          };
        },
        async deleteMessageHistory() {
          return {
            taskSlug: "demo-task",
            deletedCount: 0,
            messages: []
          };
        },
        async getOrchestrationState() {
          return {
            taskSlug: "demo-task",
            mode: "manual",
            updatedAt: "2026-06-02T00:00:00.000Z"
          };
        },
        async updateOrchestrationState() {
          return {
            taskSlug: "demo-task",
            mode: "manual",
            updatedAt: "2026-06-02T00:00:00.000Z"
          };
        },
        async confirmPromptSubmitted() {
          return undefined;
        }
      }
    } as never);

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/demo-task/messages/scan"
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
