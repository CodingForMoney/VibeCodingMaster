import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  getGateState,
  getWorkspaceState,
  injectOk,
  requestGateReview,
  scheduleArchitectRestart,
  updateGateSettings,
  updatePreferences,
  waitFor,
  writeCompleteArchitecturePlan,
  writeConfirmedArchitectureBrief
} from "./helpers/e2e-actions.js";
import type { MockClaudePromptContext } from "./helpers/mock-claude-runtime.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E Architect post-planning restart", () => {
  it("restarts only after normal Architect Stop, PM route acceptance, and architecture Gate approval", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompletePlan(task.worktreePath);

    await startRole(env.app, task.taskSlug, "project-manager");
    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": true,
      "validation-adequacy": false,
      "code-diff": false
    });
    env.mockRuntime.onPrompt(
      "reviewer",
      "[VCM GATE REVIEW]",
      (ctx) => writeArchitectureGateReport(ctx, "approve")
    );
    env.mockRuntime.onPrompt("project-manager", "[VCM GATE REVIEW CALLBACK]", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    }, { once: false });
    const architect = await startRole(env.app, task.taskSlug, "architect", {
      permissionMode: "bypassPermissions",
      model: "fable",
      effort: "high"
    });
    await postUserPromptHook(env, task.taskSlug, "architect-claude-session");

    let acceptRoute!: () => void;
    const waitToAccept = new Promise<void>((resolve) => {
      acceptRoute = resolve;
    });
    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan ready.", async (ctx) => {
      await waitToAccept;
      await ctx.userPromptSubmit();
      await ctx.stop();
    });

    const scheduled = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(scheduled).toMatchObject({ status: "scheduled", sessionId: architect.id });
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-claude-session", true);
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    acceptRoute();
    await env.mockRuntime.waitForIdle();
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    await waitFor(async () => (
      await getGateState(env.app, task.taskSlug)
    ).gates["architecture-plan"].decision === "approve");
    await waitForArchitectReplacement(env, task.taskSlug, architect.id);

    const replacement = env.mockRuntime.getSessionByRole(task.taskSlug, "architect");
    expect(replacement).toBeDefined();
    const createInput = env.mockRuntime.getCreateInput(replacement!.id);
    expect(createInput.args).toContain("--append-system-prompt");
    expect(createInput.args).toContain("--model");
    expect(createInput.args).toContain("fable");
    expect(createInput.args).toContain("--effort");
    expect(createInput.args).toContain("high");
    expect(env.mockRuntime.getWrites(replacement!.id)).toEqual([]);
  });

  it("keeps the Architect session through request_changes and restarts once a revised plan is approved", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart-revision");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompletePlan(task.worktreePath);

    await startRole(env.app, task.taskSlug, "project-manager");
    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": true,
      "validation-adequacy": false,
      "code-diff": false
    });
    const decisions: Array<"approve" | "request_changes"> = ["request_changes", "approve"];
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      await writeArchitectureGateReport(ctx, decisions.shift() ?? "approve");
    }, { once: false });
    env.mockRuntime.onPrompt("project-manager", "[VCM GATE REVIEW CALLBACK]", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    }, { once: false });
    const architect = await startRole(env.app, task.taskSlug, "architect");
    await postUserPromptHook(env, task.taskSlug, "architect-revision-session");

    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    });
    const initialSchedule = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(initialSchedule).toMatchObject({ status: "scheduled" });
    expect(initialSchedule.memoryCandidatePath).toBeUndefined();
    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-revision-session", true);
    await env.mockRuntime.waitForIdle();

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    await waitFor(async () => (
      await getGateState(env.app, task.taskSlug)
    ).gates["architecture-plan"].decision === "request_changes");
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    await postUserPromptHook(env, task.taskSlug, "architect-revision-session");
    await fs.appendFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"),
      "\nRevision: close the Gate finding.\n",
      "utf8"
    );
    env.mockRuntime.onPrompt("project-manager", "Architecture revised. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    });
    const repeatedSchedule = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(repeatedSchedule).toMatchObject({ status: "already_scheduled" });
    expect(repeatedSchedule.memoryCandidatePath).toBeUndefined();
    await expect(fs.access(
      path.join(task.worktreePath, ".ai/vcm/memory-review/candidates/architect/planning.md")
    )).rejects.toMatchObject({ code: "ENOENT" });
    await writeArchitectRoute(task.worktreePath, "Architecture revised. Plan ready.");
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-revision-session", true);
    await env.mockRuntime.waitForIdle();
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    await waitFor(async () => (
      await getGateState(env.app, task.taskSlug)
    ).gates["architecture-plan"].decision === "approve");
    await waitForArchitectReplacement(env, task.taskSlug, architect.id);
    await waitFor(async () => (
      await getGateState(env.app, task.taskSlug)
    ).gates["architecture-plan"].callbackStatus === "sent");
    await env.mockRuntime.waitForIdle();
  });

  it("preserves one planning candidate through repeated scheduling and Gate revision when Auto Memory is enabled", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart-memory-revision");
    await updatePreferences(env.app, { autoMemoryEnabled: true });
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompletePlan(task.worktreePath);

    await startRole(env.app, task.taskSlug, "project-manager");
    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": true,
      "validation-adequacy": false,
      "code-diff": false
    });
    const decisions: Array<"approve" | "request_changes"> = ["request_changes", "approve"];
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      await writeArchitectureGateReport(ctx, decisions.shift() ?? "approve");
    }, { once: false });
    env.mockRuntime.onPrompt("project-manager", "[VCM GATE REVIEW CALLBACK]", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    }, { once: false });
    const architect = await startRole(env.app, task.taskSlug, "architect");
    await postUserPromptHook(env, task.taskSlug, "architect-memory-revision-session");

    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    });
    const initialSchedule = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(initialSchedule.status).toBe("scheduled");
    expect(initialSchedule.memoryCandidatePath).toBeDefined();
    await writePlanningMemoryCandidate(task.worktreePath, initialSchedule.memoryCandidatePath!);
    const candidatePath = path.join(task.worktreePath, initialSchedule.memoryCandidatePath!);
    const candidateContent = await fs.readFile(candidatePath, "utf8");
    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-memory-revision-session", true);
    await env.mockRuntime.waitForIdle();

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    await waitFor(async () => (
      await getGateState(env.app, task.taskSlug)
    ).gates["architecture-plan"].decision === "request_changes");
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    await postUserPromptHook(env, task.taskSlug, "architect-memory-revision-session");
    await fs.appendFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"),
      "\nRevision: close the Gate finding.\n",
      "utf8"
    );
    const repeatedSchedule = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(repeatedSchedule).toMatchObject({
      status: "already_scheduled",
      memoryCandidatePath: initialSchedule.memoryCandidatePath
    });
    expect(await fs.readFile(candidatePath, "utf8")).toBe(candidateContent);

    env.mockRuntime.onPrompt("project-manager", "Architecture revised. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    });
    await writeArchitectRoute(task.worktreePath, "Architecture revised. Plan ready.");
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-memory-revision-session", true);
    await env.mockRuntime.waitForIdle();
    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    await waitFor(async () => (
      await getGateState(env.app, task.taskSlug)
    ).gates["architecture-plan"].decision === "approve");
    await waitForArchitectReplacement(env, task.taskSlug, architect.id);
    expect(await fs.readFile(candidatePath, "utf8")).toBe(candidateContent);
  });

  it("restarts with Auto Memory disabled and ignores an unrelated invalid candidate", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart-disabled-gate");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompletePlan(task.worktreePath);

    await startRole(env.app, task.taskSlug, "project-manager");
    const architect = await startRole(env.app, task.taskSlug, "architect");
    await postUserPromptHook(env, task.taskSlug, "architect-disabled-gate-session");
    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    });

    const staleCandidatePath = ".ai/vcm/memory-review/candidates/architect/planning.md";
    const absoluteCandidatePath = path.join(task.worktreePath, staleCandidatePath);
    await fs.mkdir(path.dirname(absoluteCandidatePath), { recursive: true });
    await fs.writeFile(absoluteCandidatePath, "not a valid memory proposal\n", "utf8");
    const scheduled = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(scheduled.memoryCandidatePath).toBeUndefined();
    expect(await fs.readFile(absoluteCandidatePath, "utf8")).toBe("not a valid memory proposal\n");
    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-disabled-gate-session", true);
    await env.mockRuntime.waitForIdle();
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("disabled");
    await waitForArchitectReplacement(env, task.taskSlug, architect.id);
    expect(await fs.readFile(absoluteCandidatePath, "utf8")).toBe("not a valid memory proposal\n");
  });

  it("captures a planning-session memory candidate before restarting when Auto Memory is enabled", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart-memory");
    await updatePreferences(env.app, { autoMemoryEnabled: true });
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompletePlan(task.worktreePath);

    await startRole(env.app, task.taskSlug, "project-manager");
    const architect = await startRole(env.app, task.taskSlug, "architect");
    await postUserPromptHook(env, task.taskSlug, "architect-memory-session");
    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    });

    const stableCandidatePath = ".ai/vcm/memory-review/candidates/architect/planning.md";
    await writePlanningMemoryCandidate(task.worktreePath, stableCandidatePath);
    const candidateContent = await fs.readFile(path.join(task.worktreePath, stableCandidatePath), "utf8");
    const scheduled = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(scheduled.memoryCandidatePath).toBe(stableCandidatePath);
    expect(await fs.readFile(path.join(task.worktreePath, stableCandidatePath), "utf8")).toBe(candidateContent);
    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-memory-session", true);
    await env.mockRuntime.waitForIdle();

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("disabled");
    await waitForArchitectReplacement(env, task.taskSlug, architect.id);
    expect(await fs.readFile(path.join(task.worktreePath, stableCandidatePath), "utf8")).toBe(candidateContent);
  });

  it("surfaces a missing Auto Memory candidate as blocked and restarts only after explicit retry", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart-memory-missing");
    await updatePreferences(env.app, { autoMemoryEnabled: true });
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompletePlan(task.worktreePath);

    await startRole(env.app, task.taskSlug, "project-manager");
    const architect = await startRole(env.app, task.taskSlug, "architect");
    await postUserPromptHook(env, task.taskSlug, "architect-memory-missing-session");
    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    });

    const scheduled = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(scheduled.memoryCandidatePath).toBeDefined();
    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-memory-missing-session", true);
    await env.mockRuntime.waitForIdle();
    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("disabled");
    await env.mockRuntime.waitForIdle();

    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);
    const blockedState = (await getWorkspaceState(env.app, task.taskSlug)).architectRestart;
    expect(blockedState).toMatchObject({
      status: "blocked",
      blocker: {
        code: "ARCHITECT_MEMORY_CANDIDATE_INVALID"
      }
    });

    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-memory-missing-session", true);
    await env.mockRuntime.waitForIdle();
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    await writePlanningMemoryCandidate(task.worktreePath, scheduled.memoryCandidatePath!);
    expect((await scheduleArchitectRestart(env.app, task.taskSlug)).status).toBe("scheduled");
    await waitForArchitectReplacement(env, task.taskSlug, architect.id);
    expect((await getWorkspaceState(env.app, task.taskSlug)).architectRestart).toBeNull();
  });

  it("surfaces an invalid Auto Memory candidate and preserves it for correction", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart-memory-invalid");
    await updatePreferences(env.app, { autoMemoryEnabled: true });
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompletePlan(task.worktreePath);

    await startRole(env.app, task.taskSlug, "project-manager");
    const architect = await startRole(env.app, task.taskSlug, "architect");
    await postUserPromptHook(env, task.taskSlug, "architect-memory-invalid-session");
    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    });

    const scheduled = await scheduleArchitectRestart(env.app, task.taskSlug);
    const candidatePath = path.join(task.worktreePath, scheduled.memoryCandidatePath!);
    await fs.mkdir(path.dirname(candidatePath), { recursive: true });
    await fs.writeFile(candidatePath, "invalid proposal\n", "utf8");
    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-memory-invalid-session", true);
    await env.mockRuntime.waitForIdle();
    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("disabled");
    await env.mockRuntime.waitForIdle();

    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);
    expect((await getWorkspaceState(env.app, task.taskSlug)).architectRestart).toMatchObject({
      status: "blocked",
      blocker: {
        code: "ARCHITECT_MEMORY_CANDIDATE_INVALID"
      }
    });
    expect(await fs.readFile(candidatePath, "utf8")).toBe("invalid proposal\n");

    await writePlanningMemoryCandidate(task.worktreePath, scheduled.memoryCandidatePath!);
    expect((await scheduleArchitectRestart(env.app, task.taskSlug)).status).toBe("scheduled");
    await waitForArchitectReplacement(env, task.taskSlug, architect.id);
  });

  it("preserves the task-level candidate when a different Architect session replaces the pending owner", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart-new-session");
    await updatePreferences(env.app, { autoMemoryEnabled: true });
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompletePlan(task.worktreePath);

    const original = await startRole(env.app, task.taskSlug, "architect");
    const scheduled = await scheduleArchitectRestart(env.app, task.taskSlug);
    await writePlanningMemoryCandidate(task.worktreePath, scheduled.memoryCandidatePath!);
    const candidatePath = path.join(task.worktreePath, scheduled.memoryCandidatePath!);
    const candidateContent = await fs.readFile(candidatePath, "utf8");

    const response = await injectOk(env.app, {
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/architect/restart`,
      payload: {
        permissionMode: "bypassPermissions",
        model: "default",
        effort: "default"
      }
    });
    const replacement = response.json<RoleSessionRecord>();
    expect(replacement.id).not.toBe(original.id);

    const replacementSchedule = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(replacementSchedule).toMatchObject({
      status: "scheduled",
      sessionId: replacement.id,
      memoryCandidatePath: scheduled.memoryCandidatePath
    });
    expect(await fs.readFile(candidatePath, "utf8")).toBe(candidateContent);
  });

  it("does not restart after StopFailure even when the route reaches PM", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart-failure");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompletePlan(task.worktreePath);

    await startRole(env.app, task.taskSlug, "project-manager");
    const architect = await startRole(env.app, task.taskSlug, "architect");
    await postUserPromptHook(env, task.taskSlug, "architect-claude-session");
    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
    });

    await scheduleArchitectRestart(env.app, task.taskSlug);
    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "StopFailure", "architect-claude-session", false, {
      error: "terminal_session_exited",
      error_details: "mock abnormal termination",
      retryable: false
    });
    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("disabled");
    await env.mockRuntime.waitForIdle();

    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);
  });

  it("rejects scheduling while architecture-plan.md is incomplete", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart-incomplete");
    await startRole(env.app, task.taskSlug, "architect");
    await fs.writeFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"),
      "Planning Result: incomplete\n",
      "utf8"
    );

    const response = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/architect/restart-after-planning`,
      payload: {}
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("not marked complete");
  });
});

