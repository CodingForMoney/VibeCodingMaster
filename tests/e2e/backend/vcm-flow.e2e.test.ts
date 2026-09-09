import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkflowProgress, renderWorkflowProgress } from "../../../src/backend/services/workflow-control-service.js";
import {
  renderArchitectDebugTemplate,
  renderArchitectureDiagnosisTemplate,
  renderArchitecturePlanTemplate,
  renderCoderCompletionTemplate,
  renderDocsUpdateReportTemplate,
  renderDocsSyncReportTemplate,
  renderFinalAcceptanceTemplate,
  renderTestReportTemplate
} from "../../../src/backend/templates/handoff.js";
import type { DispatchableRole } from "../../../src/shared/types/role.js";
import type { WorkflowFlow } from "../../../src/shared/types/workflow.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, git } from "./helpers/e2e-repo.js";
import {
  closeTask,
  connectAndCreateTask,
  createTask,
  getWorkspaceState,
  nextTick,
  sleep,
  startRole,
  waitFor
} from "./helpers/e2e-actions.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E with mock Claude Code", () => {
  it.each(["code-change", "architect-debug", "architecture-diagnosis"] as const)("rejects the wrong docs artifact and completes %s with docs-sync through the API", async (flow) => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, `docs-kind-${flow}`);
    const service = env.deps.workflowControlService!;
    const context = {
      taskRepoRoot: task.worktreePath, taskSlug: task.taskSlug,
      stateRoot: ".ai/vcm", handoffDir: ".ai/vcm/handoffs"
    };
    const write = (file: string, content: string) => fs.writeFile(path.join(task.worktreePath, context.handoffDir, file), content);
    await advanceWorkflow(service, context, "architect", flow, "accepted delivery");
    if (flow === "code-change") {
      await write("architecture-plan.md", completeWorkflowArtifact(renderArchitecturePlanTemplate(task.taskSlug), [
        ["Planning Result: complete|incomplete|user clarification required", "Planning Result: complete"]
      ]));
      await writeWorkflowGateIndex(task.worktreePath, { architecture: "approve" }, "2026-09-09T00:00:00.000Z");
      await advanceWorkflow(service, context, "coder", undefined, "implement approved plan");
      await write("coder-completion.md", completeWorkflowArtifact(renderCoderCompletionTemplate(task.taskSlug), [
        ["ready_for_review|incomplete|failed", "ready_for_review"]
      ]));
    } else if (flow === "architect-debug") {
      await write("architect-debug.md", completeWorkflowArtifact(renderArchitectDebugTemplate(task.taskSlug), [
        ["pending|completed", "completed"],
        ["local fix completed|normal architecture plan required|user clarification required", "local fix completed"]
      ]));
    } else {
      await write("architecture-diagnosis.md", completeWorkflowArtifact(renderArchitectureDiagnosisTemplate(task.taskSlug), [
        ["analysis completed|diagnosis implementation completed|user clarification required", "diagnosis implementation completed"]
      ]));
    }
    await advanceWorkflow(service, context, "tester", undefined, "validate implementation");
    await write("test-report.md", completeWorkflowArtifact(renderTestReportTemplate(task.taskSlug), [
      ["pass|fail|incomplete", "pass"], ["L3 Required: yes|no", "L3 Required: no"],
      ["none|repair-required|repaired|production-change-required", "none"]
    ]));
    await writeWorkflowGateIndex(task.worktreePath, {
      validation: "approve", codeDiff: "approve",
      codeDiffSource: flow === "code-change" ? "coder" : flow === "architect-debug" ? "architect-debug" : "architect-diagnosis"
    }, "2026-09-09T00:01:00.000Z");
    await advanceWorkflow(service, context, "architect", undefined, "synchronize delivery documentation");
    const architect = await startRole(env.app, task.taskSlug, "architect");
    const pm = await startRole(env.app, task.taskSlug, "project-manager");
    const original = await fs.readFile(path.join(task.worktreePath, context.handoffDir, "docs-update-report.md"), "utf8");
    let reportSubmitted = false;
    env.mockRuntime.onPrompt("architect", "Synchronize final delivery documentation", async (ctx) => {
      await ctx.userPromptSubmit();
      const wrong = await env.app.inject({
        method: "POST", url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
        payload: {
          role: "architect", runtimeSessionToken: architect.runtimeSessionToken,
          kind: "docs-update-report", mode: "final",
          content: completeWorkflowArtifact(renderDocsUpdateReportTemplate(task.taskSlug), [["synced|unchanged|blocked", "synced"]])
        }
      });
      expect(wrong.statusCode, wrong.body).toBe(422);
      expect(wrong.body).toContain("WORKFLOW_DOCS_ARTIFACT_MISMATCH");
      expect(wrong.body).toContain(".ai/vcm/handoffs/docs-sync-report.md");
      expect(await fs.readFile(path.join(ctx.cwd, context.handoffDir, "docs-update-report.md"), "utf8")).toBe(original);
      const correct = await env.app.inject({
        method: "POST", url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
        payload: {
          role: "architect", runtimeSessionToken: architect.runtimeSessionToken,
          kind: "docs-sync-report", mode: "final",
          content: completeWorkflowArtifact(renderDocsSyncReportTemplate(task.taskSlug), [
            ["synced|unchanged|blocked", "synced"], ["none|architect|coder|tester", "none"]
          ])
        }
      });
      expect(correct.statusCode, correct.body).toBe(200);
      reportSubmitted = true;
      await ctx.stop();
    });
    env.mockRuntime.write(architect.id, "Synchronize final delivery documentation");
    await env.mockRuntime.waitForIdle();
    expect(reportSubmitted).toBe(true);
    await write("final-acceptance.md", completeWorkflowArtifact(renderFinalAcceptanceTemplate(task.taskSlug), [
      ["accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision", "accepted"]
    ]));
    const current = await service.getProgress(context);
    const completed = await env.app.inject({
      method: "POST", url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
      payload: {
        role: "project-manager", runtimeSessionToken: pm.runtimeSessionToken,
        kind: "workflow-progress", mode: "final",
        content: renderWorkflowProgress({ ...current, revision: current.revision + 1, status: "completed" })
      }
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect((await service.getProgress(context)).status).toBe("completed");
  });

  it("consumes one workflow approval only after the target role accepts the PM route", async () => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "workflow-approved-route");

    env.mockRuntime.onPrompt("project-manager", "Start the approved workflow", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-architect.md", [
        "---",
        "type: task",
        "---",
        "Design the complete accepted task.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("architect", "Design the complete accepted task", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("The approved Architect route was accepted.");
      await ctx.stop();
    });

    const pm = await startRole(env.app, task.taskSlug, "project-manager");
    await startRole(env.app, task.taskSlug, "architect");
    expect(pm.runtimeSessionToken).toBeTruthy();

    const progress = [
      `# Workflow Progress: ${task.taskSlug}`,
      "",
      "Revision: 1",
      "Flow: none",
      "Status: not-started",
      "",
      "## Dispatch History",
      "",
      "none",
      "",
      "## Proposed Dispatch",
      "",
      "Requested Flow: code-change",
      "Target Role: architect",
      "Evidence: user accepted the complete code-change task",
      "",
      "## User Authorization",
      "",
      "Authorization Text: none",
      "Violated Rule: none",
      "",
      "## User-Approved Follow-Up",
      "",
      "Approval Text: none",
      ""
    ].join("\n");
    const approval = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
      payload: {
        kind: "workflow-progress",
        mode: "final",
        role: "project-manager",
        runtimeSessionToken: pm.runtimeSessionToken,
        content: progress
      }
    });
    expect(approval.statusCode, approval.body).toBe(200);

    const beforeDispatch = await env.deps.workflowControlService!.getState({
      taskRepoRoot: task.worktreePath,
      stateRoot: ".ai/vcm",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: task.taskSlug
    });
    expect(beforeDispatch.pendingDispatch).toMatchObject({
      targetRole: "architect",
      status: "pending"
    });

    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    env.mockRuntime.write(pmSession!.id, "Start the approved workflow");
    await env.mockRuntime.waitForIdle();

    const afterDispatch = await env.deps.workflowControlService!.getState({
      taskRepoRoot: task.worktreePath,
      stateRoot: ".ai/vcm",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: task.taskSlug
    });
    expect(afterDispatch.pendingDispatch).toBeNull();
    const savedProgress = await fs.readFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/workflow-progress.md"),
      "utf8"
    );
    expect(savedProgress).toContain("| 1 | code-change | architect |");
  });

  it("pauses for a user answer, cancels old approval, and resumes Architect with fresh approval", async () => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "workflow-user-wait");
    let architectReceivedRoute = false;

    env.mockRuntime.onPrompt("project-manager", "Ask the user before routing", async (ctx) => {
      await ctx.userPromptSubmit();
      const paused = await env.app.inject({
        method: "POST",
        url: `/api/tasks/${task.taskSlug}/ask-user`,
        payload: { question: "Which behavior should be authoritative?" }
      });
      expect(paused.statusCode, paused.body).toBe(200);
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-architect.md", [
        "---",
        "type: task",
        "---",
        "This stale route must not be dispatched.",
        ""
      ].join("\n"));
      await ctx.stop({ last_assistant_message: "Which behavior should be authoritative?" });
    });
    env.mockRuntime.onPrompt("project-manager", "Use the documented behavior", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop({ last_assistant_message: "Acknowledged." });
    });
    env.mockRuntime.onPrompt("project-manager", "Resume Architect with the user answer", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-architect.md", [
        "---",
        "type: task",
        "---",
        "Continue using the documented behavior confirmed by the user.",
        ""
      ].join("\n"));
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("architect", "This stale route must not be dispatched", async (ctx) => {
      architectReceivedRoute = true;
      await ctx.userPromptSubmit();
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("architect", "Continue using the documented behavior confirmed by the user", async (ctx) => {
      architectReceivedRoute = true;
      await ctx.userPromptSubmit();
      await ctx.stop({ last_assistant_message: "Continuing with the confirmed behavior." });
    });

    const pm = await startRole(env.app, task.taskSlug, "project-manager");
    await startRole(env.app, task.taskSlug, "architect");
    const initialProgress = renderWorkflowProgress({
      taskSlug: task.taskSlug,
      revision: 1,
      status: "not-started",
      history: [],
      proposal: {
        requestedFlow: "code-change",
        targetRole: "architect",
        evidence: "accepted task"
      }
    });
    const approval = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
      payload: {
        kind: "workflow-progress",
        mode: "final",
        role: "project-manager",
        runtimeSessionToken: pm.runtimeSessionToken,
        content: initialProgress
      }
    });
    expect(approval.statusCode, approval.body).toBe(200);

    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    env.mockRuntime.write(pmSession!.id, "Ask the user before routing");
    await env.mockRuntime.waitForIdle();

    const context = {
      taskRepoRoot: task.worktreePath,
      stateRoot: ".ai/vcm",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: task.taskSlug
    };
    expect(await env.deps.workflowControlService!.getState(context)).toMatchObject({
      awaitingUser: { question: "Which behavior should be authoritative?" },
      pendingDispatch: null
    });
    expect((await env.deps.workflowControlService!.getProgress(context)).proposal).toBeUndefined();
    expect(architectReceivedRoute).toBe(false);

    env.mockRuntime.write(pmSession!.id, "Use the documented behavior");
    await env.mockRuntime.waitForIdle();
    expect((await env.deps.workflowControlService!.getState(context)).awaitingUser).toBeNull();
    expect(architectReceivedRoute).toBe(false);

    const resumed = parseWorkflowProgress(await fs.readFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/workflow-progress.md"),
      "utf8"
    ), task.taskSlug);
    const freshApproval = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
      payload: {
        kind: "workflow-progress",
        mode: "final",
        role: "project-manager",
        runtimeSessionToken: pm.runtimeSessionToken,
        content: renderWorkflowProgress({
          ...resumed,
          revision: resumed.revision + 1,
          proposal: {
            requestedFlow: "code-change",
            targetRole: "architect",
            evidence: "the user confirmed the documented behavior"
          }
        })
      }
    });
    expect(freshApproval.statusCode, freshApproval.body).toBe(200);

    env.mockRuntime.write(pmSession!.id, "Resume Architect with the user answer");
    await env.mockRuntime.waitForIdle();
    expect(architectReceivedRoute).toBe(true);
    expect((await env.deps.workflowControlService!.getProgress(context)).history).toEqual([
      expect.objectContaining({ flow: "code-change", targetRole: "architect" })
    ]);
  });

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
      reason: "stopped-no-next-turn",
      role: "project-manager"
    });
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

  it("completes Docs-Only Flow before starting an explicit Validation-Only Flow", async () => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "docs-only-flow");

    env.mockRuntime.onPrompt("project-manager", "Update the project guide", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-tester.md", [
        "---",
        "type: task",
        "---",
        "Update the testing guide and submit the Docs Update Report.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("tester", "Update the testing guide and submit the Docs Update Report.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile("docs/TESTING.md", "# Testing\n\nUpdated documentation.\n");
      await ctx.writeFile(
        ".ai/vcm/handoffs/docs-update-report.md",
        completeDocsUpdateReport(task.taskSlug, "synced")
      );
      await git(ctx.cwd, "add", "--", "docs/TESTING.md");
      await git(ctx.cwd, "commit", "-m", "docs: update testing guide");
      await ctx.writeFile(".ai/vcm/handoffs/messages/tester-project-manager.md", [
        "---",
        "type: result",
        "artifact_refs: .ai/vcm/handoffs/docs-update-report.md",
        "---",
        "Docs-only update complete.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", "Docs-only update complete.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("project-manager", "Start the accepted validation flow", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-tester.md", [
        "---",
        "type: task",
        "---",
        "Run the newly accepted validation-only request.",
        ""
      ].join("\n"));
      await ctx.stop();
    });
    let testerReceivedNewFlow = false;
    env.mockRuntime.onPrompt("tester", "Run the newly accepted validation-only request", async (ctx) => {
      testerReceivedNewFlow = true;
      await ctx.userPromptSubmit();
      await ctx.stop();
    });

    const pm = await startRole(env.app, task.taskSlug, "project-manager");
    await startRole(env.app, task.taskSlug, "tester");
    const initialProgress = [
      `# Workflow Progress: ${task.taskSlug}`,
      "",
      "Revision: 1",
      "Flow: none",
      "Status: not-started",
      "",
      "## Dispatch History",
      "",
      "none",
      "",
      "## Proposed Dispatch",
      "",
      "Requested Flow: docs-only",
      "Target Role: tester",
      "Evidence: user accepted the documentation-only task",
      "",
      "## User Authorization",
      "",
      "Authorization Text: none",
      "Violated Rule: none",
      "",
      "## User-Approved Follow-Up",
      "",
      "Approval Text: none",
      ""
    ].join("\n");
    const approval = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
      payload: {
        kind: "workflow-progress",
        mode: "final",
        role: "project-manager",
        runtimeSessionToken: pm.runtimeSessionToken,
        content: initialProgress
      }
    });
    expect(approval.statusCode, approval.body).toBe(200);

    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    env.mockRuntime.write(pmSession!.id, "Update the project guide");
    await env.mockRuntime.waitForIdle();

    const progressPath = path.join(task.worktreePath, ".ai/vcm/handoffs/workflow-progress.md");
    const current = parseWorkflowProgress(await fs.readFile(progressPath, "utf8"), task.taskSlug);
    expect(current.history).toEqual([expect.objectContaining({ flow: "docs-only", targetRole: "tester" })]);
    await expect(fs.readFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/docs-update-report.md"),
      "utf8"
    )).resolves.toContain("## Decision\n\nsynced");

    const completion = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
      payload: {
        kind: "workflow-progress",
        mode: "final",
        role: "project-manager",
        runtimeSessionToken: pm.runtimeSessionToken,
        content: renderWorkflowProgress({
          ...current,
          revision: current.revision + 1,
          status: "completed",
          proposal: undefined
        })
      }
    });
    expect(completion.statusCode, completion.body).toBe(200);
    const completed = parseWorkflowProgress(await fs.readFile(progressPath, "utf8"), task.taskSlug);
    expect(completed.status).toBe("completed");

    const nextFlow = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
      payload: {
        kind: "workflow-progress",
        mode: "final",
        role: "project-manager",
        runtimeSessionToken: pm.runtimeSessionToken,
        content: renderWorkflowProgress({
          ...completed,
          revision: completed.revision + 1,
          proposal: {
            requestedFlow: "validation-only",
            targetRole: "tester",
            evidence: "a new accepted validation request"
          }
        })
      }
    });
    expect(nextFlow.statusCode, nextFlow.body).toBe(200);

    const workflowState = await env.app.inject({
      method: "GET",
      url: `/api/tasks/${task.taskSlug}/workflow-control`
    });
    expect(workflowState.statusCode, workflowState.body).toBe(200);
    expect(workflowState.json()).toMatchObject({
      pendingDispatch: {
        effectiveFlow: "validation-only",
        targetRole: "tester"
      }
    });

    env.mockRuntime.write(pmSession!.id, "Start the accepted validation flow");
    await env.mockRuntime.waitForIdle();
    expect(testerReceivedNewFlow).toBe(true);
    const continued = parseWorkflowProgress(await fs.readFile(progressPath, "utf8"), task.taskSlug);
    expect(continued.status).toBe("active");
    expect(continued.history.at(-1)).toMatchObject({
      flow: "validation-only",
      targetRole: "tester"
    });
  });

  it("starts a fresh workflow in a new task after the previous task flow completed", async () => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const firstTask = await connectAndCreateTask(env.app, repo, "completed-workflow-task");
    const service = env.deps.workflowControlService!;
    const firstContext = {
      taskRepoRoot: firstTask.worktreePath,
      stateRoot: ".ai/vcm",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: firstTask.taskSlug
    };

    await advanceWorkflow(service, firstContext, "architect", "docs-only", "complete the first task docs flow");
    await fs.writeFile(
      path.join(firstTask.worktreePath, ".ai/vcm/handoffs/docs-update-report.md"),
      completeDocsUpdateReport(firstTask.taskSlug, "unchanged"),
      "utf8"
    );
    const firstProgress = await service.getProgress(firstContext);
    await service.submitProgress(firstContext, renderWorkflowProgress({
      ...firstProgress,
      revision: firstProgress.revision + 1,
      status: "completed",
      proposal: undefined
    }));
    expect((await service.getProgress(firstContext)).status).toBe("completed");

    await closeTask(env.app, firstTask.taskSlug);
    const secondTask = await createTask(env.app, "fresh-workflow-task");
    const secondContext = {
      taskRepoRoot: secondTask.worktreePath,
      stateRoot: ".ai/vcm",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: secondTask.taskSlug
    };
    expect(await service.getProgress(secondContext)).toMatchObject({
      taskSlug: secondTask.taskSlug,
      revision: 0,
      status: "not-started",
      history: []
    });

    await advanceWorkflow(service, secondContext, "architect", "code-change", "start the new task flow");
    expect((await service.getProgress(secondContext)).history).toEqual([
      expect.objectContaining({ sequence: 1, flow: "code-change", targetRole: "architect" })
    ]);
  });

  it("accepts one explicit Tester follow-up after green Gates and invalidates the old evidence", async () => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "post-validation-follow-up");
    const pm = await startRole(env.app, task.taskSlug, "project-manager");
    const service = env.deps.workflowControlService!;
    const context = {
      taskRepoRoot: task.worktreePath,
      stateRoot: ".ai/vcm",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: task.taskSlug
    };

    await advanceWorkflow(service, context, "architect", "code-change", "accepted code change");
    await fs.writeFile(
      path.join(task.worktreePath, context.handoffDir, "architecture-plan.md"),
      completeWorkflowArtifact(renderArchitecturePlanTemplate(task.taskSlug), [
        ["Planning Result: complete|incomplete|user clarification required", "Planning Result: complete"]
      ]),
      "utf8"
    );
    await writeWorkflowGateIndex(task.worktreePath, { architecture: "approve" }, "2026-08-20T00:00:10.000Z");
    await advanceWorkflow(service, context, "coder", undefined, "approved architecture plan");
    await fs.writeFile(
      path.join(task.worktreePath, context.handoffDir, "coder-completion.md"),
      completeWorkflowArtifact(renderCoderCompletionTemplate(task.taskSlug), [
        ["Decision: ready_for_review|incomplete|failed", "Decision: ready_for_review"]
      ]),
      "utf8"
    );
    await advanceWorkflow(service, context, "tester", undefined, "completed implementation");
    await fs.writeFile(
      path.join(task.worktreePath, context.handoffDir, "test-report.md"),
      completeWorkflowArtifact(renderTestReportTemplate(task.taskSlug), [
        ["Test Result: pass|fail|incomplete", "Test Result: pass"],
        ["L3 Required: yes|no", "L3 Required: no"],
        ["Status: none|repair-required|repaired|production-change-required", "Status: none"]
      ]),
      "utf8"
    );
    await writeWorkflowGateIndex(task.worktreePath, {
      architecture: "approve",
      validation: "approve",
      codeDiff: "approve"
    }, "2026-08-20T00:00:20.000Z");

    const current = parseWorkflowProgress(await fs.readFile(
      path.join(task.worktreePath, context.handoffDir, "workflow-progress.md"),
      "utf8"
    ), task.taskSlug);
    const withoutApproval = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
      payload: {
        kind: "workflow-progress",
        mode: "final",
        role: "project-manager",
        runtimeSessionToken: pm.runtimeSessionToken,
        content: renderWorkflowProgress({
          ...current,
          revision: current.revision + 1,
          proposal: {
            targetRole: "tester",
            evidence: "add the approved regression coverage"
          }
        })
      }
    });
    expect(withoutApproval.statusCode, withoutApproval.body).toBe(422);

    const approved = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
      payload: {
        kind: "workflow-progress",
        mode: "final",
        role: "project-manager",
        runtimeSessionToken: pm.runtimeSessionToken,
        content: renderWorkflowProgress({
          ...current,
          revision: current.revision + 1,
          proposal: {
            targetRole: "tester",
            evidence: "add the approved regression coverage",
            followUpApprovalText: "Add this regression coverage before completing the task."
          }
        })
      }
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await service.getState(context)).pendingDispatch).toMatchObject({
      targetRole: "tester",
      followUpApprovalId: expect.any(String)
    });

    await service.claimDispatch({
      ...context,
      routePath: ".ai/vcm/handoffs/messages/project-manager-tester.md",
      targetRole: "tester",
      routeContentHash: "follow-up-route",
      messageId: "follow-up-message"
    });
    await service.confirmDispatch(context, "follow-up-message");
    expect(await service.getState(context)).toMatchObject({
      pendingDispatch: null,
      userAuthorizations: [],
      userApprovedFollowUps: [expect.objectContaining({ status: "consumed" })]
    });

    const afterFollowUp = parseWorkflowProgress(await fs.readFile(
      path.join(task.worktreePath, context.handoffDir, "workflow-progress.md"),
      "utf8"
    ), task.taskSlug);
    await expect(service.submitProgress(context, renderWorkflowProgress({
      ...afterFollowUp,
      revision: afterFollowUp.revision + 1,
      proposal: {
        targetRole: "architect",
        evidence: "attempt to reuse old validation evidence"
      }
    }))).rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });
  });

  it("accepts a Tester correction after validation-adequacy rejects a failed report", async () => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "validation-gate-tester-correction");
    const pm = await startRole(env.app, task.taskSlug, "project-manager");
    const service = env.deps.workflowControlService!;
    const context = {
      taskRepoRoot: task.worktreePath,
      stateRoot: ".ai/vcm",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: task.taskSlug
    };

    await advanceWorkflow(service, context, "architect", "code-change", "accepted code change");
    await fs.writeFile(
      path.join(task.worktreePath, context.handoffDir, "architecture-plan.md"),
      completeWorkflowArtifact(renderArchitecturePlanTemplate(task.taskSlug), [
        ["Planning Result: complete|incomplete|user clarification required", "Planning Result: complete"]
      ]),
      "utf8"
    );
    await writeWorkflowGateIndex(task.worktreePath, { architecture: "approve" }, "2026-08-20T01:00:10.000Z");
    await advanceWorkflow(service, context, "coder", undefined, "approved architecture plan");
    await fs.writeFile(
      path.join(task.worktreePath, context.handoffDir, "coder-completion.md"),
      completeWorkflowArtifact(renderCoderCompletionTemplate(task.taskSlug), [
        ["Decision: ready_for_review|incomplete|failed", "Decision: ready_for_review"]
      ]),
      "utf8"
    );
    await advanceWorkflow(service, context, "tester", undefined, "completed implementation");
    await fs.writeFile(
      path.join(task.worktreePath, context.handoffDir, "test-report.md"),
      completeWorkflowArtifact(renderTestReportTemplate(task.taskSlug), [
        ["Test Result: pass|fail|incomplete", "Test Result: fail"],
        ["L3 Required: yes|no", "L3 Required: no"],
        ["Status: none|repair-required|repaired|production-change-required", "Status: none"],
        [
          "## Blocking Validation Issues\n\nNone.",
          "## Blocking Validation Issues\n\nThe current validation evidence does not cover the required recovery path."
        ]
      ]),
      "utf8"
    );
    await writeWorkflowGateIndex(
      task.worktreePath,
      { architecture: "approve", validation: "request_changes" },
      "2026-08-20T01:00:20.000Z"
    );

    const current = await service.getProgress(context);
    const response = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
      payload: {
        kind: "workflow-progress",
        mode: "final",
        role: "project-manager",
        runtimeSessionToken: pm.runtimeSessionToken,
        content: renderWorkflowProgress({
          ...current,
          revision: current.revision + 1,
          proposal: {
            targetRole: "tester",
            evidence: "address the current validation-adequacy findings"
          }
        })
      }
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await service.getState(context)).toMatchObject({
      pendingDispatch: { targetRole: "tester", effectiveFlow: "code-change" }
    });
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

