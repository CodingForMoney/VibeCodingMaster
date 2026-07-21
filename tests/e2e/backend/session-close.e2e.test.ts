import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, git } from "./helpers/e2e-repo.js";
import {
  closeTask,
  connectAndCreateTask,
  getWorkspaceState,
  restartRole,
  startRole,
  waitFor
} from "./helpers/e2e-actions.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E session lifecycle and close task", () => {
  it("persists Claude session id only after prompt hook and clears it on restart until the next prompt", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-session");

    const first = await startRole(env.app, task.taskSlug, "architect");
    expect(first.claudeSessionId).toBe("");

    env.mockRuntime.onPrompt("architect", "First prompt records session id", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("First prompt complete.");
      await ctx.stop();
    });
    env.mockRuntime.write(first.id, "First prompt records session id");
    await env.mockRuntime.waitForIdle();

    const afterPrompt = await getWorkspaceState(env.app, task.taskSlug);
    const recorded = afterPrompt.taskStatus.sessions.find((session) => session.role === "architect");
    expect(recorded?.claudeSessionId).toMatch(/^mock-claude-architect-/);

    const restarted = await restartRole(env.app, task.taskSlug, "architect");
    expect(restarted.id).not.toBe(first.id);
    expect(restarted.claudeSessionId).toBe("");

    env.mockRuntime.onPrompt("architect", "Second prompt records replacement session id", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Second prompt complete.");
      await ctx.stop();
    });
    env.mockRuntime.write(restarted.id, "Second prompt records replacement session id");
    await env.mockRuntime.waitForIdle();

    const afterRestartPrompt = await getWorkspaceState(env.app, task.taskSlug);
    const replacement = afterRestartPrompt.taskStatus.sessions.find((session) => session.role === "architect");
    expect(replacement?.claudeSessionId).toMatch(/^mock-claude-architect-/);
    expect(replacement?.claudeSessionId).not.toBe(recorded?.claudeSessionId);
  });

  it("closes a task with task commits and running sessions without blocking on warnings", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-close");
    await startRole(env.app, task.taskSlug, "project-manager");
    await fs.writeFile(path.join(task.worktreePath, "close-me.txt"), "task commit\n", "utf8");
    await git(task.worktreePath, "add", "close-me.txt");
    await git(task.worktreePath, "commit", "-m", "task-local commit");

    const result = await closeTask(env.app, task.taskSlug) as {
      taskClosed: boolean;
      worktreeRemoved: boolean;
      branchDeleted: boolean;
      stateRemoved: boolean;
    };

    expect(result.taskClosed).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    await waitFor(async () => {
      await expect(fs.access(task.worktreePath)).rejects.toThrow();
    });
  });
});
