import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  connectAndCreateTask,
  connectProject,
  getWorkspaceState,
  resumeRole,
  startRole
} from "./helpers/e2e-actions.js";
import { createMockClaudeE2eApp, type MockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";

describe("backend E2E runtime restart recovery", () => {
  it("keeps a quiet live parent turn running while a foreground Agent call is unresolved", async () => {
    const repo = await createE2eRepo();
    const fixedNow = "2000-01-01T00:00:00.000Z";
    const e2e = await createMockClaudeE2eApp({ now: () => fixedNow });

    try {
      const task = await connectAndCreateTask(e2e.app, repo, "mock-quiet-subagent");
      e2e.mockRuntime.onPrompt("coder", "Run a quiet worker", async (ctx) => {
        await ctx.userPromptSubmit();
        await fs.appendFile(ctx.transcriptPath, `${JSON.stringify({
          type: "assistant",
          uuid: "parent-agent-dispatch",
          timestamp: fixedNow,
          message: {
            stop_reason: "tool_use",
            content: [{
              type: "tool_use",
              id: "agent-call-1",
              name: "Agent",
              input: {
                description: "Quiet worker",
                prompt: "Complete the assigned module.",
                subagent_type: "vcm-coder-worker"
              }
            }]
          }
        })}\n`, "utf8");
      });

      const session = await startRole(e2e.app, task.taskSlug, "coder");
      e2e.mockRuntime.write(session.id, "Run a quiet worker");
      await e2e.mockRuntime.waitForIdle();

      await e2e.deps.runtimeCoordinator.reconcileProject(repo.repoRoot, {
        taskSlug: task.taskSlug
      });
      await e2e.deps.runtimeCoordinator.reconcileProject(repo.repoRoot, {
        taskSlug: task.taskSlug
      });

      expect(e2e.mockRuntime.getWrites(session.id)).not.toContain("\u0003");
      const workspace = await getWorkspaceState(e2e.app, task.taskSlug);
      expect(workspace.roundState).toMatchObject({
        status: "running",
        activeRole: "coder"
      });
      expect(workspace.taskStatus.sessions.find((entry) => entry.role === "coder")).toMatchObject({
        status: "running",
        activityStatus: "running"
      });
    } finally {
      await e2e.close();
      await repo.cleanup();
    }
  });

  it("recovers stale role and round state before resuming the role in a new backend process", async () => {
    const repo = await createE2eRepo();
    const first = await createMockClaudeE2eApp();
    const tempRoot = first.tempRoot;
    let firstClosed = false;
    let second: MockClaudeE2eApp | undefined;

    try {
      const task = await connectAndCreateTask(first.app, repo, "mock-runtime-recovery");
      first.mockRuntime.onPrompt("coder", "Leave this turn active across restart", async (ctx) => {
        await ctx.userPromptSubmit();
        await ctx.writeOutput("Coder remains active while the backend restarts.\n");
      });

      const originalSession = await startRole(first.app, task.taskSlug, "coder");
      first.mockRuntime.write(originalSession.id, "Leave this turn active across restart");
      await first.mockRuntime.waitForIdle();

      const beforeRestart = await getWorkspaceState(first.app, task.taskSlug);
      const originalRecord = beforeRestart.taskStatus.sessions.find((session) => session.role === "coder");
      expect(originalRecord).toMatchObject({
        id: originalSession.id,
        status: "running",
        activityStatus: "running"
      });
      expect(originalRecord?.claudeSessionId).toMatch(/^mock-claude-coder-/);
      expect(beforeRestart.roundState.status).toBe("running");

      await first.close({ preserveTempRoot: true });
      firstClosed = true;
      second = await createMockClaudeE2eApp({ tempRoot });
      await connectProject(second.app, repo.repoRoot);

      const recovered = await getWorkspaceState(second.app, task.taskSlug);
      const recoveredCoder = recovered.taskStatus.sessions.find((session) => session.role === "coder");
      expect(recoveredCoder).toMatchObject({
        status: "resumable",
        activityStatus: "idle",
        claudeSessionId: originalRecord?.claudeSessionId
      });
      expect(recovered.taskStatus.task.status).toBe("stopped");
      expect(recovered.roundState).toMatchObject({
        status: "stopped",
        stopReason: "runtime-recovery"
      });
      expect(recovered.roundState.roleRecovery).toBeUndefined();
      expect(second.mockRuntime.listSessions(task.taskSlug)).toEqual([]);

      const resumed = await resumeRole(second.app, task.taskSlug, "coder");
      expect(resumed.status).toBe("running");
      expect(resumed.claudeSessionId).toBe(originalRecord?.claudeSessionId);
      expect(resumed.command).toContain(`--resume ${originalRecord?.claudeSessionId}`);
      expect(second.mockRuntime.getSession(resumed.id)?.status).toBe("running");
      expect(second.mockRuntime.listSessions(task.taskSlug)).toHaveLength(1);
    } finally {
      if (second) {
        await second.close();
      } else if (!firstClosed) {
        await first.close();
      } else {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
      await repo.cleanup();
    }
  });
});
