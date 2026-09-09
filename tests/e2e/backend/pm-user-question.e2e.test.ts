import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderWorkflowProgress } from "../../../src/backend/services/workflow-control-service.js";
import { renderDocsUpdateReportTemplate } from "../../../src/backend/templates/handoff.js";
import type { ClaudeStopHookResponse } from "../../../src/shared/types/claude-hook.js";
import type { WorkflowFlow } from "../../../src/shared/types/workflow.js";
import {
  connectAndCreateTask, getGateState, requestGateReview, startRole,
  updateGateSettings, waitFor, writeCompleteArchitecturePlan, writeConfirmedArchitectureBrief
} from "./helpers/e2e-actions.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.shift()?.();
});

const statusReport = [
  'The architect must answer "is this the same defect?" before the plan lands.',
  '| Result | Evidence |',
  '| --- | --- |',
  '| pass | 20 `?` samples recorded |',
  '',
  '## So: can this be completed?',
  'See https://example.com/x?tab=readme for the upstream note.',
  '',
  'No question was asked of the user; the only question mark sits in reported speech - "does wiring close it?".'
].join("\n");

describe("PM question detection through the Stop hook API", () => {
  it("preserves approval, dispatches normally, and accepts reports while Architect is still running", async () => {
    const env = await createScenario("question-role-report");
    await env.approveArchitect("code-change");
    const before = await env.state();
    await env.beginPmTurn();
    expect(await env.stopPm(statusReport)).toEqual({});
    expect(await env.state()).toEqual(before);
    expect((await env.pmSession())?.activityStatus).toBe("idle");

    let architectAccepted = false;
    env.mockRuntime.onPrompt("architect", "Perform the approved work", async (ctx) => {
      await ctx.userPromptSubmit();
      architectAccepted = true;
    });
    await startRole(env.app, env.task.taskSlug, "architect");
    await env.writeRoute();
    await env.beginPmTurn();
    expect(await env.stopPm(statusReport)).toEqual({});
    await env.mockRuntime.waitForIdle();
    expect(architectAccepted).toBe(true);
    const running = await env.state();
    expect(running.pendingDispatch).toBeNull();
    expect(running.activeDispatch?.targetRole).toBe("architect");
    expect(running.awaitingUser).toBeNull();
    expect((await env.deps.sessionService.getRoleSession(env.repo.repoRoot, env.task.taskSlug, "architect"))?.activityStatus).toBe("running");

    await env.beginPmTurn();
    expect(await env.stopPm(statusReport)).toEqual({});
    expect(await env.state()).toEqual(running);

    await env.beginPmTurn();
    expect(await env.stopPm("Which option do you want, A or B?")).toMatchObject({ decision: "block" });
    expect((await env.pmSession())?.activityStatus).toBe("running");
    expect(await env.state()).toEqual(running);
  });

  it("does not interrupt a running Gate for reported questions but still blocks a genuine unregistered question", async () => {
    const env = await createScenario("question-gate-report");
    await writeConfirmedArchitectureBrief(env.task.worktreePath, env.task.taskSlug);
    await writeCompleteArchitecturePlan(env.task.worktreePath, env.task.taskSlug);
    await updateGateSettings(env.app, env.task.taskSlug, { "architecture-plan": true });
    let reviewerStarted = false;
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      await ctx.userPromptSubmit();
      reviewerStarted = true;
    });
    expect((await requestGateReview(env.app, env.task.taskSlug, "architecture-plan")).status).toBe("started");
    await waitFor(() => reviewerStarted);
    await env.mockRuntime.waitForIdle();
    expect(reviewerStarted).toBe(true);
    const gate = (await getGateState(env.app, env.task.taskSlug)).gates["architecture-plan"];
    expect(gate.status).toBe("running");
    const before = await env.state();

    await env.beginPmTurn();
    expect(await env.stopPm(statusReport)).toEqual({});
    expect((await env.pmSession())?.activityStatus).toBe("idle");
    // No dispatch has persisted workflow state yet; getState timestamps the
    // empty snapshot on each read, without creating a user wait or approval.
    expect(await env.state()).toEqual({ ...before, updatedAt: expect.any(String) });
    expect((await getGateState(env.app, env.task.taskSlug)).gates["architecture-plan"]).toEqual(gate);

    await env.beginPmTurn();
    const blocked = await env.stopPm("## Please confirm the expected behavior.");
    expect(blocked).toMatchObject({ decision: "block" });
    expect(blocked.reason).toContain("Please confirm the expected behavior.");
    expect((await env.pmSession())?.activityStatus).toBe("running");
    expect((await env.state()).awaitingUser).toBeNull();

    const paused = await env.app.inject({
      method: "POST", url: `/api/tasks/${env.task.taskSlug}/ask-user`,
      payload: { question: "Please confirm the expected behavior." }
    });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(await env.stopPm("Please confirm the expected behavior.")).toEqual({});
    expect((await env.state()).awaitingUser?.question).toBe("Please confirm the expected behavior.");
    expect((await env.pmSession())?.activityStatus).toBe("idle");
    expect((await getGateState(env.app, env.task.taskSlug)).gates["architecture-plan"]).toEqual(gate);
    await expect(env.service.submitProgress(env.context, "not a workflow candidate"))
      .rejects.toMatchObject({ code: "WORKFLOW_AWAITING_USER" });
  });

  it("allows completed-flow summaries even though the last dispatch baseline is retained", async () => {
    const env = await createScenario("question-completed-report");
    await env.approveArchitect("docs-only");
    await startRole(env.app, env.task.taskSlug, "architect");
    env.mockRuntime.onPrompt("architect", "Perform the approved work", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(".ai/vcm/handoffs/docs-update-report.md",
        renderDocsUpdateReportTemplate(env.task.taskSlug)
          .replace("synced|unchanged|blocked", "unchanged")
          .replaceAll("TBD", "Verified current documentation; no updates required."));
      await ctx.stop();
    });
    await env.writeRoute();
    await env.beginPmTurn();
    expect(await env.stopPm("The documentation check was dispatched.")).toEqual({});
    await env.mockRuntime.waitForIdle();
    const current = await env.service.getProgress(env.context);
    await env.service.submitProgress(env.context, renderWorkflowProgress({
      ...current, revision: current.revision + 1, status: "completed"
    }));
    const completed = await env.state();
    expect(completed.activeDispatch?.targetRole).toBe("architect");

    await env.beginPmTurn();
    expect(await env.stopPm(statusReport)).toEqual({});
    expect(await env.state()).toEqual(completed);
    expect((await env.service.getProgress(env.context)).status).toBe("completed");
    expect((await env.pmSession())?.activityStatus).toBe("idle");

    await env.beginPmTurn();
    expect(await env.stopPm("请给出下一步选择。")).toMatchObject({ decision: "block" });
  });

  it("keeps a real question blocked on repeated Stop, then registers the wait without dispatching the pending route", async () => {
    const env = await createScenario("question-register-wait");
    await env.approveArchitect("code-change");
    await env.writeRoute();
    await env.beginPmTurn();
    const approval = (await env.state()).pendingDispatch;
    const question = "Should I continue with option A?";
    for (const stopHookActive of [false, true]) {
      const blocked = await env.stopPm(question, stopHookActive);
      expect(blocked).toMatchObject({ decision: "block" });
      expect(blocked.reason).toContain(question);
      expect(blocked.reason).toContain("do not invent a user question or register a false wait");
      expect((await env.state()).pendingDispatch).toEqual(approval);
      expect((await env.state()).awaitingUser).toBeNull();
      expect((await env.pmSession())?.activityStatus).toBe("running");
    }
    const paused = await env.app.inject({
      method: "POST", url: `/api/tasks/${env.task.taskSlug}/ask-user`, payload: { question }
    });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(await env.stopPm(question, true)).toEqual({});
    expect(await env.state()).toMatchObject({ pendingDispatch: null, awaitingUser: { question } });
    expect((await env.service.getProgress(env.context)).history).toEqual([]);
    expect((await env.pmSession())?.activityStatus).toBe("idle");
  });
});

