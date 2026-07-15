import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  injectOk
} from "./helpers/e2e-actions.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("backend E2E task harness retrospective with mock Claude Code", () => {
  it("does not dispatch Harness Engineer before final acceptance is ready", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-harness-review");

    const notReady = await env.app.inject({
      method: "POST",
      url: "/api/projects/harness/task-retrospective",
      payload: { taskSlug: task.taskSlug, trigger: "manual" }
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.body).toContain("TASK_FINAL_ACCEPTANCE_NOT_READY");

    const session = await injectOk(env.app, {
      method: "GET",
      url: "/api/projects/harness/engineer/session"
    });
    expect(session.json()).toBeNull();
  });
});
