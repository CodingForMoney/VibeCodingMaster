import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  injectOk,
  scheduleArchitectRestart,
  waitFor,
  writeConfirmedArchitectureBrief
} from "./helpers/e2e-actions.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E Architect post-planning restart", () => {
  it("restarts only after normal Architect Stop and PM accepts the delivered route", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "architect-restart");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompletePlan(task.worktreePath);

    await startRole(env.app, task.taskSlug, "project-manager");
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
    });

    const scheduled = await scheduleArchitectRestart(env.app, task.taskSlug);
    expect(scheduled).toMatchObject({ status: "scheduled", sessionId: architect.id });
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    await writeArchitectRoute(task.worktreePath);
    await postRoleHook(env, task.taskSlug, "architect", "Stop", "architect-claude-session", true);
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "architect")?.id).toBe(architect.id);

    acceptRoute();
    await env.mockRuntime.waitForIdle();
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

async function writeArchitectRoute(taskRepoRoot: string): Promise<void> {
  await fs.writeFile(
    path.join(taskRepoRoot, ".ai/vcm/handoffs/messages/architect-project-manager.md"),
    [
      "---",
      "type: result",
      "artifact_refs: .ai/vcm/handoffs/architecture-evidence.md, .ai/vcm/handoffs/architecture-plan.md",
      "---",
      "Architecture complete. Plan ready.",
      ""
    ].join("\n"),
    "utf8"
  );
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
