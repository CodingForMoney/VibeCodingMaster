import { afterEach, describe, expect, it } from "vitest";
import type { CodeIntelligenceQueryRequest } from "../../../src/shared/types/code-intelligence.js";
import type { CodeIntelligenceManager } from "../../../src/backend/services/code-intelligence-service.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { connectAndCreateTask, startRole } from "./helpers/e2e-actions.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("shared code intelligence E2E", () => {
  it("activates the task workspace and serves authenticated role queries through one manager", async () => {
    const activatedRoots: string[] = [];
    const queries: Array<{ taskRepoRoot: string; request: CodeIntelligenceQueryRequest }> = [];
    const manager = trackingManager(activatedRoots, queries);
    const env = await createMockClaudeE2eApp({ codeIntelligenceManager: manager });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "shared-code-intelligence");
    const architect = await startRole(env.app, task.taskSlug, "architect");
    const coder = await startRole(env.app, task.taskSlug, "coder");

    for (const session of [architect, coder]) {
      const response = await env.app.inject({
        method: "POST",
        url: "/api/code-intelligence/query",
        payload: {
          taskSlug: task.taskSlug,
          role: session.role,
          runtimeSessionToken: session.runtimeSessionToken,
          operation: "status"
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ status: "resolved", operation: "status" });
    }

    expect(activatedRoots).toContain(task.worktreePath);
    expect(queries).toHaveLength(2);
    expect(new Set(queries.map((entry) => entry.taskRepoRoot))).toEqual(new Set([task.worktreePath]));
    expect(queries.map((entry) => entry.request.role)).toEqual(["architect", "coder"]);
  });

  it("rejects a stale role session token before querying the shared manager", async () => {
    const queries: Array<{ taskRepoRoot: string; request: CodeIntelligenceQueryRequest }> = [];
    const env = await createMockClaudeE2eApp({ codeIntelligenceManager: trackingManager([], queries) });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "stale-code-intelligence");
    await startRole(env.app, task.taskSlug, "reviewer");

    const response = await env.app.inject({
      method: "POST",
      url: "/api/code-intelligence/query",
      payload: {
        taskSlug: task.taskSlug,
        role: "reviewer",
        runtimeSessionToken: "stale-token",
        operation: "status"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "CODE_INTELLIGENCE_SESSION_STALE" }
    });
    expect(queries).toHaveLength(0);
  });
});

function trackingManager(
  activatedRoots: string[],
  queries: Array<{ taskRepoRoot: string; request: CodeIntelligenceQueryRequest }>
): CodeIntelligenceManager {
  return {
    async activateTask(taskRepoRoot) {
      activatedRoots.push(taskRepoRoot);
    },
    async stopTask() {},
    async shutdown() {},
    async getStatus(taskRepoRoot) {
      return {
        available: true,
        bridgeName: "vcm-code-intelligence-bridge",
        workspaceRoot: taskRepoRoot,
        languages: []
      };
    },
    async query(taskRepoRoot, request) {
      queries.push({ taskRepoRoot, request });
      return {
        status: "resolved",
        operation: request.operation,
        workspaceRoot: taskRepoRoot,
        result: { languages: [] }
      };
    }
  };
}
