import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  connectAndCreateTask,
  connectProject,
  getWorkspaceState,
  resumeRole,
  startRole,
  waitFor
} from "./helpers/e2e-actions.js";
import { createMockClaudeE2eApp, type MockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";

describe("backend E2E runtime restart recovery", () => {
  it("dismisses a stall warning without interrupting the role Session or Round", async () => {
    const repo = await createE2eRepo();
    const e2e = await createMockClaudeE2eApp();

    try {
      const task = await connectAndCreateTask(e2e.app, repo, "mock-stall-ignore");
      e2e.mockRuntime.onPrompt("coder", "Wait for model output", async (ctx) => {
        await ctx.userPromptSubmit();
      });

      const session = await startRole(e2e.app, task.taskSlug, "coder");
      e2e.mockRuntime.write(session.id, "Wait for model output");
      await e2e.mockRuntime.waitForIdle();
      let warningId = "";
      await waitFor(async () => {
        const workspace = await getWorkspaceState(e2e.app, task.taskSlug);
        expect(workspace.roleStallWarning).toMatchObject({
          role: "coder",
          phase: "awaiting-model"
        });
        warningId = workspace.roleStallWarning!.id;
      });

      const ignored = await e2e.app.inject({
        method: "POST",
        url: `/api/tasks/${task.taskSlug}/role-stall/ignore`,
        payload: { warningId }
      });
      expect(ignored.statusCode).toBe(200);

      const workspace = await getWorkspaceState(e2e.app, task.taskSlug);
      expect(workspace.roleStallWarning).toBeNull();
      expect(workspace.taskStatus.sessions.find((entry) => entry.role === "coder")).toMatchObject({
        id: session.id,
        status: "running",
        activityStatus: "running"
      });
      expect(workspace.roundState).toMatchObject({
        status: "running",
        activeRole: "coder"
      });
    } finally {
      await e2e.close();
      await repo.cleanup();
    }
  });

  it("warns about a stalled role and recovers only after the user requests it", async () => {
    const repo = await createE2eRepo();
    const e2e = await createMockClaudeE2eApp();

    try {
      const task = await connectAndCreateTask(e2e.app, repo, "mock-lsp-stall");
      e2e.mockRuntime.onPrompt("architect", "Run semantic analysis", async (ctx) => {
        await ctx.userPromptSubmit();
        await ctx.hook("PreToolUse", {
          tool_name: "LSP",
          tool_use_id: "lsp-call-1",
          tool_input: { operation: "findReferences" }
        });
      });

      const originalRuntime = await startRole(e2e.app, task.taskSlug, "architect");
      e2e.mockRuntime.write(originalRuntime.id, "Run semantic analysis");
      await e2e.mockRuntime.waitForIdle();
      const before = await getWorkspaceState(e2e.app, task.taskSlug);
      const originalSession = before.taskStatus.sessions.find((entry) => entry.role === "architect");
      expect(originalSession?.claudeSessionId).toBeTruthy();

      await waitFor(async () => {
        const workspace = await getWorkspaceState(e2e.app, task.taskSlug);
        expect(workspace.roleStallWarning).toMatchObject({
          role: "architect",
          phase: "tool-running",
          toolName: "LSP",
          toolUseId: "lsp-call-1"
        });
      });
      expect(e2e.mockRuntime.getWrites(originalRuntime.id)).toEqual(["Run semantic analysis"]);

      const warning = (await getWorkspaceState(e2e.app, task.taskSlug)).roleStallWarning!;
      const recovery = await e2e.app.inject({
        method: "POST",
        url: `/api/tasks/${task.taskSlug}/role-stall/recover`,
        payload: { warningId: warning.id }
      });
      expect(recovery.statusCode).toBe(200);

      const workspace = await getWorkspaceState(e2e.app, task.taskSlug);
      const recovered = workspace.taskStatus.sessions.find((entry) => entry.role === "architect");
      expect(recovered).toMatchObject({
        status: "running",
        activityStatus: "running",
        claudeSessionId: originalSession?.claudeSessionId
      });
      expect(recovered?.id).not.toBe(originalRuntime.id);
      expect(workspace.roleStallWarning).toBeNull();
      expect(workspace.roundState).toMatchObject({
        status: "running",
        activeRole: "architect"
      });
      expect(workspace.roundState.flowPause).toBeUndefined();
    } finally {
      await e2e.close();
      await repo.cleanup();
    }
  });

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

  it("does not infer turn completion from transcript end_turn when Stop is blocked", async () => {
    const repo = await createE2eRepo();
    const e2e = await createMockClaudeE2eApp();

    try {
      const task = await connectAndCreateTask(e2e.app, repo, "mock-blocked-stop");
      let architectPrompted = false;
      e2e.mockRuntime.onPrompt("architect", "Route that must remain pending", () => {
        architectPrompted = true;
      });
      e2e.mockRuntime.onPrompt("coder", "Keep this turn alive", async (ctx) => {
        await ctx.userPromptSubmit();
        await ctx.appendTranscriptText("The transcript contains a parent end_turn.");
        await ctx.writeFile(".ai/vcm/handoffs/messages/coder-architect.md", [
          "---",
          "type: task",
          "---",
          "Route that must remain pending",
          ""
        ].join("\n"));
        await ctx.writeFile(".ai/vcm/jobs/still-running/status.json", JSON.stringify({
          jobId: "still-running",
          status: "running",
          processId: process.pid
        }));
        await ctx.stop();
      });

      await startRole(e2e.app, task.taskSlug, "architect");
      const coder = await startRole(e2e.app, task.taskSlug, "coder");
      e2e.mockRuntime.write(coder.id, "Keep this turn alive");
      await e2e.mockRuntime.waitForIdle();

      await e2e.deps.runtimeCoordinator.reconcileProject(repo.repoRoot, {
        taskSlug: task.taskSlug
      });
      await e2e.deps.runtimeCoordinator.reconcileProject(repo.repoRoot, {
        taskSlug: task.taskSlug
      });

      const workspace = await getWorkspaceState(e2e.app, task.taskSlug);
      expect(workspace.roundState).toMatchObject({
        status: "running",
        activeRole: "coder"
      });
      expect(workspace.taskStatus.sessions.find((entry) => entry.role === "coder")).toMatchObject({
        activityStatus: "running"
      });
      expect(architectPrompted).toBe(false);
      await expect(fs.readFile(
        `${task.worktreePath}/.ai/vcm/handoffs/messages/coder-architect.md`,
        "utf8"
      )).resolves.toContain("Route that must remain pending");
    } finally {
      await e2e.close();
      await repo.cleanup();
    }
  });

  it("stops an active workflow turn when the terminal process exits", async () => {
    const repo = await createE2eRepo();
    const e2e = await createMockClaudeE2eApp();

    try {
      const task = await connectAndCreateTask(e2e.app, repo, "mock-terminal-exit");
      e2e.mockRuntime.onPrompt("coder", "Crash this terminal", async (ctx) => {
        await ctx.userPromptSubmit();
      });

      const coder = await startRole(e2e.app, task.taskSlug, "coder");
      e2e.mockRuntime.write(coder.id, "Crash this terminal");
      await e2e.mockRuntime.waitForIdle();
      e2e.mockRuntime.exitProcess(coder.id, 17);

      await waitFor(async () => {
        const workspace = await getWorkspaceState(e2e.app, task.taskSlug);
        expect(workspace.roundState).toMatchObject({
          status: "stopped",
          activeRole: "coder",
          stopReason: "terminal-exit",
          flowPause: {
            paused: true,
            reason: "stopped-no-next-turn",
            role: "coder"
          }
        });
        expect(workspace.taskStatus.sessions.find((entry) => entry.role === "coder")).toMatchObject({
          status: "resumable",
          activityStatus: "idle",
          exitCode: 17
        });
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
