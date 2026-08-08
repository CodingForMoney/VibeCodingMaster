import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerWorkflowControlRoutes } from "../../../src/backend/api/workflow-control-routes.js";

describe("workflow control routes", () => {
  it("exposes workflow state without user-approval callback routes", async () => {
    const app = Fastify({ logger: false });
    const state = {
      version: 1 as const,
      taskSlug: "task-1",
      pendingDispatch: null,
      activeDispatch: null,
      flowRun: null,
      userAuthorizations: [],
      warnings: [],
      updatedAt: "2026-08-06T00:00:00.000Z"
    };

    registerWorkflowControlRoutes(app, {
      projectService: {
        async getCurrentProject() {
          return { repoRoot: "/repo" };
        },
        async loadConfig() {
          return { stateRoot: ".ai/vcm" };
        }
      } as never,
      taskService: {
        async loadTask() {
          return {
            taskSlug: "task-1",
            worktreePath: "/repo/.claude/worktrees/task-1",
            handoffDir: ".ai/vcm/handoffs"
          };
        }
      } as never,
      workflowControlService: {
        async getState() {
          return state;
        }
      } as never
    });

    const stateResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/workflow-control"
    });
    expect(stateResponse.statusCode, stateResponse.body).toBe(200);
    expect(stateResponse.json()).toEqual(state);

    const removedApprovalResponse = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/workflow-overrides/override-1/approve",
      payload: { authorizationText: "Allow it." }
    });
    expect(removedApprovalResponse.statusCode).toBe(404);
    await app.close();
  });
});