async function createScenario(taskSlug: string) {
  const env = await createMockClaudeE2eApp({ workflowControl: true });
  cleanups.push(() => env.close());
  const repo = await createE2eRepo();
  cleanups.push(() => repo.cleanup());
  const task = await connectAndCreateTask(env.app, repo, taskSlug);
  const pm = await startRole(env.app, taskSlug, "project-manager");
  const service = env.deps.workflowControlService!;
  const context = {
    taskRepoRoot: task.worktreePath, taskSlug,
    stateRoot: ".ai/vcm", handoffDir: ".ai/vcm/handoffs"
  };
  const hook = async (event: Record<string, unknown>, stop = false) => {
    const response = await env.app.inject({
      method: "POST", url: `/api/hooks/claude-code${stop ? "/stop" : ""}`,
      payload: {
        taskSlug, role: "project-manager", runtimeSessionToken: pm.runtimeSessionToken,
        event: { session_id: "question-test-pm", cwd: task.worktreePath, ...event }
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response;
  };
  return {
    ...env, repo, task, service, context,
    state: () => service.getState(context),
    pmSession: () => env.deps.sessionService.getRoleSession(repo.repoRoot, taskSlug, "project-manager"),
    beginPmTurn: () => hook({ hook_event_name: "UserPromptSubmit", prompt: "[VCM] Report current status." }),
    async stopPm(message: string, stopHookActive = false): Promise<ClaudeStopHookResponse> {
      return (await hook({ hook_event_name: "Stop", last_assistant_message: message, stop_hook_active: stopHookActive }, true)).json();
    },
    async approveArchitect(flow: WorkflowFlow) {
      const current = await service.getProgress(context);
      const response = await env.app.inject({
        method: "POST", url: `/api/tasks/${taskSlug}/artifacts/submit`,
        payload: {
          role: "project-manager", runtimeSessionToken: pm.runtimeSessionToken,
          kind: "workflow-progress", mode: "final",
          content: renderWorkflowProgress({
            ...current, revision: current.revision + 1,
            proposal: { requestedFlow: flow, targetRole: "architect", evidence: "User accepted the task." }
          })
        }
      });
      expect(response.statusCode, response.body).toBe(200);
    },
    writeRoute: () => fs.writeFile(path.join(task.worktreePath, ".ai/vcm/handoffs/messages/project-manager-architect.md"),
      "---\ntype: task\n---\nPerform the approved work.\n")
  };
}
