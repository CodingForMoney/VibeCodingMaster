import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerWorkflowControlRoutes } from "../../../src/backend/api/workflow-control-routes.js";

describe("workflow control routes", () => {
  it("records direct user authorization and notifies an idle Project Manager", async () => {
    const app = Fastify({ logger: false });
    const writes: string[] = [];
    const approvals: Array<{ overrideId: string; authorizationText: string }> = [];
    const runningMarks: string[] = [];
    const state = {
      version: 1 as const,
      taskSlug: "task-1",
      pendingDispatch: null,
      activeDispatch: null,
      overrideRequests: [],
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
      sessionService: {
        async getRoleSession() {
          return {
            id: "pm-session",
            role: "project-manager",
            status: "running",
            activityStatus: "idle"
          };
        },
        async markRoleActivityRunning(_repoRoot: string, _taskSlug: string, _role: string, sessionId: string) {
          runningMarks.push(sessionId);
        }
      } as never,
      workflowControlService: {
        async approveOverride(_context, overrideId, authorizationText) {
          approvals.push({ overrideId, authorizationText });
          return state;
        }
      } as never,
      runtime: {
        write(_sessionId: string, data: string) {
          writes.push(data);
        }
      } as never
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/workflow-overrides/override-1/approve",
      payload: { authorizationText: "Allow this exact Architect dispatch once." }
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(approvals).toEqual([{
      overrideId: "override-1",
      authorizationText: "Allow this exact Architect dispatch once."
    }]);
    expect(writes.join("\n")).toContain("Authorization ID: override-1");
    expect(writes.join("\n")).toContain("Authorization Text: Allow this exact Architect dispatch once.");
    expect(runningMarks).toEqual(["pm-session"]);
    await app.close();
  });
});