async function startRole(
  app: Parameters<typeof injectOk>[0],
  taskSlug: string,
  role: "project-manager" | "architect",
  payload: Record<string, string> = {
    permissionMode: "bypassPermissions",
    model: "default",
    effort: "default"
  }
): Promise<RoleSessionRecord> {
  const response = await injectOk(app, {
    method: "POST",
    url: `/api/tasks/${taskSlug}/sessions/${role}/start`,
    payload
  });
  return response.json();
}

async function writeCompletePlan(taskRepoRoot: string): Promise<void> {
  await writeCompleteArchitecturePlan(taskRepoRoot, "architect-restart", "Complete E2E plan.");
}

async function writeArchitectRoute(
  taskRepoRoot: string,
  message = "Architecture complete. Plan ready."
): Promise<void> {
  await fs.writeFile(
    path.join(taskRepoRoot, ".ai/vcm/handoffs/messages/architect-project-manager.md"),
    [
      "---",
      "type: result",
      "artifact_refs: .ai/vcm/handoffs/architecture-evidence.md, .ai/vcm/handoffs/architecture-plan.md",
      "---",
      message,
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writePlanningMemoryCandidate(taskRepoRoot: string, relativePath: string): Promise<void> {
  const candidatePath = path.join(taskRepoRoot, relativePath);
  await fs.mkdir(path.dirname(candidatePath), { recursive: true });
  await fs.writeFile(candidatePath, [
    "# Memory Proposal",
    "Decision: update",
    "",
    "## Add",
    "### Item 1",
    "Target: shared",
    "Content: The backend owns task lifecycle state.",
    "Reason: Workflow roles need one lifecycle owner across future tasks.",
    "Impact if absent: Roles may infer lifecycle completion independently.",
    "Durable doc disposition: memory",
    "Durable doc path: none",
    "Evidence: .ai/vcm/handoffs/architecture-evidence.md",
    "",
    "## Update",
    "none",
    "",
    "## Remove",
    "none",
    ""
  ].join("\n"), "utf8");
}

async function waitForArchitectReplacement(
  env: Awaited<ReturnType<typeof createMockClaudeE2eApp>>,
  taskSlug: string,
  previousSessionId: string
): Promise<void> {
  await waitFor(() => {
    const session = env.mockRuntime.getSessionByRole(taskSlug, "architect");
    return Boolean(session && session.id !== previousSessionId);
  });
}

async function writeArchitectureGateReport(
  ctx: MockClaudePromptContext,
  decision: "approve" | "request_changes"
): Promise<void> {
  await ctx.userPromptSubmit();
  const request = /^Request:\s*(.+)$/m.exec(ctx.prompt)?.[1]?.trim();
  const report = /^Report:\s*(.+)$/m.exec(ctx.prompt)?.[1]?.trim();
  if (!request || !report) {
    throw new Error(`Unable to parse Gate Review prompt:\n${ctx.prompt}`);
  }
  const findings = decision === "request_changes"
    ? [
        "## Findings",
        "",
        "### high: Revise ownership",
        "- Evidence: ownership is incomplete",
        "- Expected: one explicit owner",
        "- Gap: owner is missing",
        "- Risk: implementation ambiguity"
      ]
    : ["## Findings", "", "None."];
  await ctx.writeAbsoluteFile(report, [
    "Gate: architecture-plan",
    `Request: ${request}`,
    `Decision: ${decision}`,
    `Summary: ${decision === "approve" ? "Plan approved." : "Plan needs revision."}`,
    "",
    "## Architecture Analysis",
    "",
    "- Evidence Read: brief, evidence, plan, source, and callers",
    "- Architecture Brief Fit: confirmed decisions preserved",
    "- End-To-End Flow: complete",
    "- Scope Fit: complete",
    "- Code Reality: verified",
    "- Ownership: verified",
    "- Data Flow: verified",
    "- Lifecycle: verified",
    "- Invariants: verified",
    "- Boundaries And Public Surface: verified",
    "- Failure Model: verified",
    "- Coder Readiness: ready",
    "",
    ...findings
  ].join("\n"));
  await ctx.stop();
}

async function postRoleHook(
  env: Awaited<ReturnType<typeof createMockClaudeE2eApp>>,
  taskSlug: string,
  role: "architect",
  eventName: "Stop" | "StopFailure",
  claudeSessionId: string,
  stopEndpoint: boolean,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const runtimeSession = env.mockRuntime.getSessionByRole(taskSlug, role);
  const runtimeSessionToken = runtimeSession
    ? env.mockRuntime.getCreateInput(runtimeSession.id).env?.VCM_RUNTIME_SESSION_TOKEN
    : undefined;
  await injectOk(env.app, {
    method: "POST",
    url: stopEndpoint ? "/api/hooks/claude-code/stop" : "/api/hooks/claude-code",
    payload: {
      taskSlug,
      role,
      runtimeSessionToken,
      event: {
        hook_event_name: eventName,
        session_id: claudeSessionId,
        ...extra
      }
    }
  });
}

async function postUserPromptHook(
  env: Awaited<ReturnType<typeof createMockClaudeE2eApp>>,
  taskSlug: string,
  claudeSessionId: string
): Promise<void> {
  const runtimeSession = env.mockRuntime.getSessionByRole(taskSlug, "architect");
  const runtimeSessionToken = runtimeSession
    ? env.mockRuntime.getCreateInput(runtimeSession.id).env?.VCM_RUNTIME_SESSION_TOKEN
    : undefined;
  await injectOk(env.app, {
    method: "POST",
    url: "/api/hooks/claude-code",
    payload: {
      taskSlug,
      role: "architect",
      runtimeSessionToken,
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: claudeSessionId,
        prompt: "Complete architecture planning."
      }
    }
  });
}