function completeDocsUpdateReport(taskSlug: string, decision: "synced" | "unchanged"): string {
  return renderDocsUpdateReportTemplate(taskSlug)
    .replaceAll("TBD", "Verified documentation-only task evidence.")
    .replace("synced|unchanged|blocked", decision);
}

async function advanceWorkflow(
  service: NonNullable<Awaited<ReturnType<typeof createMockClaudeE2eApp>>["deps"]["workflowControlService"]>,
  context: { taskRepoRoot: string; stateRoot: string; handoffDir: string; taskSlug: string },
  targetRole: DispatchableRole,
  requestedFlow: WorkflowFlow | undefined,
  evidence: string
): Promise<void> {
  const progressPath = path.join(context.taskRepoRoot, context.handoffDir, "workflow-progress.md");
  const current = parseWorkflowProgress(await fs.readFile(progressPath, "utf8"), context.taskSlug);
  await service.submitProgress(context, renderWorkflowProgress({
    ...current,
    revision: current.revision + 1,
    proposal: { targetRole, requestedFlow, evidence }
  }));
  const messageId = `workflow-message-${current.revision + 1}`;
  await service.claimDispatch({
    ...context,
    routePath: `.ai/vcm/handoffs/messages/project-manager-${targetRole}.md`,
    targetRole,
    routeContentHash: `workflow-route-${current.revision + 1}`,
    messageId
  });
  await service.confirmDispatch(context, messageId);
}

