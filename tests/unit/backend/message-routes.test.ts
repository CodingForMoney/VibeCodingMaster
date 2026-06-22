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

  it("degrades orchestration state when the backend hits the open-files limit", async () => {
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
          return [];
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
          throw Object.assign(new Error("EMFILE: too many open files"), {
            code: "EMFILE"
          });
        },
        async updateOrchestrationState() {
          throw new Error("not used");
        },
        async confirmPromptSubmitted() {
          return undefined;
        }
      }
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/demo-task/orchestration"
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.mode).toBe("auto");
    expect(payload.warning).toContain("open-files limit");
    await app.close();
  });

  it("degrades message listing when the backend hits the open-files limit", async () => {
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
          throw Object.assign(new Error("EMFILE: too many open files"), {
            code: "EMFILE"
          });
        },
        async listPendingRouteFiles() {
          return [];
        },
        async scanAndDispatchPendingRouteFiles() {
          return [];
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
            mode: "auto",
            updatedAt: "2026-06-02T00:00:00.000Z"
          };
        },
        async updateOrchestrationState() {
          throw new Error("not used");
        },
        async confirmPromptSubmitted() {
          return undefined;
        }
      }
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/demo-task/messages"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    await app.close();
  });
});
