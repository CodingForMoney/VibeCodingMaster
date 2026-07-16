import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderFinalAcceptanceTemplate } from "../../../src/backend/templates/handoff.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  injectOk,
  startHarnessEngineer,
  startRole,
  startTaskHarnessRetrospective,
  updatePreferences
} from "./helpers/e2e-actions.js";
import type { MockClaudePromptContext } from "./helpers/mock-claude-runtime.js";

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

  it("applies reviewed role memory before starting Task Harness Retrospective", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-memory-retrospective");
    await updatePreferences(env.app, { autoMemoryEnabled: true });

    env.mockRuntime.onPrompt("project-manager", "Complete task for memory review", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(
        ".ai/vcm/handoffs/final-acceptance.md",
        acceptedFinalAcceptance(task.taskSlug)
      );
      await ctx.appendTranscriptText("Task accepted for memory review.");
      await ctx.stop();
    });
    for (const role of ["project-manager", "architect", "coder", "tester"] as const) {
      env.mockRuntime.onPrompt(role, "[VCM Task Harness Review: Memory Proposal]", writeNoChangeMemoryDraft);
    }
    env.mockRuntime.onPrompt("harness-engineer", "[VCM Task Harness Review: Memory Review]", async (ctx) => {
      await ctx.userPromptSubmit();
      const afterRoot = matchPromptPath(ctx.prompt, "Write the complete reviewed memory set to");
      await ctx.writeAbsoluteFile(
        path.join(afterRoot, "shared.md"),
        "# Shared Memory\n\nBackend hooks own lifecycle completion.\n"
      );
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("harness-engineer", "[VCM Task Harness Retrospective]", writeHarnessRetrospective);

    for (const role of ["project-manager", "architect", "coder", "tester"] as const) {
      await startRole(env.app, task.taskSlug, role);
    }
    const harnessSession = await startHarnessEngineer(env.app, task.taskSlug);
    expect(harnessSession.activityStatus).toBe("idle");
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    expect(pmSession).toBeDefined();
    env.mockRuntime.write(pmSession!.id, "Complete task for memory review");
    await env.mockRuntime.waitForIdle();

    await startTaskHarnessRetrospective(env.app, task.taskSlug);
    await env.mockRuntime.waitForIdle();

    const memoryBeforeRetrospective = await injectOk(env.app, {
      method: "GET",
      url: `/api/projects/harness/memory?taskSlug=${task.taskSlug}`
    });
    expect(memoryBeforeRetrospective.json()).toMatchObject({
      status: "idle",
      runs: [expect.objectContaining({ status: "applied", trigger: "manual" })]
    });
    await expect(fs.readFile(path.join(repo.repoRoot, ".ai/vcm/memory/shared.md"), "utf8"))
      .resolves.toContain("Backend hooks own lifecycle completion.");
    expect(env.mockRuntime.getWrites(harnessSession.id).join("\n")).not.toContain("[VCM Task Harness Retrospective]");

    await env.deps.runtimeCoordinator.reconcileProject(repo.repoRoot, { taskSlug: task.taskSlug });
    await env.mockRuntime.waitForIdle();

    const harnessWrites = env.mockRuntime.getWrites(harnessSession.id).join("\n");
    expect(harnessWrites.indexOf("[VCM Task Harness Review: Memory Review]")).toBeGreaterThanOrEqual(0);
    expect(harnessWrites.indexOf("[VCM Task Harness Retrospective]")).toBeGreaterThan(
      harnessWrites.indexOf("[VCM Task Harness Review: Memory Review]")
    );
    await expect(fs.readFile(
      path.join(repo.repoRoot, ".ai/vcm/harness-feedback/task-retrospectives", `${task.taskSlug}.md`),
      "utf8"
    )).resolves.toContain("Memory review completed before retrospective.");
  });

  it("starts Task Harness Retrospective directly when Auto Memory is disabled", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-retrospective-no-memory");
    await updatePreferences(env.app, { autoMemoryEnabled: false });

    env.mockRuntime.onPrompt("project-manager", "Complete task without memory", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(
        ".ai/vcm/handoffs/final-acceptance.md",
        acceptedFinalAcceptance(task.taskSlug)
      );
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("harness-engineer", "[VCM Task Harness Retrospective]", writeHarnessRetrospective);

    await startRole(env.app, task.taskSlug, "project-manager");
    const harnessSession = await startHarnessEngineer(env.app, task.taskSlug);
    expect(harnessSession.activityStatus).toBe("idle");
    const startedHarnessSession = await injectOk(env.app, {
      method: "GET",
      url: "/api/projects/harness/engineer/session"
    });
    expect(startedHarnessSession.json()).toMatchObject({ id: harnessSession.id, activityStatus: "idle" });
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    expect(pmSession).toBeDefined();
    env.mockRuntime.write(pmSession!.id, "Complete task without memory");
    await env.mockRuntime.waitForIdle();

    const idleHarnessSession = await injectOk(env.app, {
      method: "GET",
      url: "/api/projects/harness/engineer/session"
    });
    expect(env.mockRuntime.getSession(harnessSession.id)).toBeDefined();
    expect(idleHarnessSession.json()).toMatchObject({ activityStatus: "idle" });

    await startTaskHarnessRetrospective(env.app, task.taskSlug);
    await env.mockRuntime.waitForIdle();

    const harnessWrites = env.mockRuntime.getWrites(harnessSession.id).join("\n");
    expect(harnessWrites).toContain("[VCM Task Harness Retrospective]");
    expect(harnessWrites).not.toContain("[VCM Task Harness Review: Memory Proposal]");
    expect(harnessWrites).not.toContain("[VCM Task Harness Review: Memory Review]");
    const memoryState = await injectOk(env.app, {
      method: "GET",
      url: `/api/projects/harness/memory?taskSlug=${task.taskSlug}`
    });
    expect(memoryState.json()).toMatchObject({ status: "idle", runs: [] });
  });
});

async function writeNoChangeMemoryDraft(ctx: MockClaudePromptContext): Promise<void> {
  await ctx.userPromptSubmit();
  const draftPath = matchPromptPath(ctx.prompt, "Write the draft to");
  await ctx.writeAbsoluteFile(draftPath, "# Memory Draft\n\nDecision: no-change\n");
  await ctx.stop();
}

async function writeHarnessRetrospective(ctx: MockClaudePromptContext): Promise<void> {
  await ctx.userPromptSubmit();
  const resultPath = matchPromptPath(ctx.prompt, "Write the analysis to Result Path");
  await ctx.writeAbsoluteFile(
    resultPath,
    "# Task Harness Retrospective\n\nMemory review completed before retrospective.\n"
  );
  await ctx.stop();
}

function acceptedFinalAcceptance(taskSlug: string): string {
  return renderFinalAcceptanceTemplate(taskSlug)
    .replaceAll("TBD", "None.")
    .replace("## Decision\n\nNone.", "## Decision\n\naccepted");
}

function matchPromptPath(prompt: string, field: string): string {
  const matched = prompt.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim();
  if (!matched) {
    throw new Error(`Missing ${field} in prompt:\n${prompt}`);
  }
  return matched;
}