function completeWorkflowArtifact(template: string, replacements: Array<[string, string]>): string {
  return replacements.reduce((content, [from, to]) => content.replace(from, to), template)
    .replaceAll("TBD", "Verified E2E workflow evidence.");
}

async function writeWorkflowGateIndex(
  taskRepoRoot: string,
  decisions: {
    architecture?: "approve" | "request_changes";
    validation?: "approve" | "request_changes";
    codeDiff?: "approve" | "request_changes";
    codeDiffSource?: "coder" | "architect-debug" | "architect-diagnosis";
  },
  updatedAt: string
): Promise<void> {
  const record = (
    gate: "architecture-plan" | "validation-adequacy" | "code-diff",
    decision?: "approve" | "request_changes"
  ) => ({
    gate,
    required: true,
    status: decision ? "completed" : "pending",
    decision,
    requestId: decision ? `request-${gate}-${updatedAt}` : undefined,
    inputHash: decision ? `input-${gate}-${updatedAt}` : undefined,
    codeDiffSource: gate === "code-diff" && decision ? decisions.codeDiffSource ?? "coder" : undefined,
    reportPath: `.ai/vcm/gate-reviews/${gate}-review.md`,
    promptPath: `.ai/vcm/gate-reviews/${gate}-prompt.md`,
    completedAt: decision ? updatedAt : undefined,
    updatedAt
  });
  const gateDir = path.join(taskRepoRoot, ".ai/vcm/gate-reviews");
  await fs.mkdir(gateDir, { recursive: true });
  await fs.writeFile(path.join(gateDir, "index.json"), JSON.stringify({
    version: 1,
    enabled: true,
    activeGate: null,
    gates: {
      "architecture-plan": record("architecture-plan", decisions.architecture),
      "validation-adequacy": record("validation-adequacy", decisions.validation),
      "code-diff": record("code-diff", decisions.codeDiff)
    },
    updatedAt
  }, null, 2) + "\n", "utf8");
}
