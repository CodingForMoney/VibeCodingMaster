import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createMockClaudeE2eApp, roleLaunchBody, type MockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, type E2eRepo } from "./helpers/e2e-repo.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskWorkspaceState } from "../../../src/shared/types/api.js";

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
});

async function connectAndCreateTask(app: FastifyInstance, repo: E2eRepo, taskSlug: string): Promise<TaskRecord> {
  await injectOk(app, {
    method: "POST",
    url: "/api/projects/connect",
    payload: { repoPath: repo.repoRoot }
  });
  const response = await injectOk(app, {
    method: "POST",
    url: "/api/tasks",
    payload: { taskSlug, title: "Mock Claude flow" }
  });
  return response.json<TaskRecord>();
}

async function startRole(app: FastifyInstance, taskSlug: string, role: string): Promise<RoleSessionRecord> {
  const response = await injectOk(app, {
    method: "POST",
    url: `/api/tasks/${taskSlug}/sessions/${role}/start`,
    payload: roleLaunchBody()
  });
  return response.json<RoleSessionRecord>();
}

async function getWorkspaceState(app: FastifyInstance, taskSlug: string): Promise<TaskWorkspaceState> {
  const response = await injectOk(app, {
    method: "GET",
    url: `/api/tasks/${taskSlug}/workspace-state`
  });
  return response.json<TaskWorkspaceState>();
}

async function injectOk(
  app: FastifyInstance,
  input: Parameters<FastifyInstance["inject"]>[0]
): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  const response = await app.inject(input);
  if (response.statusCode >= 400) {
    throw new Error(`Expected ${input.method ?? "GET"} ${input.url} to succeed, got ${response.statusCode}: ${response.body}`);
  }
  return response;
}

async function waitFor(assertion: () => void | boolean | Promise<void | boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await assertion();
      if (result !== false) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("Timed out waiting for condition.");
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
