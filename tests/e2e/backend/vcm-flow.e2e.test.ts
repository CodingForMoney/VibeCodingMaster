import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  getWorkspaceState,
  nextTick,
  sleep,
  startRole,
  waitFor
} from "./helpers/e2e-actions.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("backend E2E with mock Claude Code", () => {
  it("routes a PM turn to Architect and back through real hooks, messages, and round state", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-flow");

    env.mockRuntime.onPrompt("project-manager", "Build a small notification feature", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeOutput("PM routing to Architect\n");
      await ctx.appendTranscriptText("I will ask Architect to prepare the plan.");
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-architect.md", [
        "---",
        "type: task",
        "---",
        "Design the accepted notification feature.",
        "",
        "Required output artifact: .ai/vcm/handoffs/architecture-plan.md",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("architect", "Design the accepted notification feature", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeOutput("Architect writing architecture plan\n");
      await ctx.appendTranscriptText("Architecture plan is ready.");
      await ctx.writeFile(".ai/vcm/handoffs/architecture-plan.md", [
        "# Architecture Plan",
        "",
        "Accepted Scope: mock notification feature.",
        "Implementation Plan: add the notification state and rendering path.",
        ""
      ].join("\n"));
      await ctx.writeFile(".ai/vcm/handoffs/messages/architect-project-manager.md", [
        "---",
        "type: result",
        "artifact_refs: .ai/vcm/handoffs/architecture-plan.md",
        "---",
        "Architecture complete. Plan is ready for PM review.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan is ready for PM review.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeOutput("PM final reply\n");
      await ctx.appendTranscriptText("Architecture plan received. Waiting for your next instruction.");
      await ctx.stop();
    });

    await startRole(env.app, task.taskSlug, "project-manager");
    await startRole(env.app, task.taskSlug, "architect");
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    expect(pmSession).toBeDefined();

    env.mockRuntime.write(pmSession!.id, "Build a small notification feature");
    await env.mockRuntime.waitForIdle();

    const taskRepoRoot = task.worktreePath;
    await expect(fs.readFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/architecture-plan.md"), "utf8"))
      .resolves.toContain("Accepted Scope: mock notification feature.");
    await expect(fs.readFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/messages/project-manager-architect.md"), "utf8"))
      .resolves.toBe("");
    await expect(fs.readFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/messages/architect-project-manager.md"), "utf8"))
      .resolves.toBe("");

    const state = await getWorkspaceState(env.app, task.taskSlug);
    expect(state.roundState.status).toBe("stopped");
    expect(state.roundState.flowPause).toMatchObject({
      paused: true,
      reason: "awaiting-user",
      role: "project-manager"
    });
    expect(state.roundState.flowPause?.message).toContain("Architecture plan received");
    expect(state.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromRole: "project-manager",
          toRole: "architect",
          acceptedAt: expect.any(String)
        }),
        expect.objectContaining({
          fromRole: "architect",
          toRole: "project-manager",
          acceptedAt: expect.any(String)
        })
      ])
    );
  });

  it("retries a retryable StopFailure by sending a recovery prompt to the same role session", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-retry");
    let recoveryPromptHandled = false;

    env.mockRuntime.onPrompt("coder", "Implement the retry-sensitive change", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeOutput("Coder hit transient CC failure\n");
      await ctx.stopFailure({
        error: "rate_limit_error",
        errorDetails: "mock transient failure"
      });
    });

    env.mockRuntime.onPrompt("coder", "[VCM Recovery]", async (ctx) => {
      recoveryPromptHandled = true;
      await sleep(20);
      await ctx.userPromptSubmit();
      await nextTick();
      await ctx.writeOutput("Coder recovered and completed\n");
      await ctx.appendTranscriptText("Recovered after transient StopFailure.");
      await ctx.stop();
    });

    await startRole(env.app, task.taskSlug, "coder");
    const coderSession = env.mockRuntime.getSessionByRole(task.taskSlug, "coder");
    expect(coderSession).toBeDefined();

    env.mockRuntime.write(coderSession!.id, "Implement the retry-sensitive change");
    await waitFor(() => recoveryPromptHandled);
    await env.mockRuntime.waitForIdle();

    const writes = env.mockRuntime.getWrites(coderSession!.id).join("\n");
    expect(writes).toContain("[VCM Recovery]");
    const state = await getWorkspaceState(env.app, task.taskSlug);
    expect(state.roundState.roleRecovery).toBeUndefined();
    expect(state.roundState.status).toBe("stopped");
    expect(state.roundState.flowPause).toMatchObject({
      paused: true,
      reason: "stopped-no-next-turn",
      role: "coder"
    });
  });

  it("keeps a manually interrupted turn stopped when a later StopFailure hook arrives", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-manual-interrupt");
    let promptStarted = false;
    let releaseFailure: (() => void) | undefined;
    const failureReleased = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });

    env.mockRuntime.onPrompt("coder", "Interrupt this active turn", async (ctx) => {
      await ctx.userPromptSubmit();
      promptStarted = true;
      await failureReleased;
      await ctx.stopFailure({
        error: "rate_limit_error",
        errorDetails: "StopFailure emitted after the user interrupt"
      });
    });

    await startRole(env.app, task.taskSlug, "coder");
    const coderSession = env.mockRuntime.getSessionByRole(task.taskSlug, "coder");
    expect(coderSession).toBeDefined();

    env.mockRuntime.write(coderSession!.id, "Interrupt this active turn");
    await waitFor(() => promptStarted);
    await env.deps.terminalInterruptService.handleManualInterrupt(coderSession!.id);

    const interrupted = await getWorkspaceState(env.app, task.taskSlug);
    expect(interrupted.roundState).toMatchObject({
      status: "stopped",
      stopReason: "manual-interrupt",
      activeRole: "coder"
    });
    expect(interrupted.taskStatus.sessions.find((session) => session.role === "coder")?.activityStatus).toBe("idle");

    releaseFailure?.();
    await env.mockRuntime.waitForIdle();

    const writes = env.mockRuntime.getWrites(coderSession!.id).join("\n");
    expect(writes).not.toContain("[VCM Recovery]");
    const finalState = await getWorkspaceState(env.app, task.taskSlug);
    expect(finalState.roundState.stopReason).toBe("manual-interrupt");
    expect(finalState.roundState.roleRecovery).toBeUndefined();
  });

  it("does not retry a non-retryable StopFailure and pauses the round", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-nonretry");

    env.mockRuntime.onPrompt("coder", "Trigger non-retryable failure", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeOutput("Coder hit auth failure\n");
      await ctx.stopFailure({
        error: "authentication_failed",
        errorDetails: "mock auth failure"
      });
    });

    await startRole(env.app, task.taskSlug, "coder");
    const coderSession = env.mockRuntime.getSessionByRole(task.taskSlug, "coder");
    expect(coderSession).toBeDefined();

    env.mockRuntime.write(coderSession!.id, "Trigger non-retryable failure");
    await env.mockRuntime.waitForIdle();

    const writes = env.mockRuntime.getWrites(coderSession!.id).join("\n");
    expect(writes).not.toContain("[VCM Recovery]");
    const state = await getWorkspaceState(env.app, task.taskSlug);
    expect(state.roundState.roleRecovery).toMatchObject({
      role: "coder",
      status: "failed",
      error: "authentication_failed",
      retryable: false
    });
    expect(state.roundState.flowPause).toMatchObject({
      paused: true,
      reason: "role-recovery-failed",
      role: "coder"
    });
  });

  it("persists a PM workflow checkpoint and restores it to project-manager", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "workflow-state");

    const update = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/workflow-state`,
      payload: {
        flow: "code-change",
        step: "tester-validation",
        branch: "architect-debug",
        resumePoint: "tester-validation",
        evidenceRefs: [".ai/vcm/handoffs/architect-debug.md"]
      }
    });
    expect(update.statusCode).toBe(200);

    const workspace = await getWorkspaceState(env.app, task.taskSlug);
    expect(workspace.workflowState).toMatchObject({
      declared: {
        flow: "code-change",
        step: "tester-validation",
        branch: "architect-debug",
        resumePoint: "tester-validation"
      }
    });

    const pm = await startRole(env.app, task.taskSlug, "project-manager");
    await env.mockRuntime.waitForIdle();
    const writes = env.mockRuntime.getWrites(pm.id).join("\n");
    expect(writes).toContain("[VCM TASK STATE]");
    expect(writes).toContain("Step: tester-validation");
    expect(writes).toContain("does not authorize or advance any workflow step");
  });
});
