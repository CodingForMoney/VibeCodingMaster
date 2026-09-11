import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderWorkflowProgress } from "../../../src/backend/services/workflow-control-service.js";
import { renderDocsUpdateReportTemplate } from "../../../src/backend/templates/handoff.js";
import type { ClaudeStopHookResponse } from "../../../src/shared/types/claude-hook.js";
import type { WorkflowFlow } from "../../../src/shared/types/workflow.js";
import {
  connectAndCreateTask, getGateState, requestGateReview, startRole,
  updateGateSettings, waitFor, writeCompleteArchitecturePlan, writeConfirmedArchitectureBrief,
  pollTranslationFeed, updatePreferences, bindGatewayLarkApp, setGatewayConnection, updateGatewaySettings, getWorkspaceState
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
  it.each(["architect", "coder", "tester"] as const)("rejects PM routing to %s with instructions to ask and stop until the user replies", async (targetRole) => {
    const env = await createScenario(`question-rejected-route-${targetRole}`);
    await env.approveArchitect("code-change");
    await env.beginPmTurn();
    const routePath = `.ai/vcm/handoffs/messages/project-manager-${targetRole}.md`;
    const absolutePath = path.join(env.task.worktreePath, routePath);
    const originalContent = await fs.readFile(absolutePath, "utf8");
    const question = "Which storage format should this task support?";
    const registered = await env.app.inject({
      method: "POST", url: `/api/tasks/${env.task.taskSlug}/ask-user`, payload: { question }
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const pm = (await env.pmSession())!;

    for (const stopped of [false, true]) {
      if (stopped) expect(await env.stopPm(question)).toEqual({});
      const response = await env.app.inject({
        method: "POST", url: `/api/tasks/${env.task.taskSlug}/artifacts/submit`,
        payload: {
          role: "project-manager", runtimeSessionToken: pm.runtimeSessionToken,
          kind: "route-message", mode: "final", path: routePath,
          content: "---\ntype: task\n---\nContinue the implementation.\n"
        }
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toMatchObject({
        code: "WORKFLOW_AWAITING_USER",
        message: expect.stringContaining("Present the complete question and necessary context in your final reply, end the current turn, and wait for a new direct user message."),
        hint: "The previous workflow approval was canceled; request a fresh approval after the answer arrives."
      });
      expect(await fs.readFile(absolutePath, "utf8")).toBe(originalContent);
      expect((await env.state()).awaitingUser?.question).toBe(question);
      expect((await env.state()).pendingDispatch).toBeNull();
    }

    await env.directUserPrompt("Use the existing format.");
    expect((await env.state()).awaitingUser).toBeNull();
    expect((await env.state()).pendingDispatch).toBeNull();
  });

  it("registers a wait without synthesizing a reply and blocks advancement until direct user input", async () => {
    const env = await createScenario("question-delivery-off");
    await updatePreferences(env.app, { translationEnabled: false });
    await env.approveArchitect("code-change");
    await env.beginPmTurn();
    const question = "The two storage formats cannot interoperate. Which format should this task support?";
    const response = await env.app.inject({ method: "POST", url: `/api/tasks/${env.task.taskSlug}/ask-user`, payload: { question } });
    expect(response.statusCode, response.body).toBe(200);
    expect(await env.stopPm("Waiting for your answer.")).toEqual({});

    const first = await pollTranslationFeed(env.app, env.task.taskSlug);
    const questions = first.events.filter((item) => item.event.type === "entry" && item.event.entry.sourceText === question);
    expect(questions).toHaveLength(0);
    await waitFor(async () => {
      const pause = (await getWorkspaceState(env.app, env.task.taskSlug)).roundState.flowPause;
      expect(pause).toMatchObject({ paused: true });
      expect(pause?.message).toBeUndefined();
    });
    expect(first.events.some((item) => item.event.type === "entry" && item.event.entry.sourceText === "Waiting for your answer.")).toBe(false);

    const beforeGate = await getGateState(env.app, env.task.taskSlug);
    for (const gate of ["architecture-plan", "validation-adequacy", "code-diff"]) {
      for (const operation of ["request", "retry"]) {
        const result = await env.app.inject({ method: "POST", url: `/api/tasks/${env.task.taskSlug}/gate-review/${gate}/${operation}`, payload: {} });
        expect(result.statusCode, result.body).toBe(409);
        expect(result.body).toContain("WORKFLOW_AWAITING_USER");
      }
    }
    const afterGate = await getGateState(env.app, env.task.taskSlug);
    expect(afterGate.activeGate).toBe(beforeGate.activeGate);
    for (const gate of ["architecture-plan", "validation-adequacy", "code-diff"] as const) {
      expect(afterGate.gates[gate]).toEqual({ ...beforeGate.gates[gate], updatedAt: expect.any(String) });
    }
    await expect(env.service.submitProgress(env.context, "Status: completed")).rejects.toMatchObject({ code: "WORKFLOW_AWAITING_USER" });
    await expect(env.service.assertRouteAuthorized({ ...env.context, routePath: ".ai/vcm/handoffs/messages/project-manager-architect.md", targetRole: "architect" }))
      .rejects.toMatchObject({ code: "WORKFLOW_AWAITING_USER" });

    await env.beginPmTurn(); // Internal callback cannot unlock the wait.
    expect((await env.state()).awaitingUser?.question).toBe(question);
    await env.stopPm("Internal status received.");
    const replay = await pollTranslationFeed(env.app, env.task.taskSlug, first.nextCursor);
    expect(replay.events.filter((item) => item.event.type === "entry" && item.event.entry.sourceText === question)).toHaveLength(0);
    await env.directUserPrompt("Use the existing storage format.");
    expect((await env.state()).awaitingUser).toBeNull();
    expect((await env.state()).pendingDispatch).toBeNull();
    await expect(env.service.assertRouteAuthorized({ ...env.context, routePath: ".ai/vcm/handoffs/messages/project-manager-architect.md", targetRole: "architect" })).rejects.toThrow();
    await env.approveArchitect("code-change");
    expect((await env.state()).pendingDispatch?.targetRole).toBe("architect");
  });

  it.each([
    ["round-final", false], ["pm-final-only", false], ["final-only", false], ["all", false],
    ["round-final", true], ["pm-final-only", true]
  ] as const)("shares exactly one question with the Gateway in %s mode (translation failure: %s)", async (mode, failTranslation) => {
    const env = await createScenario(`question-gateway-${mode}-${failTranslation}`);
    const question = "The import must keep existing records. Should duplicate rows be rejected or merged?";
    const finalReply = `## Decision needed\n\n${question}`;
    const translated = "ZH: " + finalReply;
    const translatedSources: string[] = [];
    env.mockRuntime.onPrompt("translator", "Translate each <VCM_TEXT>", async (ctx) => {
      await ctx.userPromptSubmit();
      for (const match of ctx.prompt.matchAll(/Result Path \d+:\s*(.+?)\n<VCM_TEXT\d+>\n([\s\S]*?)\n<\/VCM_TEXT\d+>/g)) {
        translatedSources.push(match[2]!);
        if (!failTranslation) await ctx.writeAbsoluteFile(match[1]!.trim(), "ZH: " + match[2]);
      }
      await ctx.stop();
    }, { once: false });
    await bindGatewayLarkApp(env.app, { appId: "mock-app", appSecret: "mock-secret", larkDomain: "lark" });
    await setGatewayConnection(env.app, true);
    await updateGatewaySettings(env.app, { enabled: true, channel: "lark", translationEnabled: true });
    env.mockGateway.enqueueText("/status", { fromUserId: "question-user", chatId: "question-chat" });
    await waitFor(async () => expect((await env.deps.gatewayService.getStatus()).binding.boundUserId).toBeTruthy(), 10_000);
    await updatePreferences(env.app, { translationEnabled: true, translationOutputMode: mode, translationTargetLanguage: "zh-CN" });
    const ensure = await env.app.inject({ method: "POST", url: "/api/translation/session/ensure", payload: { taskSlug: env.task.taskSlug } });
    expect(ensure.statusCode, ensure.body).toBe(200);

    env.mockRuntime.onPrompt("project-manager", "Ask about import", async (ctx) => {
      await ctx.userPromptSubmit();
      const registered = await env.app.inject({ method: "POST", url: `/api/tasks/${env.task.taskSlug}/ask-user`, payload: { question } });
      expect(registered.statusCode, registered.body).toBe(200);
      await ctx.writeOutput(finalReply);
      await ctx.appendTranscriptText(finalReply);
      await ctx.stop({ last_assistant_message: finalReply });
    });
    const pm = env.mockRuntime.getSessionByRole(env.task.taskSlug, "project-manager")!;
    env.mockRuntime.write(pm.id, "Ask about import");
    await env.mockRuntime.waitForIdle();
    await waitFor(async () => {
      const feed = await pollTranslationFeed(env.app, env.task.taskSlug);
      expect(feed.events.some((item) => item.event.type === "entry" && item.event.entry.sourceText === finalReply
        && (failTranslation ? item.event.entry.status === "failed" : item.event.entry.translatedText === translated))).toBe(true);
      expect(feed.events.some((item) => item.event.type === "entry" && item.event.entry.sourceText === "Waiting for your answer.")).toBe(false);
      expect(env.mockGateway.sentTexts.some((item) => item.text.includes(failTranslation ? "PM 角色回复已收到，但翻译失败。" : translated))).toBe(true);
      const pause = (await getWorkspaceState(env.app, env.task.taskSlug)).roundState.flowPause;
      expect(pause).toMatchObject({ paused: true });
      expect(pause?.message).toBeUndefined();
    }, 15_000);
    const session = (await env.pmSession())!;
    await env.deps.gatewayService.handleRoleStop({ repoRoot: env.repo.repoRoot, taskSlug: env.task.taskSlug, session });
    await pollTranslationFeed(env.app, env.task.taskSlug);
    expect(translatedSources.filter((text) => text === finalReply)).toHaveLength(1);
    expect(translatedSources).not.toContain(question);
    expect(env.mockGateway.sentTexts.filter((item) => item.text.includes("Round Final Reply 原文：") && item.text.includes(finalReply))).toHaveLength(1);
    expect(env.mockGateway.sentTexts.filter((item) => item.text.includes(failTranslation ? "PM 角色回复已收到，但翻译失败。" : translated))).toHaveLength(1);
    expect(env.mockGateway.sentTexts.some((item) => item.text.includes("Waiting for your answer."))).toBe(false);
  }, 45_000);

  it.each([false, true])("preserves the actual PM question on panel reload and after an answer (translation: %s)", async (enabled) => {
    const env = await createScenario(`question-panel-${enabled}`);
    const question = "Which storage format should this task support?";
    const finalReply = `Existing records use format A. Format B would require migrating them.\n\n${question}`;
    await updatePreferences(env.app, { translationEnabled: enabled, translationOutputMode: "round-final" });
    const translatedSources: string[] = [];
    env.mockRuntime.onPrompt("translator", "Translate each <VCM_TEXT>", async (ctx) => {
      await ctx.userPromptSubmit();
      for (const match of ctx.prompt.matchAll(/Result Path \d+:\s*(.+?)\n<VCM_TEXT\d+>\n([\s\S]*?)\n<\/VCM_TEXT\d+>/g)) {
        translatedSources.push(match[2]!);
        await ctx.writeAbsoluteFile(match[1]!.trim(), "ZH: " + match[2]);
      }
      await ctx.stop();
    }, { once: false });
    if (enabled) {
      const ensure = await env.app.inject({ method: "POST", url: "/api/translation/session/ensure", payload: { taskSlug: env.task.taskSlug } });
      expect(ensure.statusCode, ensure.body).toBe(200);
    }
    const pm = env.mockRuntime.getSessionByRole(env.task.taskSlug, "project-manager")!;
    env.mockRuntime.onPrompt("project-manager", "Ask about storage", async (ctx) => {
      await ctx.userPromptSubmit();
      const registered = await env.app.inject({ method: "POST", url: `/api/tasks/${env.task.taskSlug}/ask-user`, payload: { question } });
      expect(registered.statusCode, registered.body).toBe(200);
      // The normal transcript, not the registration payload, is display authority.
      await ctx.writeOutput(finalReply);
      await ctx.appendTranscriptText(finalReply);
      await ctx.stop({ last_assistant_message: finalReply });
    });
    env.mockRuntime.write(pm.id, "Ask about storage");
    await env.mockRuntime.waitForIdle();
    await waitFor(async () => {
      const feed = await pollTranslationFeed(env.app, env.task.taskSlug);
      expect(feed.events.some((item) => item.event.type === "entry" && item.event.entry.sourceText === finalReply
        && item.event.entry.status === (enabled ? "translated" : "preserved"))).toBe(true);
    }, 15_000);
    const session = (await env.pmSession())!;
    expect(await fs.readFile(session.transcriptPath!, "utf8")).toContain(JSON.stringify(finalReply));
    let terminalReplay = "";
    const unsubscribe = env.mockRuntime.subscribe(pm.id, (event) => {
      if (event.type === "output") terminalReplay += event.data;
    });
    unsubscribe();
    expect(terminalReplay).toContain(finalReply);

    for (const afterAnswer of [false, true]) {
      if (afterAnswer) {
        env.mockRuntime.onPrompt("project-manager", "Use format A.", async (ctx) => {
          await ctx.userPromptSubmit();
          await ctx.stop();
        });
        env.mockRuntime.write(pm.id, "Use format A.");
        await env.mockRuntime.waitForIdle();
      }
      const feed = await pollTranslationFeed(env.app, env.task.taskSlug, 1);
      const entries = feed.events.flatMap((item) => item.event.type === "entry" ? [item.event.entry] : []);
      const replies = entries.filter((entry) => entry.sourceText === finalReply);
      expect(new Set(replies.map((entry) => entry.id)).size).toBe(1);
      expect(replies.every((entry) => entry.role === "project-manager")).toBe(true);
      expect(feed.events.filter((item) => item.event.type === "entry" && item.event.entry.sourceText === finalReply)
        .every((item) => item.sessionId === pm.id)).toBe(true);
      expect(entries.some((entry) => entry.sourceText === question)).toBe(false);
      expect((await env.state()).awaitingUser === null).toBe(afterAnswer);
    }
    expect(translatedSources).toEqual(enabled ? [finalReply] : []);
    expect(env.mockGateway.sentTexts).toEqual([]);
  }, 45_000);

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
    directUserPrompt: (prompt: string) => hook({ hook_event_name: "UserPromptSubmit", prompt }),
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
