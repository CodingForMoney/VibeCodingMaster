import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  getGateState,
  injectOk,
  requestGateReview,
  scheduleArchitectRestart,
  updateGateSettings,
  updatePreferences,
  waitFor,
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
    await waitFor(() => env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id !== architect.id);

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
    await scheduleArchitectRestart(env.app, task.taskSlug);
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
    await scheduleArchitectRestart(env.app, task.taskSlug);
    await writeArchitectRoute(task.worktreePath, "Architecture revised. Plan ready.");
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-revision-session", true);
    await env.mockRuntime.waitForIdle();
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    await waitFor(async () => (
      await getGateState(env.app, task.taskSlug)
    ).gates["architecture-plan"].decision === "approve");
    await waitFor(() => env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id !== architect.id);
    await waitFor(async () => (
      await getGateState(env.app, task.taskSlug)
    ).gates["architecture-plan"].callbackStatus === "sent");
    await env.mockRuntime.waitForIdle();
  });

  it("restarts after the mandatory Gate request reports that Gate Review is disabled", async () => {
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
    await writePlanningMemoryCandidate(task.worktreePath, staleCandidatePath);
    await scheduleArchitectRestart(env.app, task.taskSlug);
    await expect(fs.readFile(path.join(task.worktreePath, staleCandidatePath), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-disabled-gate-session", true);
    await env.mockRuntime.waitForIdle();
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("disabled");
    await waitFor(() => env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id !== architect.id);
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
    const scheduled = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(scheduled.memoryCandidatePath).toBe(stableCandidatePath);
    await expect(fs.readFile(path.join(task.worktreePath, stableCandidatePath), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await writePlanningMemoryCandidate(task.worktreePath, scheduled.memoryCandidatePath!);
    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-memory-session", true);
    await env.mockRuntime.waitForIdle();

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("disabled");
    await waitFor(() => env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id !== architect.id);
  });

  it("keeps the planning session when Auto Memory is enabled but its candidate is missing", async () => {
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
  await fs.writeFile(
    path.join(taskRepoRoot, ".ai/vcm/handoffs/architecture-plan.md"),
    "Planning Result: complete\n\n# Architecture Plan\n\nComplete E2E plan.\n",
    "utf8"
  );
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
