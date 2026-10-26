import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createArtifactService } from "../../../src/backend/services/artifact-service.js";
import {
  createWorkflowControlService,
  parseWorkflowProgress,
  renderWorkflowProgress,
  type WorkflowControlContext
} from "../../../src/backend/services/workflow-control-service.js";
import {
  renderArchitectDebugTemplate,
  renderArchitectureDiagnosisTemplate,
  renderArchitecturePlanTemplate,
  renderCoderCompletionTemplate,
  renderDocsUpdateReportTemplate,
  renderFinalAcceptanceTemplate,
  renderTestReportTemplate
} from "../../../src/backend/templates/handoff.js";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { WorkflowControlService } from "../../../src/backend/services/workflow-control-service.js";
import type { DispatchableRole } from "../../../src/shared/types/role.js";
import type { WorkflowProgressDocument } from "../../../src/shared/types/workflow.js";

describe("workflow control service", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("approves one legal initial dispatch and confirms it into the durable history", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "authorization-1" });
    await service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")));

    await service.assertRouteAuthorized({
      ...context,
      routePath: routePath("architect"),
      targetRole: "architect"
    });
    await service.claimDispatch({
      ...context,
      routePath: routePath("architect"),
      targetRole: "architect",
      routeContentHash: "route-hash",
      messageId: "message-1"
    });
    await service.confirmDispatch(context, "message-1");

    const progress = parseWorkflowProgress(
      await fs.readText(path.join(context.taskRepoRoot, context.handoffDir, "workflow-progress.md")),
      context.taskSlug
    );
    expect(progress.flow).toBe("code-change");
    expect(progress.status).toBe("active");
    expect(progress.history).toEqual([expect.objectContaining({
      sequence: 1,
      flow: "code-change",
      targetRole: "architect",
      evidence: "user-request"
    })]);
    expect((await service.getState(context)).pendingDispatch).toBeNull();
  });

  it("preserves the complete waiting question across restart and clears it only when resolved", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: () => "2026-09-09T00:00:01.000Z" });
    const question = "Please choose the required behavior.\n" + "Full context. ".repeat(1000);
    await service.requestUserInput(context, question);
    const restored = createWorkflowControlService({ fs });
    expect((await restored.getState(context)).awaitingUser?.question).toBe(question.trim());
    await expect(restored.runWhileNotAwaitingUser(context, async () => "dispatched"))
      .rejects.toMatchObject({ code: "WORKFLOW_AWAITING_USER" });
    await restored.resolveUserInput(context);
    expect((await restored.getState(context)).awaitingUser).toBeNull();
  });

  it("serializes a Gate submission with question registration and rejects later advancement", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const gate = service.runWhileNotAwaitingUser(context, async () => {
      entered();
      await finish;
      return "submitted";
    });
    await started;
    const question = service.requestUserInput(context, "Please choose.");
    expect((await service.getState(context)).awaitingUser).toBeNull();
    release();
    expect(await gate).toBe("submitted");
    await question;
    let advanced = false;
    await expect(service.runWhileNotAwaitingUser(context, async () => { advanced = true; }))
      .rejects.toMatchObject({ code: "WORKFLOW_AWAITING_USER" });
    expect(advanced).toBe(false);
    await service.resolveUserInput(context);
    await service.runWhileNotAwaitingUser(context, async () => { advanced = true; });
    expect(advanced).toBe(true);
  });

  it("replays an interrupted Workflow Progress commit before exposing state", async () => {
    const { context, fs: baseFs } = await createContext(roots);
    const failure = failureInjectingFs(baseFs);
    const service = createWorkflowControlService({ fs: failure.fs, now: sequenceClock() });
    failure.failNextJsonWrite("workflow-control.json");

    await expect(service.submitProgress(context, renderWorkflowProgress(initialProposal("architect"))))
      .rejects.toThrow("injected workflow state write failure");

    const restored = createWorkflowControlService({ fs: baseFs, now: sequenceClock() });
    const journalPath = path.join(context.taskRepoRoot, context.stateRoot, "workflow-control-transaction.json");
    // A public read exposes the pending commit without replaying it.
    expect((await restored.getState(context)).pendingDispatch).toMatchObject({
      status: "pending",
      targetRole: "architect"
    });
    await expect(restored.getProgress(context)).resolves.toMatchObject({
      revision: 1,
      proposal: { targetRole: "architect" }
    });
    await expect(baseFs.pathExists(journalPath)).resolves.toBe(true);

    await restored.recoverTask(context);
    await expect(baseFs.pathExists(journalPath)).resolves.toBe(false);
    expect((await restored.getState(context)).pendingDispatch).toMatchObject({
      status: "pending",
      targetRole: "architect"
    });
  });

  it("does not write files from public state reads", async () => {
    const { context, fs: baseFs } = await createContext(roots);
    const writes: string[] = [];
    const fs = {
      ...baseFs,
      async writeText(target: string, content: string) {
        writes.push(target);
        return baseFs.writeText(target, content);
      },
      async writeTextAtomic(target: string, content: string) {
        writes.push(target);
        return baseFs.writeTextAtomic!(target, content);
      },
      async writeJsonAtomic<T>(target: string, value: T) {
        writes.push(target);
        return baseFs.writeJsonAtomic(target, value);
      },
      async removePath(target: string, options?: { force?: boolean; recursive?: boolean }) {
        writes.push(target);
        return baseFs.removePath?.(target, options);
      }
    };
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await service.getState(context);
    await service.getProgress(context);

    expect(writes).toEqual([]);
  });

  it("replays an interrupted dispatch confirmation without duplicating history", async () => {
    const { context, fs: baseFs } = await createContext(roots);
    const failure = failureInjectingFs(baseFs);
    const service = createWorkflowControlService({ fs: failure.fs, now: sequenceClock() });
    await service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")));
    await service.claimDispatch({
      ...context,
      routePath: routePath("architect"),
      targetRole: "architect",
      routeContentHash: "route-hash",
      messageId: "message-1"
    });
    failure.failNextJsonWrite("workflow-control.json");

    await expect(service.confirmDispatch(context, "message-1"))
      .rejects.toThrow("injected workflow state write failure");

    const restored = createWorkflowControlService({ fs: baseFs, now: sequenceClock() });
    expect((await restored.getState(context)).pendingDispatch).toBeNull();
    expect((await restored.getProgress(context)).history).toEqual([
      expect.objectContaining({ sequence: 1, targetRole: "architect" })
    ]);
  });

  it("reads a pre-upgrade workflow progress document without a follow-up section", () => {
    const legacy = renderWorkflowProgress(initialProposal("architect"))
      .replace("\n## User-Approved Follow-Up\n\nApproval Text: none\n", "\n");

    expect(parseWorkflowProgress(legacy, "task-1").proposal).toMatchObject({
      requestedFlow: "code-change",
      targetRole: "architect",
      evidence: "user-request"
    });
  });

  it("atomically pauses for a user question and permanently cancels the pending dispatch", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")));

    const paused = await service.requestUserInput(context, "Which behavior should be authoritative?");
    expect(paused).toMatchObject({
      awaitingUser: {
        question: "Which behavior should be authoritative?"
      },
      pendingDispatch: null
    });

    const restored = createWorkflowControlService({ fs, now: sequenceClock() });
    await expect(restored.submitProgress(
      context,
      renderWorkflowProgress(initialProposal("architect"))
    )).rejects.toMatchObject({ code: "WORKFLOW_AWAITING_USER" });
    await expect(restored.assertRouteAuthorized({
      ...context,
      routePath: routePath("architect"),
      targetRole: "architect"
    })).rejects.toMatchObject({
      code: "WORKFLOW_AWAITING_USER",
      message: expect.stringContaining("Present the complete question and necessary context in your final reply, end the current turn, and wait for a new direct user message."),
      hint: "The previous workflow approval was canceled; request a fresh approval after the answer arrives."
    });

    expect((await restored.resolveUserInput(context)).awaitingUser).toBeNull();
    expect((await restored.getProgress(context)).proposal).toBeUndefined();
    await expect(restored.assertRouteAuthorized({
      ...context,
      routePath: routePath("architect"),
      targetRole: "architect"
    })).rejects.toMatchObject({ code: "WORKFLOW_ROUTE_NOT_APPROVED" });
  });

  it("does not cancel a dispatch that is already awaiting target confirmation", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")));
    await service.claimDispatch({
      ...context,
      routePath: routePath("architect"),
      targetRole: "architect",
      routeContentHash: "route-hash",
      messageId: "message-1"
    });

    await expect(service.requestUserInput(context, "Choose one option."))
      .rejects.toMatchObject({ code: "WORKFLOW_DISPATCH_PENDING" });
    expect((await service.getState(context)).pendingDispatch).toMatchObject({
      status: "dispatching",
      messageId: "message-1"
    });
  });

  it("accepts an already-given direct user authorization and binds each use to one transition", async () => {
    const { context, fs } = await createContext(roots);
    let authorizationSequence = 0;
    const service = createWorkflowControlService({
      fs,
      now: sequenceClock(),
      id: () => `authorization-${++authorizationSequence}`
    });
    const deniedReason = "Transition code-change/coder is not legal after the confirmed Workflow Progress history.";
    const proposal = initialProposal("coder");

    await expect(service.submitProgress(context, renderWorkflowProgress(proposal))).rejects.toMatchObject({
      code: "WORKFLOW_TRANSITION_DENIED",
      hint: expect.stringContaining("reuse an existing direct user instruction")
    });

    proposal.proposal = {
      ...proposal.proposal!,
      authorizationText: "Allow Coder to start before Architect for this dispatch only.",
      violatedRule: deniedReason
    };
    await service.submitProgress(context, renderWorkflowProgress(proposal));
    await service.claimDispatch({
      ...context,
      routePath: routePath("coder"),
      targetRole: "coder",
      routeContentHash: "route-hash",
      messageId: "message-1"
    });
    await service.confirmDispatch(context, "message-1");

    expect((await service.getState(context)).userAuthorizations).toEqual([
      expect.objectContaining({ id: "authorization-1", status: "consumed" })
    ]);
    await expect(service.assertRouteAuthorized({
      ...context,
      routePath: routePath("coder"),
      targetRole: "coder"
    })).rejects.toMatchObject({ code: "WORKFLOW_ROUTE_NOT_APPROVED" });

    await advanceWithOverride(
      service,
      fs,
      context,
      "architect",
      "user-authorized architecture check",
      "Allow Coder to start before Architect for this dispatch only."
    );
    expect((await service.getState(context)).userAuthorizations).toHaveLength(2);
  });

  it("warns about an unconfirmed delivered dispatch and accepts a late matching hook", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "authorization-1" });
    const proposal = initialProposal("coder");
    proposal.proposal = {
      ...proposal.proposal!,
      authorizationText: "Allow this Coder dispatch.",
      violatedRule: "Transition code-change/coder is not legal after the confirmed Workflow Progress history."
    };
    await service.submitProgress(context, renderWorkflowProgress(proposal));
    await service.claimDispatch({
      ...context, routePath: routePath("coder"), targetRole: "coder",
      routeContentHash: "route-hash", messageId: "message-1"
    });
    await service.markDispatchUnconfirmed(context, "message-1", "UserPromptSubmit hook timed out.");
    expect((await service.getState(context)).warnings).toEqual([
      expect.stringContaining("message-1 to coder was delivered but not confirmed")
    ]);
    await expect(service.requestUserInput(context, "Continue?")).rejects.toMatchObject({
      code: "WORKFLOW_DISPATCH_PENDING"
    });
    await service.confirmDispatch(context, "message-1");
    expect((await service.getState(context)).warnings).toEqual([]);
    expect((await service.getState(context)).userAuthorizations).toEqual([
      expect.objectContaining({ id: "authorization-1", status: "consumed" })
    ]);
    expect((await readProgress(fs, context)).history).toHaveLength(1);
  });

  it("preserves abandoned user authorization when an unconfirmed route is cleared", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "authorization-1" });
    const proposal = initialProposal("coder");
    proposal.proposal = {
      ...proposal.proposal!,
      authorizationText: "Allow this Coder dispatch.",
      violatedRule: "Transition code-change/coder is not legal after the confirmed Workflow Progress history."
    };
    await service.submitProgress(context, renderWorkflowProgress(proposal));
    await service.claimDispatch({
      ...context, routePath: routePath("coder"), targetRole: "coder",
      routeContentHash: "route-hash", messageId: "message-1"
    });
    await expect(service.cancelPendingDispatch(context)).rejects.toMatchObject({ code: "WORKFLOW_DISPATCH_PENDING" });
    await service.markDispatchUnconfirmed(context, "message-1", "Confirmation did not arrive.");
    await service.cancelPendingDispatch(context);
    expect((await service.getState(context)).userAuthorizations).toEqual([
      expect.objectContaining({
        id: "authorization-1", status: "abandoned",
        authorizationText: "Allow this Coder dispatch.",
        abandonReason: expect.stringContaining("cleared before confirmation")
      })
    ]);
    expect((await readProgress(fs, context)).history).toHaveLength(0);
  });

  it("preserves the pre-delivery baseline when executed work is confirmed manually after restart", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "authorization-1" });
    const proposal = initialProposal("coder");
    proposal.proposal = {
      ...proposal.proposal!, authorizationText: "Allow this Coder dispatch.",
      violatedRule: "Transition code-change/coder is not legal after the confirmed Workflow Progress history."
    };
    await service.submitProgress(context, renderWorkflowProgress(proposal));
    await service.claimDispatch({
      ...context, routePath: routePath("coder"), targetRole: "coder",
      routeContentHash: "route-hash", messageId: "message-1"
    });
    const baseline = (await service.getState(context)).pendingDispatch?.evidenceBaseline;
    await writeFinalArtifact(fs, context, "coder-completion.md", renderCoderCompletionTemplate(context.taskSlug), [
      ["Decision: ready_for_review|incomplete|failed", "Decision: ready_for_review"]
    ]);
    await service.markDispatchUnconfirmed(context, "message-1", "All hooks were lost.");
    const restored = createWorkflowControlService({ fs, now: sequenceClock() });
    await expect(restored.confirmDispatch(context, "wrong-message", "manual")).rejects.toMatchObject({
      code: "WORKFLOW_DISPATCH_CONFIRMATION_MISMATCH"
    });
    await restored.confirmDispatch(context, "message-1", "manual");
    const state = await restored.getState(context);
    expect(state.activeDispatch).toEqual(baseline);
    expect(state.pendingDispatch).toBeNull();
    expect(state.warnings).toEqual([]);
    expect(state.userAuthorizations[0]?.status).toBe("consumed");
    expect((await readProgress(fs, context)).history[0]?.evidence).toContain("User manually confirmed execution of message message-1");
    await advance(restored, fs, context, "tester", undefined, "validate completed work");
    expect((await readProgress(fs, context)).history).toHaveLength(2);
  });

  it("does not manually confirm a dispatch before its confirmation has failed", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")));
    await service.claimDispatch({
      ...context, routePath: routePath("architect"), targetRole: "architect",
      routeContentHash: "route-hash", messageId: "message-1"
    });
    await expect(service.confirmDispatch(context, "message-1", "manual")).rejects.toMatchObject({
      code: "WORKFLOW_DISPATCH_NOT_UNCONFIRMED"
    });
    expect((await readProgress(fs, context)).history).toEqual([]);
  });

  it("keeps authorization evidence when PM asks the user after a failed submission", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "authorization-1" });
    const proposal = initialProposal("coder");
    proposal.proposal = {
      ...proposal.proposal!,
      authorizationText: "Allow this Coder dispatch.",
      violatedRule: "Transition code-change/coder is not legal after the confirmed Workflow Progress history."
    };
    await service.submitProgress(context, renderWorkflowProgress(proposal));
    await service.claimDispatch({
      ...context, routePath: routePath("coder"), targetRole: "coder",
      routeContentHash: "route-hash", messageId: "message-1"
    });
    await service.releaseDispatch(context, "message-1");
    await service.requestUserInput(context, "How should we proceed?");
    expect((await service.getState(context)).userAuthorizations).toEqual([
      expect.objectContaining({
        id: "authorization-1", status: "abandoned",
        authorizationText: "Allow this Coder dispatch."
      })
    ]);
  });

  it("does not release a delivered unconfirmed dispatch during runtime recovery", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")));
    await service.claimDispatch({
      ...context, routePath: routePath("architect"), targetRole: "architect",
      routeContentHash: "route-hash", messageId: "message-1"
    });
    const messagesPath = path.join(context.taskRepoRoot, context.stateRoot, "messages", `${context.taskSlug}.jsonl`);
    await fs.ensureDir(path.dirname(messagesPath));
    await fs.writeText(messagesPath, `${JSON.stringify({ id: "message-1", deliveredAt: "2026-09-25T00:00:00Z" })}\n`);

    const restored = createWorkflowControlService({ fs, now: sequenceClock() });
    expect(await restored.recoverTask(context)).toBe(true);
    expect((await restored.getState(context)).pendingDispatch).toMatchObject({
      status: "dispatching", messageId: "message-1",
      confirmationError: expect.stringContaining("restarted")
    });
    await restored.confirmDispatch(context, "message-1");
    expect((await readProgress(fs, context)).history).toHaveLength(1);
  });

  it("rejects incomplete or mismatched direct user authorization", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    const proposal = initialProposal("coder");

    proposal.proposal = {
      ...proposal.proposal!,
      authorizationText: "Allow this exact Coder dispatch once.",
      violatedRule: "A different rule."
    };

    await expect(service.submitProgress(context, renderWorkflowProgress(proposal))).rejects.toMatchObject({
      code: "WORKFLOW_USER_AUTHORIZATION_INVALID",
      hint: expect.stringContaining("Ask the user only when no such authorization exists")
    });
    expect((await service.getState(context)).userAuthorizations).toEqual([]);
  });

  it("rejects modified history and recovers pending approval after service recreation", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")));

    const restored = createWorkflowControlService({ fs, now: sequenceClock() });
    await restored.assertRouteAuthorized({
      ...context,
      routePath: routePath("architect"),
      targetRole: "architect"
    });
    await restored.claimDispatch({
      ...context,
      routePath: routePath("architect"),
      targetRole: "architect",
      routeContentHash: "route-hash",
      messageId: "message-1"
    });
    await restored.confirmDispatch(context, "message-1");

    const current = parseWorkflowProgress(
      await fs.readText(path.join(context.taskRepoRoot, context.handoffDir, "workflow-progress.md")),
      context.taskSlug
    );
    const tampered: WorkflowProgressDocument = {
      ...current,
      revision: current.revision + 1,
      history: [{ ...current.history[0]!, evidence: "rewritten-history" }],
      proposal: { targetRole: "architect", evidence: "continue-planning" }
    };
    await expect(restored.submitProgress(context, renderWorkflowProgress(tampered))).rejects.toMatchObject({
      code: "WORKFLOW_PROGRESS_INVALID"
    });
  });

  it("initializes a missing progress record but preserves malformed progress fail-closed", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    expect((await service.getState(context)).warnings).toEqual([]);
    const progressPath = path.join(context.taskRepoRoot, context.handoffDir, "workflow-progress.md");
    // Public reads never write; the locked recovery path creates the template.
    await expect(fs.pathExists(progressPath)).resolves.toBe(false);
    await expect(service.getProgress(context)).resolves.toMatchObject({ revision: 0, status: "not-started" });
    await service.recoverTask(context);
    await expect(fs.readText(progressPath)).resolves.toContain("Revision: 0");

    await fs.writeText(progressPath, "# broken workflow record\n");
    const state = await service.getState(context);
    expect(state.warnings[0]).toContain("Workflow Progress is invalid and was preserved unchanged");
    await expect(service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")))).rejects.toMatchObject({
      code: "WORKFLOW_STATE_INVALID"
    });
    await expect(fs.readText(progressPath)).resolves.toBe("# broken workflow record\n");
  });

  it("fails closed when Workflow Progress disappears while runtime state exists", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")));
    const progressPath = path.join(context.taskRepoRoot, context.handoffDir, "workflow-progress.md");

    await fs.removePath?.(progressPath, { force: true });

    const state = await service.getState(context);
    expect(state.warnings).toContain(
      "Workflow Progress is missing while workflow runtime state still exists. Restore workflow-progress.md before continuing."
    );
    await expect(fs.pathExists(progressPath)).resolves.toBe(false);
    await expect(service.submitProgress(context, renderWorkflowProgress(initialProposal("architect"))))
      .rejects.toMatchObject({ code: "WORKFLOW_STATE_INVALID" });
  });

  it("fails closed when Workflow Progress no longer matches its runtime approval", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")));
    const progressPath = path.join(context.taskRepoRoot, context.handoffDir, "workflow-progress.md");
    await fs.writeText(progressPath, renderWorkflowProgress({
      ...initialProposal("coder"),
      proposal: {
        requestedFlow: "code-change",
        targetRole: "coder",
        evidence: "tampered target"
      }
    }));

    expect((await service.getState(context)).warnings).toContain(
      "Workflow runtime approval does not match workflow-progress.md."
    );
    await expect(service.assertRouteAuthorized({
      ...context,
      routePath: routePath("architect"),
      targetRole: "architect"
    })).rejects.toMatchObject({ code: "WORKFLOW_STATE_INVALID" });
  });

  it("reconstructs a conservative evidence baseline when active runtime state is missing", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await advance(service, fs, context, "architect", "code-change", "accepted task");
    await writeArchitecturePlan(fs, context);
    await writeGateIndex(fs, context, { architecture: "approve" });
    await fs.removePath?.(path.join(context.taskRepoRoot, context.stateRoot, "workflow-control.json"), { force: true });

    const recovered = await service.getState(context);
    expect(recovered.warnings).toEqual([]);
    expect(recovered.activeDispatch).toMatchObject({
      sequence: 1,
      flow: "code-change",
      targetRole: "architect"
    });

    const current = await service.getProgress(context);
    await expect(service.submitProgress(context, renderWorkflowProgress({
      ...current,
      revision: current.revision + 1,
      proposal: { targetRole: "coder", evidence: "stale plan and Gate" }
    }))).rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });

    await writeArchitecturePlan(fs, context, "reproduced after runtime recovery");
    await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:00:40.000Z");
    await service.submitProgress(context, renderWorkflowProgress({
      ...current,
      revision: current.revision + 1,
      proposal: { targetRole: "coder", evidence: "fresh plan and Gate" }
    }));
    expect((await service.getState(context)).pendingDispatch).toMatchObject({ targetRole: "coder" });
  });

  it("does not allow Coder after Architect until the real plan and architecture Gate exist", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")));
    await service.claimDispatch({
      ...context,
      routePath: routePath("architect"),
      targetRole: "architect",
      routeContentHash: "route-hash",
      messageId: "message-1"
    });
    await service.confirmDispatch(context, "message-1");
    const current = parseWorkflowProgress(
      await fs.readText(path.join(context.taskRepoRoot, context.handoffDir, "workflow-progress.md")),
      context.taskSlug
    );
    const next: WorkflowProgressDocument = {
      ...current,
      revision: current.revision + 1,
      proposal: { targetRole: "coder", evidence: "architecture-plan.md" }
    };
    await expect(service.submitProgress(context, renderWorkflowProgress(next))).rejects.toMatchObject({
      code: "WORKFLOW_TRANSITION_DENIED"
    });
  });

  it("runs the code-diff Gate after validation and completes from Final Acceptance", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, { architecture: "approve", validation: "approve" });

    // No role dispatch is legal while the code-diff Gate is pending.
    await expect(propose(service, fs, context, "architect", undefined, "post-validation docs pass"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });
    await writeFinalAcceptance(fs, context);
    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID",
      message: expect.stringContaining("The code-diff Gate has not approved the work since the latest tester dispatch")
    });

    await writeCodeDiffDecision(fs, context, "approve");
    await completeFlow(service, fs, context);
    expect((await service.getProgress(context)).status).toBe("completed");
  });

  it.each([
    [["docs-only"], "architect", undefined],
    [["test-only"], "tester", undefined],
    [["docs-only", "test-only"], "architect", undefined],
    [["implementation"], "architect", "architect-debug"],
    [["docs-only", "implementation"], "architect", "architect-debug"]
  ] as const)("routes a code-diff rejection with %j findings to %s", async (scopes, targetRole, requestedFlow) => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, { architecture: "approve", validation: "approve" });
    await writeCodeDiffDecision(fs, context, "request_changes", [...scopes]);

    await expect(advance(service, fs, context, targetRole, requestedFlow, "correct code-diff findings"))
      .resolves.toBeUndefined();
  });

  it("reviews a docs-only correction incrementally and completes after the Architect dispatch", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, { architecture: "approve", validation: "approve" });
    await writeCodeDiffDecision(fs, context, "request_changes", ["docs-only", "test-only"]);
    await writeFinalAcceptance(fs, context);
    await advance(service, fs, context, "architect", undefined, "correct the reported docs");

    // Until the rerun code-diff Gate decides, only Architect may continue.
    await expect(propose(service, fs, context, "tester", undefined, "skip the rerun"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });
    await writeCodeDiffDecision(fs, context, "approve");
    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID",
      message: expect.stringContaining("Final Acceptance was not produced after the latest dispatch")
    });
    await writeFinalAcceptance(fs, context, "accepted-with-known-risks");
    await completeFlow(service, fs, context);
    expect((await readProgress(fs, context)).history.map((entry) => entry.targetRole))
      .toEqual(["architect", "coder", "tester", "architect"]);
  });

  it("routes a test-only finding from the rerun code-diff Gate to Tester", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, { architecture: "approve", validation: "approve" });
    await writeCodeDiffDecision(fs, context, "request_changes", ["docs-only", "test-only"]);
    await advance(service, fs, context, "architect", undefined, "correct the reported docs");
    await writeCodeDiffDecision(fs, context, "request_changes", ["test-only"]);
    await advance(service, fs, context, "tester", undefined, "correct the remaining test finding");
  });

  it("routes a docs coverage start failure of the code-diff Gate to Architect", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, { architecture: "approve", validation: "approve" });
    await writeCodeDiffStartFailure(fs, context, "code-diff requires a current validation-adequacy approval.");
    await expect(propose(service, fs, context, "architect", undefined, "unrelated start failure"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });

    await writeCodeDiffStartFailure(
      fs,
      context,
      "Docs coverage check failed: DS_MODULE_NOT_COVERED crates/app: Module app changed in the task."
    );
    await advance(service, fs, context, "architect", undefined, "update the uncovered module doc");
    await writeCodeDiffDecision(fs, context, "approve");
    await writeFinalAcceptance(fs, context);
    await completeFlow(service, fs, context);
  });

  it("enforces the complete Code-Change path before accepting completion", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "code-change", "accepted task");
    await writeFinalArtifact(fs, context, "architecture-plan.md", renderArchitecturePlanTemplate(context.taskSlug), [
      ["Planning Result: complete|incomplete|user clarification required", "Planning Result: complete"]
    ]);
    await writeGateIndex(fs, context, { architecture: "approve" });
    await writeFinalAcceptance(fs, context);
    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID",
      message: expect.stringContaining("latest code-change dispatch is to architect")
    });

    await advance(service, fs, context, "coder", undefined, "complete architecture plan and approved Gate");
    await writeFinalArtifact(fs, context, "coder-completion.md", renderCoderCompletionTemplate(context.taskSlug), [
      ["Decision: ready_for_review|incomplete|failed", "Decision: ready_for_review"]
    ]);

    await advance(service, fs, context, "tester", undefined, "ready Coder completion");
    await writeFinalArtifact(fs, context, "test-report.md", renderTestReportTemplate(context.taskSlug), [
      ["Test Result: pass|fail|incomplete", "Test Result: pass"],
      ["L3 Required: yes|no", "L3 Required: no"],
      ["Status: none|repair-required|repaired|production-change-required", "Status: none"]
    ]);
    await writeGateIndex(fs, context, {
      architecture: "approve",
      validation: "approve",
      codeDiff: "approve"
    });
    await writeFinalAcceptance(fs, context);
    await completeFlow(service, fs, context);

    const completed = await readProgress(fs, context);
    expect(completed.status).toBe("completed");
    expect(completed.history.map((entry) => entry.targetRole)).toEqual(["architect", "coder", "tester"]);
  });

  it.each([
    ["coder", "latest code-change dispatch is to coder"],
    ["tester", "has no passing Test Report"]
  ] as const)(
    "rejects completion when a user-authorized late %s dispatch skips validation",
    async (targetRole, message) => {
      const { context, fs } = await createContext(roots);
      const service = createWorkflowControlService({
        fs,
        now: sequenceClock(),
        id: () => `late-${targetRole}-override`
      });

      await enterCodeChangeValidated(service, fs, context);
      await writeFinalAcceptance(fs, context);
      await advanceWithOverride(
        service,
        fs,
        context,
        targetRole,
        `user-authorized late ${targetRole} correction`,
        `Route ${targetRole} once for the exact late correction.`
      );
      await writeFinalAcceptance(fs, context);

      await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
        code: "WORKFLOW_COMPLETION_INVALID",
        message: expect.stringContaining(message)
      });
    }
  );

  it.each(["architect", "coder", "tester"] as const)("accepts %s docs-update reports in Docs-Only Flow", async (role) => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    const artifacts = createArtifactService(fs, { workflowControlService: service });
    await advance(service, fs, context, role, "docs-only", "update assigned documentation");
    await artifacts.submitArtifact({ ...docsSubmission(context), role });
    await completeFlow(service, fs, context);
  });

  it("keeps memory-owned docs updates independent of an active delivery dispatch", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeValidated(service, fs, context);
    const before = await service.getProgress(context);
    const reportPath = ".ai/vcm/memory-review/runs/run/assignments/doc-1/report.md";
    const docsOnlyReport = docsSubmission(context);
    await fs.writeText(path.join(context.taskRepoRoot, context.handoffDir, "docs-update-report.md"), docsOnlyReport.content);
    const artifacts = createArtifactService(fs, {
      workflowControlService: service,
      getDurableDocAssignment: async (root, role) => root === context.taskRepoRoot && role === "architect" ? {
        id: "doc-1", runId: "run", sourceMemoryPath: "CLAUDE.md", sourceEntry: "Fact",
        content: "Fact", reason: "Durable knowledge", evidence: ["src/app.ts"], targetPath: "docs/ARCHITECTURE.md",
        owner: "architect", status: "running", reportPath, createdAt: "2026-09-09", updatedAt: "2026-09-09"
      } : undefined
    });
    await expect(artifacts.submitArtifact({
      ...docsSubmission(context, "doc-1"), artifactPath: reportPath
    }))
      .resolves.toMatchObject({ status: "ok" });
    expect(await fs.readText(path.join(context.taskRepoRoot, context.handoffDir, "docs-update-report.md")))
      .toBe(docsOnlyReport.content);
    expect(await service.getProgress(context)).toEqual(before);
    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID",
      message: expect.stringContaining("Final Acceptance is missing")
    });
  });

  it.each(["architect-debug", "architecture-diagnosis"] as const)(
    "returns a %s branch to Code-Change Final Acceptance once its code-diff Gate passes",
    async (branch) => {
      const { context, fs } = await createContext(roots);
      const service = createWorkflowControlService({ fs, now: sequenceClock() });
      await enterCodeChangePassedBranch(service, fs, context, branch);

      // The passed branch has returned: no dispatch is needed before Final Acceptance.
      await expect(propose(service, fs, context, "architect", "code-change", "parent docs pass"))
        .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });
      await writeFinalAcceptance(fs, context);
      await completeFlow(service, fs, context);
      expect((await service.getProgress(context)).status).toBe("completed");
    }
  );

  it.each([
    ["needs-coder-follow-up", "coder"],
    ["needs-architect-follow-up", "architect"]
  ] as const)("routes a %s Final Acceptance after a passed branch into the parent flow", async (decision, targetRole) => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangePassedBranch(service, fs, context, "architect-debug");
    await writeFinalAcceptance(fs, context, decision);
    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID",
      message: expect.stringContaining("Final Acceptance Decision must be accepted")
    });

    await advance(service, fs, context, targetRole, "code-change", `apply the ${decision}`);
    expect((await service.getState(context)).flowRun).toMatchObject({
      rootFlow: "code-change",
      resumedFromBranch: "architect-debug"
    });
    if (targetRole === "architect") {
      await writeCodeDiffDecision(fs, context, "approve");
      await writeFinalAcceptance(fs, context);
      await completeFlow(service, fs, context);
    } else {
      await writeFinalArtifact(fs, context, "coder-completion.md", renderCoderCompletionTemplate(context.taskSlug), [
        ["Decision: ready_for_review|incomplete|failed", "Decision: ready_for_review"],
        ["## Changed Files\n\nTBD", "## Changed Files\n\nApplied the Final Acceptance follow-up."]
      ]);
      await advance(service, fs, context, "tester", undefined, "validate the follow-up");
    }
  });

  it("reports a non-accepted Final Acceptance decision separately from freshness", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await enterCodeChangeValidated(service, fs, context);
    await writeFinalAcceptance(fs, context, "needs-architect-follow-up");

    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID",
      message: expect.stringContaining("Final Acceptance Decision must be accepted or accepted-with-known-risks")
    });
    await advance(service, fs, context, "architect", undefined, "apply the Architect follow-up");
  });

  it("allows the same user approval text for separate bound follow-ups and invalidates prior Gates", async () => {
    const { context, fs } = await createContext(roots);
    let approvalSequence = 0;
    const service = createWorkflowControlService({
      fs,
      now: sequenceClock(),
      id: () => `follow-up-${++approvalSequence}`
    });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "pass");
    await expect(advanceWithFollowUpApproval(
      service,
      fs,
      context,
      "premature approved work",
      "Add the regression coverage in this task."
    )).rejects.toMatchObject({ code: "WORKFLOW_FOLLOW_UP_APPROVAL_INVALID" });
    await writeGateIndex(fs, context, {
      architecture: "approve",
      validation: "approve"
    }, "2026-08-06T00:00:30.000Z");
    // The follow-up checkpoint follows both the validation-adequacy and code-diff Gates.
    await expect(advanceWithFollowUpApproval(
      service,
      fs,
      context,
      "approved work before code-diff",
      "Add the regression coverage in this task."
    )).rejects.toMatchObject({ code: "WORKFLOW_FOLLOW_UP_APPROVAL_INVALID" });
    await writeCodeDiffDecision(fs, context, "approve");

    await expect(propose(service, fs, context, "tester", undefined, "add approved regression coverage"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });
    await advanceWithFollowUpApproval(
      service,
      fs,
      context,
      "add approved regression coverage",
      "Add the regression coverage in this task."
    );

    const approvedState = await service.getState(context);
    expect(approvedState.userAuthorizations).toEqual([]);
    expect(approvedState.userApprovedFollowUps).toEqual([
      expect.objectContaining({
        id: "follow-up-1",
        status: "consumed",
        targetRole: "tester",
        approvalText: "Add the regression coverage in this task."
      })
    ]);
    expect((await readProgress(fs, context)).history.at(-1)).toMatchObject({
      targetRole: "tester",
      followUpApprovalId: "follow-up-1"
    });

    await writeTestReport(fs, context, "pass", "none", "approved follow-up validation");
    await writeFinalAcceptance(fs, context);
    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID"
    });
    await writeGateIndex(fs, context, {
      architecture: "approve",
      validation: "approve",
      codeDiff: "approve"
    }, "2026-08-06T00:00:50.000Z");
    await advanceWithFollowUpApproval(
      service,
      fs,
      context,
      "repeat approved work",
      "Add the regression coverage in this task."
    );
    expect((await service.getState(context)).userApprovedFollowUps).toHaveLength(2);
    await writeTestReport(fs, context, "pass", "none", "repeated approved follow-up validation");
    await writeGateIndex(fs, context, {
      architecture: "approve",
      validation: "approve",
      codeDiff: "approve"
    }, "2026-08-06T00:01:10.000Z");
    await writeFinalAcceptance(fs, context);
    await completeFlow(service, fs, context);
  });

  it("routes a rejected validation Gate back to Tester before implementation failure branches", async () => {
    for (const flow of ["code-change", "architect-debug", "architecture-diagnosis"] as const) {
      const { context, fs } = await createContext(roots);
      const service = createWorkflowControlService({ fs, now: sequenceClock() });

      if (flow === "code-change") {
        await enterCodeChangeTester(service, fs, context);
      } else {
        await advance(service, fs, context, "architect", flow, `accepted ${flow} task`);
        if (flow === "architect-debug") {
          await writeArchitectDebug(fs, context, "debug repair");
        } else {
          await writeArchitectureDiagnosis(fs, context, "diagnosis repair");
        }
        await advance(service, fs, context, "tester", undefined, `validate ${flow} repair`);
      }
      await writeTestReport(fs, context, "fail", "none", `${flow} validation failure`);
      await writeGateIndex(fs, context, { validation: "request_changes" }, "2026-08-06T00:00:10.000Z");

      await expect(propose(service, fs, context, "architect", undefined, "revise implementation"))
        .rejects.toMatchObject({
          code: "WORKFLOW_TRANSITION_DENIED",
          hint: expect.stringContaining(`Allowed next dispatches: ${flow}/tester`)
        });
      await advance(service, fs, context, "tester", undefined, "address validation Gate findings");

      expect((await readProgress(fs, context)).history.at(-1)).toMatchObject({ flow, targetRole: "tester" });
    }
  });

  it("still stops a standalone Architecture Diagnosis after an ordinary Tester failure", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "architecture-diagnosis", "accepted diagnosis task");
    await writeArchitectureDiagnosis(fs, context, "diagnosis repair");
    await advance(service, fs, context, "tester", undefined, "validate diagnosis repair");
    await writeTestReport(fs, context, "fail", "none", "diagnosis validation failure");

    await expect(propose(service, fs, context, "architect", undefined, "another diagnosis repair"))
      .rejects.toMatchObject({
        code: "WORKFLOW_TRANSITION_DENIED",
        hint: expect.stringContaining("Architecture Diagnosis stopped after the current Tester failure")
      });
  });

  it("does not reuse a validation Gate decision that predates the current Tester dispatch", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "architecture-diagnosis", "accepted diagnosis task");
    await writeArchitectureDiagnosis(fs, context, "diagnosis repair");
    await writeGateIndex(fs, context, { validation: "request_changes" }, "2026-08-06T00:00:10.000Z");
    await advance(service, fs, context, "tester", undefined, "validate diagnosis repair");
    await writeTestReport(fs, context, "fail", "none", "diagnosis validation failure");

    await expect(propose(service, fs, context, "tester", undefined, "reuse stale Gate decision"))
      .rejects.toMatchObject({
        code: "WORKFLOW_TRANSITION_DENIED",
        hint: expect.stringContaining("Architecture Diagnosis stopped after the current Tester failure")
      });
  });

  it("continues an approved Coverage Gap after validation and code-diff Gates approve", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context);
    await writeApprovedCoverageGapTestReport(fs, context);
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "coder"
    }, "2026-08-06T00:00:40.000Z");

    await writeFinalAcceptance(fs, context, "accepted-with-known-risks");
    await completeFlow(service, fs, context);

    expect((await readProgress(fs, context))).toMatchObject({ flow: "code-change", status: "completed" });
  });

  it("routes a failed Architect Debug validation through Diagnosis and back to Tester", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "architect-debug", "accepted debug task");
    await writeArchitectDebug(fs, context, "debug repair");
    await advance(service, fs, context, "tester", undefined, "validate debug repair");
    await writeTestReport(fs, context, "fail", "none", "debug validation failure");

    await advance(service, fs, context, "architect", "architecture-diagnosis", "debug validation failed");
    await writeArchitectureDiagnosis(fs, context, "diagnosis repair");
    await advance(service, fs, context, "tester", undefined, "validate diagnosis repair");

    expect((await readProgress(fs, context)).history.map((entry) => `${entry.flow}/${entry.targetRole}`)).toEqual([
      "architect-debug/architect",
      "architect-debug/tester",
      "architecture-diagnosis/architect",
      "architecture-diagnosis/tester"
    ]);
  });

  it("starts a completed flow again as a fresh run and rejects stale artifacts", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "docs-only", "first docs request");
    await writeDocsUpdateReport(fs, context, "synced", "first run");
    await completeFlow(service, fs, context);

    await expect(propose(service, fs, context, "architect", undefined, "start another docs run"))
      .rejects.toMatchObject({ code: "WORKFLOW_FLOW_REQUIRED" });

    await advance(service, fs, context, "architect", "docs-only", "second docs request");
    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID"
    });

    await writeDocsUpdateReport(fs, context, "unchanged", "second run");
    await completeFlow(service, fs, context);

    const progress = await readProgress(fs, context);
    expect(progress.status).toBe("completed");
    expect(progress.history.map((entry) => `${entry.flow}/${entry.targetRole}`)).toEqual([
      "docs-only/architect",
      "docs-only/architect"
    ]);
  });

  it("does not reuse a completed Code-Change history when starting another Code-Change flow", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context, "first code-change plan");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "coder"
    }, "2026-08-06T00:00:40.000Z");
    await writeFinalAcceptance(fs, context);
    await completeFlow(service, fs, context);

    await advance(service, fs, context, "architect", "code-change", "second code-change request");
    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID"
    });
    await writeArchitecturePlan(fs, context, "second code-change plan");
    await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:00:50.000Z");
    await advance(service, fs, context, "coder", undefined, "second fresh plan and Gate");

    const history = (await readProgress(fs, context)).history;
    expect(history.at(-1)).toMatchObject({ flow: "code-change", targetRole: "coder" });
  });

  it("switches Docs-Only to Validation-Only and completes from fresh Tester evidence", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "docs-only", "documentation request");
    await advance(service, fs, context, "tester", "validation-only", "validation ownership discovered");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, { validation: "approve" }, "2026-08-06T00:01:00.000Z");
    await completeFlow(service, fs, context);

    expect((await readProgress(fs, context))).toMatchObject({
      flow: "validation-only",
      status: "completed"
    });
  });

  it("switches Validation-Only to a fresh Code-Change plan when production code is required", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "tester", "validation-only", "validation request");
    await writeTestReport(fs, context, "fail", "production-change-required");
    await advance(service, fs, context, "architect", "code-change", "production change required");

    await expect(propose(service, fs, context, "coder", undefined, "reuse prior flow evidence"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });

    await writeArchitecturePlan(fs, context);
    await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:01:10.000Z");
    await advance(service, fs, context, "coder", undefined, "fresh plan and architecture Gate");

    expect((await readProgress(fs, context)).history.map((entry) => `${entry.flow}/${entry.targetRole}`)).toEqual([
      "validation-only/tester",
      "code-change/architect",
      "code-change/coder"
    ]);
  });

  it("completes Code-Change from a successful Debug Branch without a return dispatch", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "fail", "none", "code-change validation failure");

    await advance(service, fs, context, "architect", "architect-debug", "Tester failed");
    await writeArchitectDebug(fs, context, "debug repair");
    await advance(service, fs, context, "tester", undefined, "validate debug repair");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "architect-debug"
    }, "2026-08-06T00:02:00.000Z");

    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID",
      message: expect.stringContaining("Final Acceptance is missing")
    });

    await writeFinalAcceptance(fs, context);
    await completeFlow(service, fs, context);

    expect((await readProgress(fs, context))).toMatchObject({
      status: "completed",
      history: expect.arrayContaining([expect.objectContaining({ flow: "architect-debug", targetRole: "tester" })])
    });
  });

  it("starts a fresh Code-Change plan when a Debug Branch requires normal planning", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "fail", "none", "code-change validation failure");

    await advance(service, fs, context, "architect", "architect-debug", "Tester failed");
    await writeArchitectDebug(fs, context, "repair requires broader planning", "normal architecture plan required");
    await advance(service, fs, context, "architect", "code-change", "normal architecture plan required");

    expect((await service.getState(context)).flowRun).toEqual({
      rootFlow: "code-change",
      startedAtSequence: 5
    });
    expect((await readProgress(fs, context)).history.at(-1)).toMatchObject({
      sequence: 5,
      flow: "code-change",
      targetRole: "architect"
    });
  });

  it.each([
    ["architect-debug", "architect-debug.md"],
    ["architecture-diagnosis", "architecture-diagnosis.md"]
  ] as const)("returns %s to Architect after user clarification", async (flow, artifactName) => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", flow, "investigate the reported failure");
    if (flow === "architect-debug") {
      await writeArchitectDebug(fs, context, "user intent is required", "user clarification required");
    } else {
      await writeArchitectureDiagnosis(fs, context, "user intent is required", "user clarification required");
    }

    await service.requestUserInput(context, "Which behavior should be authoritative?");
    await service.resolveUserInput(context);
    await advance(service, fs, context, "architect", undefined, "continue with the user's answer");

    expect((await readProgress(fs, context)).history).toEqual([
      expect.objectContaining({ sequence: 1, flow, targetRole: "architect" }),
      expect.objectContaining({ sequence: 2, flow, targetRole: "architect" })
    ]);
    expect(await fs.readText(path.join(context.taskRepoRoot, context.handoffDir, artifactName)))
      .toContain("user clarification required");
  });

  it("preserves the parent Code-Change run when an override adds Tester at Debug Branch exit", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({
      fs,
      now: sequenceClock(),
      id: () => "branch-exit-override"
    });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "fail", "none", "code-change validation failure");

    await advance(service, fs, context, "architect", "architect-debug", "Tester failed");
    await writeArchitectDebug(fs, context, "debug repair");
    await advance(service, fs, context, "tester", undefined, "validate debug repair");
    await writeTestReport(fs, context, "pass", "none", "debug branch validation");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "architect-debug"
    }, "2026-08-06T00:02:30.000Z");

    await advanceWithOverride(
      service,
      fs,
      context,
      "tester",
      "user-authorized additional validation",
      "Run one additional Tester round before Final Acceptance.",
      "code-change"
    );

    expect((await service.getState(context))).toMatchObject({
      flowRun: {
        rootFlow: "code-change",
        resumedFromBranch: "architect-debug",
        startedAtSequence: 1
      },
      userAuthorizations: [
        expect.objectContaining({ id: "branch-exit-override", status: "consumed" })
      ]
    });

    await writeTestReport(fs, context, "pass", "none", "additional validation completed");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "architect-debug"
    }, "2026-08-06T00:02:40.000Z");

    const restored = createWorkflowControlService({ fs, now: sequenceClock() });
    await expect(propose(restored, fs, context, "architect", undefined, "post-validation docs pass"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });
    await writeFinalAcceptance(fs, context);
    await completeFlow(restored, fs, context);
    expect((await restored.getState(context)).userAuthorizations).toHaveLength(1);

    const progress = await readProgress(fs, context);
    expect(progress.status).toBe("completed");
    expect(progress.history.map((entry) => `${entry.flow}/${entry.targetRole}`)).toEqual([
      "code-change/architect",
      "code-change/coder",
      "code-change/tester",
      "architect-debug/architect",
      "architect-debug/tester",
      "code-change/tester"
    ]);
    expect(progress.history.filter((entry) => entry.overrideAuthorizationId)).toHaveLength(1);
  });

  it("starts a fresh flow run for an override that genuinely switches active flows", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "flow-switch-override" });

    await advance(service, fs, context, "architect", "code-change", "accepted code change");
    await advanceWithOverride(
      service,
      fs,
      context,
      "architect",
      "user-authorized independent documentation flow",
      "Switch this active task to Docs-Only now.",
      "docs-only"
    );

    expect((await service.getState(context)).flowRun).toEqual({
      rootFlow: "docs-only",
      startedAtSequence: 2
    });
  });

  it("keeps Diagnosis as the reviewed code source when an override adds Tester at branch exit", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "diagnosis-exit-override" });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "fail", "none", "code-change validation failure");

    await advance(service, fs, context, "architect", "architect-debug", "Tester failed");
    await writeArchitectDebug(fs, context, "debug repair");
    await advance(service, fs, context, "tester", undefined, "validate debug repair");
    await writeTestReport(fs, context, "fail", "none", "debug validation failure");

    await advance(service, fs, context, "architect", "architecture-diagnosis", "debug repair failed");
    await writeArchitectureDiagnosis(fs, context, "diagnosis repair");
    await advance(service, fs, context, "tester", undefined, "validate diagnosis repair");
    await writeTestReport(fs, context, "pass", "none", "diagnosis branch validation");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "architect-diagnosis"
    }, "2026-08-06T00:02:50.000Z");

    await advanceWithOverride(
      service,
      fs,
      context,
      "tester",
      "user-authorized additional validation",
      "Run one additional Tester round before Final Acceptance.",
      "code-change"
    );
    expect((await service.getState(context)).flowRun).toMatchObject({
      rootFlow: "code-change",
      resumedFromBranch: "architecture-diagnosis",
      startedAtSequence: 1
    });

    await writeTestReport(fs, context, "pass", "none", "additional diagnosis validation completed");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "architect-diagnosis"
    }, "2026-08-06T00:03:00.000Z");
    await writeFinalAcceptance(fs, context);
    await completeFlow(service, fs, context);

    expect((await service.getState(context)).userAuthorizations).toHaveLength(1);
    expect((await readProgress(fs, context))).toMatchObject({
      flow: "code-change",
      status: "completed"
    });
  });

  it("replaces a failed Debug Branch with Diagnosis and completes Code-Change from it", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "fail");

    await advance(service, fs, context, "architect", "architect-debug", "Tester failed");
    await writeArchitectDebug(fs, context, "debug repair");
    await advance(service, fs, context, "tester", undefined, "validate debug repair");
    await writeTestReport(fs, context, "fail", "none", "debug validation failure");

    await advance(service, fs, context, "architect", "architecture-diagnosis", "debug repair failed");
    await writeArchitectureDiagnosis(fs, context, "diagnosis repair");
    await advance(service, fs, context, "tester", undefined, "validate diagnosis repair");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "architect-diagnosis"
    }, "2026-08-06T00:02:10.000Z");

    const restored = createWorkflowControlService({ fs, now: sequenceClock() });
    expect((await restored.getState(context)).flowRun).toMatchObject({
      rootFlow: "code-change",
      activeBranch: "architecture-diagnosis"
    });
    await writeFinalAcceptance(fs, context);
    await completeFlow(restored, fs, context);

    expect((await readProgress(fs, context)).history.map((entry) => entry.flow)).toEqual([
      "code-change",
      "code-change",
      "code-change",
      "architect-debug",
      "architect-debug",
      "architecture-diagnosis",
      "architecture-diagnosis"
    ]);
  });

  it("completes a standalone Debug Flow from a successful Diagnosis Branch", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "architect-debug", "standalone debug request");
    await writeArchitectDebug(fs, context, "debug repair");
    await advance(service, fs, context, "tester", undefined, "validate debug repair");
    await writeTestReport(fs, context, "fail");
    await advance(service, fs, context, "architect", "architecture-diagnosis", "debug repair failed");
    await writeArchitectureDiagnosis(fs, context, "diagnosis repair");
    await advance(service, fs, context, "tester", undefined, "validate diagnosis repair");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "architect-diagnosis"
    }, "2026-08-06T00:02:20.000Z");

    await writeFinalAcceptance(fs, context, "needs-architect-follow-up");
    await advance(service, fs, context, "architect", "architect-debug", "apply the Final Acceptance follow-up");
    expect((await service.getState(context)).flowRun).toMatchObject({
      rootFlow: "architect-debug",
      resumedFromBranch: "architecture-diagnosis"
    });
    await writeCodeDiffDecision(fs, context, "approve");
    await writeFinalAcceptance(fs, context);
    await completeFlow(service, fs, context);

    expect((await readProgress(fs, context))).toMatchObject({ flow: "architect-debug", status: "completed" });
  });

  it("returns an analysis-only Diagnosis Branch directly to its parent flow", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context);
    await writeTestReport(fs, context, "fail");
    await advance(service, fs, context, "architect", "architect-debug", "Tester failed");
    await writeArchitectDebug(fs, context, "debug repair");
    await advance(service, fs, context, "tester", undefined, "validate debug repair");
    await writeTestReport(fs, context, "fail", "none", "debug validation failed");
    await advance(service, fs, context, "architect", "architecture-diagnosis", "debug repair failed");
    await writeArchitectureDiagnosis(fs, context, "architecture analysis only", "analysis completed");

    await advance(service, fs, context, "architect", "code-change", "resume parent planning");

    expect((await service.getState(context)).flowRun).toMatchObject({
      rootFlow: "code-change",
      resumedFromBranch: "architecture-diagnosis"
    });
    expect((await readProgress(fs, context)).history.at(-1)).toMatchObject({
      flow: "code-change",
      targetRole: "architect"
    });
  });

  it("completes a standalone analysis-only Architecture Diagnosis without Tester", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await advance(service, fs, context, "architect", "architecture-diagnosis", "analyze the architecture");
    await writeArchitectureDiagnosis(fs, context, "architecture analysis only", "analysis completed");

    await completeFlow(service, fs, context);

    expect((await readProgress(fs, context))).toMatchObject({
      flow: "architecture-diagnosis",
      status: "completed",
      history: [expect.objectContaining({ targetRole: "architect" })]
    });
  });

  it.each([
    ["code-change", "architect", "docs-only", "architect"],
    ["code-change", "architect", "validation-only", "tester"],
    ["architect-debug", "architect", "docs-only", "architect"],
    ["architecture-diagnosis", "architect", "validation-only", "tester"],
    ["validation-only", "tester", "docs-only", "architect"]
  ] as const)(
    "rejects an unlisted active-flow switch from %s to %s",
    async (sourceFlow, sourceRole, requestedFlow, targetRole) => {
      const { context, fs } = await createContext(roots);
      const service = createWorkflowControlService({ fs, now: sequenceClock() });
      await advance(service, fs, context, sourceRole, sourceFlow, "accepted source flow");

      await expect(propose(service, fs, context, targetRole, requestedFlow, "unlisted flow switch"))
        .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });
    }
  );

  it("distinguishes a post-validation Diagnosis docs correction from another implementation repair", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "architecture-diagnosis", "accepted diagnosis task");
    await writeArchitectureDiagnosis(fs, context, "implemented diagnosis");
    await advance(service, fs, context, "tester", undefined, "validate diagnosis implementation");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "request_changes",
      codeDiffSource: "architect-diagnosis"
    });
    await writeCodeDiffDecision(fs, context, "request_changes", ["docs-only"]);

    await advance(service, fs, context, "architect", undefined, "correct the reported docs");
    await writeCodeDiffDecision(fs, context, "approve");
    await writeFinalAcceptance(fs, context);
    await completeFlow(service, fs, context);
    expect((await readProgress(fs, context)).status).toBe("completed");
  });

  it("returns a rewritten Diagnosis result after validation to Tester", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "architecture-diagnosis", "accepted diagnosis task");
    await writeArchitectureDiagnosis(fs, context, "implemented diagnosis");
    await advance(service, fs, context, "tester", undefined, "validate diagnosis implementation");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiffSource: "architect-diagnosis"
    });
    await writeCodeDiffDecision(fs, context, "request_changes", ["implementation"]);
    await advance(service, fs, context, "architect", undefined, "repair the implementation finding");
    await writeArchitectureDiagnosis(fs, context, "repaired diagnosis implementation");

    await advance(service, fs, context, "tester", undefined, "validate the repaired implementation");
  });

  it("allows only the explicit Docs-Only flow switches", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await advance(service, fs, context, "architect", "docs-only", "accepted docs task");

    const current = await readProgress(fs, context);
    await service.submitProgress(context, renderWorkflowProgress({
      ...current,
      revision: current.revision + 1,
      proposal: {
        requestedFlow: "validation-only",
        targetRole: "tester",
        evidence: "documentation work belongs to validation ownership"
      }
    }));

    expect((await service.getState(context)).pendingDispatch).toMatchObject({
      effectiveFlow: "validation-only",
      targetRole: "tester"
    });
  });

  it("rejects Docs-Only completion without a fresh complete accepted Docs Update Report", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await advance(service, fs, context, "architect", "docs-only", "accepted docs task");
    const current = await readProgress(fs, context);
    const completion = renderWorkflowProgress({
      ...current,
      revision: current.revision + 1,
      status: "completed",
      proposal: undefined
    });

    await expect(service.submitProgress(context, completion)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID"
    });

    await writeFinalArtifact(fs, context, "docs-update-report.md", renderDocsUpdateReportTemplate(context.taskSlug), [
      ["synced|unchanged|blocked", "blocked"]
    ]);
    await expect(service.submitProgress(context, completion)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID"
    });
  });

  for (const decision of ["synced", "unchanged"] as const) {
    it(`completes Docs-Only Flow from a complete ${decision} Docs Update Report`, async () => {
      const { context, fs } = await createContext(roots);
      const service = createWorkflowControlService({ fs, now: sequenceClock() });
      await advance(service, fs, context, "tester", "docs-only", "accepted testing documentation task");
      await writeFinalArtifact(fs, context, "docs-update-report.md", renderDocsUpdateReportTemplate(context.taskSlug), [
        ["synced|unchanged|blocked", decision]
      ]);

      const current = await readProgress(fs, context);
      await service.submitProgress(context, renderWorkflowProgress({
        ...current,
        revision: current.revision + 1,
        status: "completed",
        proposal: undefined
      }));

      expect((await readProgress(fs, context)).status).toBe("completed");
    });
  }

  it("requires each sequential Docs-Only role to replace the report with fresh evidence", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await advance(service, fs, context, "architect", "docs-only", "update architecture documentation");
    await writeFinalArtifact(fs, context, "docs-update-report.md", renderDocsUpdateReportTemplate(context.taskSlug), [
      ["synced|unchanged|blocked", "synced"],
      ["## Evidence Reviewed\n\nTBD", "## Evidence Reviewed\n\nArchitecture evidence."]
    ]);
    await advance(service, fs, context, "coder", undefined, "update implementation reference documentation");

    await expect(completeFlow(service, fs, context)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID"
    });

    await writeFinalArtifact(fs, context, "docs-update-report.md", renderDocsUpdateReportTemplate(context.taskSlug), [
      ["synced|unchanged|blocked", "unchanged"],
      ["## Evidence Reviewed\n\nTBD", "## Evidence Reviewed\n\nImplementation reference evidence."]
    ]);
    await completeFlow(service, fs, context);

    expect((await readProgress(fs, context))).toMatchObject({
      status: "completed",
      history: [
        expect.objectContaining({ flow: "docs-only", targetRole: "architect" }),
        expect.objectContaining({ flow: "docs-only", targetRole: "coder" })
      ]
    });
  });

  it("accepts an identical report that was freshly rewritten by the latest assigned role", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await advance(service, fs, context, "architect", "docs-only", "review current documentation");
    const reportPath = path.join(context.taskRepoRoot, context.handoffDir, "docs-update-report.md");
    const content = renderDocsUpdateReportTemplate(context.taskSlug)
      .replace("synced|unchanged|blocked", "unchanged")
      .replaceAll("TBD", "Verified task evidence.");
    await fs.writeText(reportPath, content);
    await advance(service, fs, context, "coder", undefined, "verify the same documentation state");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await fs.writeText(reportPath, content);

    await completeFlow(service, fs, context);

    expect((await readProgress(fs, context)).status).toBe("completed");
  });

  it.each(["not_required", "skipped", "overridden"] as const)(
    "requires a fresh %s Architecture Gate exception after another Architect dispatch",
    async (status) => {
      const { context, fs } = await createContext(roots);
      const service = createWorkflowControlService({ fs, now: sequenceClock() });
      await advance(service, fs, context, "architect", "code-change", "initial planning");
      await writeGateStatus(fs, context, "architecture-plan", status, "2026-08-06T00:00:10.000Z");
      await advance(service, fs, context, "architect", undefined, "complete missing plan");
      await writeArchitecturePlan(fs, context, "complete architecture plan");

      await expect(propose(service, fs, context, "coder", undefined, "stale Gate exception"))
        .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });

      await writeGateStatus(fs, context, "architecture-plan", status, "2026-08-06T00:00:20.000Z");
      await propose(service, fs, context, "coder", undefined, "fresh Gate exception");
      expect((await service.getState(context)).pendingDispatch).toMatchObject({ targetRole: "coder" });
    }
  );

  it("requires a fresh Architecture Gate after Final Acceptance sends an Architect follow-up", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    const history = [
      historyEntry(1, "architect", "2026-08-06T00:00:01.000Z"),
      historyEntry(2, "coder", "2026-08-06T00:00:02.000Z"),
      historyEntry(3, "tester", "2026-08-06T00:00:03.000Z"),
      historyEntry(4, "architect", "2026-08-06T00:00:04.000Z"),
      historyEntry(5, "architect", "2026-08-06T00:00:05.000Z")
    ];
    await fs.writeText(
      path.join(context.taskRepoRoot, context.handoffDir, "workflow-progress.md"),
      renderWorkflowProgress({
        taskSlug: context.taskSlug,
        revision: 5,
        flow: "code-change",
        status: "active",
        history
      })
    );
    await writeFinalArtifact(fs, context, "architecture-plan.md", renderArchitecturePlanTemplate(context.taskSlug), [
      ["Planning Result: complete|incomplete|user clarification required", "Planning Result: complete"]
    ]);
    await writeCodeDiffDecision(fs, context, "approve");
    await writeFinalAcceptance(fs, context, "needs-architect-follow-up");
    await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:00:04.000Z");

    const coderProposal: WorkflowProgressDocument = {
      ...(await readProgress(fs, context)),
      revision: 6,
      proposal: { targetRole: "coder", evidence: "revised architecture plan" }
    };
    await expect(service.submitProgress(context, renderWorkflowProgress(coderProposal))).rejects.toMatchObject({
      code: "WORKFLOW_TRANSITION_DENIED"
    });

    await writeArchitecturePlan(fs, context, "revised architecture follow-up");
    await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:00:06.000Z");
    await service.submitProgress(context, renderWorkflowProgress(coderProposal));
    expect((await service.getState(context)).pendingDispatch).toMatchObject({ targetRole: "coder" });
  });

  it("reopens the implementation leg when a fresh approved plan is produced after Tester", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context, "initial implementation plan");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "coder"
    }, "2026-08-06T00:00:40.000Z");
    await writeFinalAcceptance(fs, context, "needs-architect-follow-up");
    await advance(service, fs, context, "architect", undefined, "review expanded task scope");

    await writeArchitecturePlan(fs, context, "expanded implementation plan");
    await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:00:50.000Z");
    await advance(service, fs, context, "coder", undefined, "implement the approved expanded plan");

    const progress = await readProgress(fs, context);
    expect(progress.history.map((entry) => `${entry.flow}/${entry.targetRole}`)).toEqual([
      "code-change/architect",
      "code-change/coder",
      "code-change/tester",
      "code-change/architect",
      "code-change/coder"
    ]);
    expect((await service.getState(context)).userAuthorizations).toEqual([]);
  });

  it("does not reopen the implementation leg until the revised plan has a fresh Gate result", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context, "initial implementation plan");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "coder"
    }, "2026-08-06T00:00:40.000Z");
    await writeFinalAcceptance(fs, context, "needs-architect-follow-up");
    await advance(service, fs, context, "architect", undefined, "review expanded task scope");
    await writeArchitecturePlan(fs, context, "expanded implementation plan");

    await expect(propose(service, fs, context, "coder", undefined, "revised plan with stale Gate"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });

    await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:00:50.000Z");
    await propose(service, fs, context, "coder", undefined, "revised plan with fresh Gate");
    expect((await service.getState(context)).pendingDispatch).toMatchObject({ targetRole: "coder" });
  });

  it("returns a revised post-Tester plan to Architect when its fresh Gate requests changes", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context, "initial implementation plan");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "coder"
    }, "2026-08-06T00:00:40.000Z");
    await writeFinalAcceptance(fs, context, "needs-architect-follow-up");
    await advance(service, fs, context, "architect", undefined, "review expanded task scope");
    await writeArchitecturePlan(fs, context, "expanded implementation plan");
    await writeGateIndex(fs, context, { architecture: "request_changes" }, "2026-08-06T00:00:50.000Z");

    await expect(propose(service, fs, context, "coder", undefined, "implement rejected revised plan"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });
    await propose(service, fs, context, "architect", undefined, "revise the rejected plan");
    expect((await service.getState(context)).pendingDispatch).toMatchObject({ targetRole: "architect" });
  });

  it("does not treat a fresh Gate for an unchanged plan as a new implementation leg", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });
    await enterCodeChangeTester(service, fs, context, "initial implementation plan");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "coder"
    }, "2026-08-06T00:00:40.000Z");
    await writeFinalAcceptance(fs, context, "needs-architect-follow-up");
    await advance(service, fs, context, "architect", undefined, "apply the Architect follow-up");
    await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:00:50.000Z");

    await expect(propose(service, fs, context, "coder", undefined, "reuse the unchanged plan"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });
    await propose(service, fs, context, "architect", undefined, "finish the Architect follow-up");
    expect((await service.getState(context)).pendingDispatch).toMatchObject({ targetRole: "architect" });
  });
});

function docsSubmission(context: WorkflowControlContext, assignmentId = "docs-only") {
  return {
    repoRoot: context.taskRepoRoot,
    baseRepoRoot: context.taskRepoRoot,
    ...context,
    kind: "docs-update-report",
    role: "architect" as const,
    mode: "final" as const,
    content: renderDocsUpdateReportTemplate(context.taskSlug, assignmentId)
      .replace("synced|unchanged|blocked", "unchanged")
      .replaceAll("TBD", "Verified task evidence.")
  };
}

async function createContext(roots: string[]) {
  const taskRepoRoot = await mkdtemp(path.join(os.tmpdir(), "vcm-workflow-control-"));
  roots.push(taskRepoRoot);
  const fs = createNodeFileSystemAdapter();
  const context: WorkflowControlContext = {
    taskRepoRoot,
    stateRoot: ".ai/vcm",
    handoffDir: ".ai/vcm/handoffs",
    taskSlug: "task-1"
  };
  await fs.ensureDir(path.join(taskRepoRoot, context.stateRoot));
  await fs.ensureDir(path.join(taskRepoRoot, context.handoffDir));
  return { context, fs };
}

function initialProposal(targetRole: "architect" | "coder"): WorkflowProgressDocument {
  return {
    taskSlug: "task-1",
    revision: 1,
    status: "not-started",
    history: [],
    proposal: {
      requestedFlow: "code-change",
      targetRole,
      evidence: "user-request"
    }
  };
}

function routePath(role: DispatchableRole) {
  return `.ai/vcm/handoffs/messages/project-manager-${role}.md`;
}

async function advance(
  service: WorkflowControlService,
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  targetRole: DispatchableRole,
  requestedFlow: WorkflowProgressDocument["flow"],
  evidence: string
): Promise<void> {
  const current = await readProgress(fs, context);
  await service.submitProgress(context, renderWorkflowProgress({
    ...current,
    revision: current.revision + 1,
    proposal: { targetRole, requestedFlow, evidence }
  }));
  const messageId = `message-${current.revision + 1}`;
  await service.claimDispatch({
    ...context,
    routePath: routePath(targetRole),
    targetRole,
    routeContentHash: `route-${current.revision + 1}`,
    messageId
  });
  await service.confirmDispatch(context, messageId);
}

async function propose(
  service: WorkflowControlService,
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  targetRole: DispatchableRole,
  requestedFlow: WorkflowProgressDocument["flow"],
  evidence: string
): Promise<void> {
  const current = await readProgress(fs, context);
  await service.submitProgress(context, renderWorkflowProgress({
    ...current,
    revision: current.revision + 1,
    proposal: { targetRole, requestedFlow, evidence }
  }));
}

async function advanceWithOverride(
  service: WorkflowControlService,
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  targetRole: DispatchableRole,
  evidence: string,
  authorizationText: string,
  requestedFlow?: WorkflowProgressDocument["flow"]
): Promise<void> {
  const current = await readProgress(fs, context);
  const effectiveFlow = requestedFlow ?? current.flow!;
  const violatedRule = `Transition ${effectiveFlow}/${targetRole} is not legal after the confirmed Workflow Progress history.`;
  const proposal: WorkflowProgressDocument = {
    ...current,
    revision: current.revision + 1,
    proposal: {
      requestedFlow,
      targetRole,
      evidence,
      authorizationText,
      violatedRule
    }
  };
  await service.submitProgress(context, renderWorkflowProgress(proposal));
  const messageId = `message-${proposal.revision}`;
  await service.claimDispatch({
    ...context,
    routePath: routePath(targetRole),
    targetRole,
    routeContentHash: `route-${proposal.revision}`,
    messageId
  });
  await service.confirmDispatch(context, messageId);
}

async function advanceWithFollowUpApproval(
  service: WorkflowControlService,
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  evidence: string,
  approvalText: string
): Promise<void> {
  const current = await readProgress(fs, context);
  const proposal: WorkflowProgressDocument = {
    ...current,
    revision: current.revision + 1,
    proposal: {
      targetRole: "tester",
      evidence,
      followUpApprovalText: approvalText
    }
  };
  await service.submitProgress(context, renderWorkflowProgress(proposal));
  const messageId = `message-${proposal.revision}`;
  await service.claimDispatch({
    ...context,
    routePath: routePath("tester"),
    targetRole: "tester",
    routeContentHash: `route-${proposal.revision}`,
    messageId
  });
  await service.confirmDispatch(context, messageId);
}

async function writeArchitectureDiagnosis(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  assessment: string,
  disposition: "analysis completed" | "diagnosis implementation completed" | "user clarification required" = "diagnosis implementation completed"
): Promise<void> {
  await writeFinalArtifact(
    fs,
    context,
    "architecture-diagnosis.md",
    renderArchitectureDiagnosisTemplate(context.taskSlug),
    [
      ["## Architecture Assessment\n\nTBD", `## Architecture Assessment\n\n${assessment}`],
      ["analysis completed|diagnosis implementation completed|user clarification required", disposition]
    ]
  );
}

async function writeArchitectDebug(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  rootCause: string,
  disposition: "local fix completed" | "normal architecture plan required" | "user clarification required" = "local fix completed"
): Promise<void> {
  await writeFinalArtifact(fs, context, "architect-debug.md", renderArchitectDebugTemplate(context.taskSlug), [
    ["Status: pending|completed", "Status: completed"],
    [
      "local fix completed|normal architecture plan required|user clarification required",
      disposition
    ],
    ["## Confirmed Root Cause\n\nTBD", `## Confirmed Root Cause\n\n${rootCause}`]
  ]);
}

async function writeTestReport(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  result: "pass" | "fail",
  infrastructure: "none" | "repair-required" | "repaired" | "production-change-required" = "none",
  evidence = `${result} validation evidence`
): Promise<void> {
  await writeFinalArtifact(fs, context, "test-report.md", renderTestReportTemplate(context.taskSlug), [
    ["Test Result: pass|fail|incomplete", `Test Result: ${result}`],
    ["L3 Required: yes|no", "L3 Required: no"],
    ["Status: none|repair-required|repaired|production-change-required", `Status: ${infrastructure}`],
    ["## Evidence Reviewed\n\nTBD", `## Evidence Reviewed\n\n${evidence}`]
  ]);
}

async function writeApprovedCoverageGapTestReport(
  fs: FileSystemAdapter,
  context: WorkflowControlContext
): Promise<void> {
  await writeFinalArtifact(fs, context, "test-report.md", renderTestReportTemplate(context.taskSlug), [
    ["Test Result: pass|fail|incomplete", "Test Result: fail"],
    ["L3 Required: yes|no", "L3 Required: no"],
    ["Status: none|repair-required|repaired|production-change-required", "Status: none"],
    ["## Evidence Reviewed\n\nTBD", "## Evidence Reviewed\n\nCompleted validation evidence for the accepted task."],
    ["## Coverage Gaps\n\nNone.", "## Coverage Gaps\n\nLive gateway coverage remains unavailable."],
    [
      "## Blocking Validation Issues\n\nNone.",
      "## Blocking Validation Issues\n\nThe approved live gateway coverage gap remains open."
    ],
    [
      "## User Approval Evidence\n\nNone.",
      "## User Approval Evidence\n\nUser explicitly approved retaining the live gateway coverage gap."
    ]
  ]);
}

async function writeArchitecturePlan(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  scope = "accepted implementation scope"
): Promise<void> {
  await writeFinalArtifact(fs, context, "architecture-plan.md", renderArchitecturePlanTemplate(context.taskSlug), [
    ["Planning Result: complete|incomplete|user clarification required", "Planning Result: complete"],
    ["## Accepted Scope\n\nTBD", `## Accepted Scope\n\n${scope}`]
  ]);
}

let codeDiffReviewCount = 0;

// Records a new code-diff Gate result while preserving the other gates and the
// recorded code source.
async function writeCodeDiffDecision(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  decision: "approve" | "request_changes",
  findingScopes: Array<"test-only" | "docs-only" | "implementation"> = []
): Promise<void> {
  codeDiffReviewCount += 1;
  const updatedAt = new Date(Date.parse("2026-08-07T00:00:00.000Z") + codeDiffReviewCount * 1000).toISOString();
  const indexPath = path.join(context.taskRepoRoot, ".ai/vcm/gate-reviews/index.json");
  const index = await fs.pathExists(indexPath)
    ? await fs.readJson<{ gates: Record<string, Record<string, unknown>> }>(indexPath)
    : { version: 1, enabled: true, activeGate: null, gates: {} };
  const existing = index.gates["code-diff"] ?? {};
  index.gates["code-diff"] = {
    ...existing,
    gate: "code-diff",
    required: true,
    status: "completed",
    decision,
    requestId: `request-code-diff-${updatedAt}`,
    inputHash: `input-code-diff-${updatedAt}`,
    codeDiffSource: existing.codeDiffSource ?? "coder",
    findings: findingScopes.map((scope, position) => ({ id: `F-${position + 1}`, scope })),
    reportPath: ".ai/vcm/gate-reviews/code-diff-review.md",
    completedAt: updatedAt,
    updatedAt
  };
  await fs.ensureDir(path.dirname(indexPath));
  await fs.writeJsonAtomic(indexPath, index);
}

// Records a code-diff request that failed to start with the given error.
async function writeCodeDiffStartFailure(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  error: string
): Promise<void> {
  codeDiffReviewCount += 1;
  const updatedAt = new Date(Date.parse("2026-08-07T00:00:00.000Z") + codeDiffReviewCount * 1000).toISOString();
  const indexPath = path.join(context.taskRepoRoot, ".ai/vcm/gate-reviews/index.json");
  const index = await fs.readJson<{ gates: Record<string, Record<string, unknown>> }>(indexPath);
  index.gates["code-diff"] = {
    ...index.gates["code-diff"],
    status: "failed",
    decision: undefined,
    error,
    codeDiffSource: "coder",
    completedAt: updatedAt,
    updatedAt
  };
  await fs.writeJsonAtomic(indexPath, index);
}

async function writeDocsUpdateReport(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  decision: "synced" | "unchanged",
  evidence: string
): Promise<void> {
  await writeFinalArtifact(fs, context, "docs-update-report.md", renderDocsUpdateReportTemplate(context.taskSlug), [
    ["synced|unchanged|blocked", decision],
    ["## Evidence Reviewed\n\nTBD", `## Evidence Reviewed\n\n${evidence}`]
  ]);
}

async function writeFinalAcceptance(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  decision: "accepted" | "accepted-with-known-risks" | "needs-coder-follow-up" | "needs-architect-follow-up" = "accepted"
): Promise<void> {
  await writeFinalArtifact(fs, context, "final-acceptance.md", renderFinalAcceptanceTemplate(context.taskSlug), [[
    "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|blocked-by-user-decision",
    decision
  ]]);
}

async function completeFlow(
  service: WorkflowControlService,
  fs: FileSystemAdapter,
  context: WorkflowControlContext
): Promise<void> {
  const current = await readProgress(fs, context);
  await service.submitProgress(context, renderWorkflowProgress({
    ...current,
    revision: current.revision + 1,
    status: "completed",
    proposal: undefined
  }));
}

async function enterCodeChangeTester(
  service: WorkflowControlService,
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  scope = "accepted implementation scope"
): Promise<void> {
  await advance(service, fs, context, "architect", "code-change", "accepted code change");
  await writeArchitecturePlan(fs, context, scope);
  await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:00:30.000Z");
  await advance(service, fs, context, "coder", undefined, "approved architecture plan");
  await writeFinalArtifact(fs, context, "coder-completion.md", renderCoderCompletionTemplate(context.taskSlug), [
    ["Decision: ready_for_review|incomplete|failed", "Decision: ready_for_review"]
  ]);
  await advance(service, fs, context, "tester", undefined, "completed Coder implementation");
}

// Passes Tester validation and both post-implementation Gates, leaving the
// flow waiting for Final Acceptance.
async function enterCodeChangeValidated(
  service: WorkflowControlService,
  fs: FileSystemAdapter,
  context: WorkflowControlContext
): Promise<void> {
  await enterCodeChangeTester(service, fs, context);
  await writeTestReport(fs, context, "pass");
  await writeGateIndex(fs, context, {
    architecture: "approve",
    validation: "approve",
    codeDiff: "approve",
    codeDiffSource: "coder"
  });
}

// Fails Code-Change validation, repairs it in the given branch, and passes the
// branch's Tester validation and both Gates.
async function enterCodeChangePassedBranch(
  service: WorkflowControlService,
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  branch: "architect-debug" | "architecture-diagnosis"
): Promise<void> {
  await enterCodeChangeTester(service, fs, context);
  await writeTestReport(fs, context, "fail");
  await advance(service, fs, context, "architect", "architect-debug", "repair failed validation");
  await writeArchitectDebug(fs, context, "confirmed repair root cause");
  await advance(service, fs, context, "tester", undefined, "validate Debug repair");
  if (branch === "architecture-diagnosis") {
    await writeTestReport(fs, context, "fail");
    await advance(service, fs, context, "architect", branch, "diagnose failed Debug repair");
    await writeArchitectureDiagnosis(fs, context, "diagnosis repair completed");
    await advance(service, fs, context, "tester", undefined, "validate Diagnosis repair");
  }
  await writeTestReport(fs, context, "pass");
  await writeGateIndex(fs, context, {
    validation: "approve",
    codeDiff: "approve",
    codeDiffSource: branch === "architect-debug" ? "architect-debug" : "architect-diagnosis"
  });
}

async function readProgress(fs: FileSystemAdapter, context: WorkflowControlContext): Promise<WorkflowProgressDocument> {
  const progressPath = path.join(context.taskRepoRoot, context.handoffDir, "workflow-progress.md");
  if (!(await fs.pathExists(progressPath))) {
    return {
      taskSlug: context.taskSlug,
      revision: 0,
      status: "not-started",
      history: []
    };
  }
  return parseWorkflowProgress(
    await fs.readText(progressPath),
    context.taskSlug
  );
}

async function writeFinalArtifact(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  fileName: string,
  template: string,
  replacements: Array<[string, string]>
): Promise<void> {
  const content = replacements.reduce(
    (current, [from, to]) => current.replace(from, to),
    fileName === "docs-update-report.md"
      ? template.replace("## Commit\n\nTBD", "## Commit\n\nabc1234")
      : template
  ).replaceAll("TBD", "Verified task evidence.");
  await fs.writeText(path.join(context.taskRepoRoot, context.handoffDir, fileName), content);
}

async function writeGateIndex(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  decisions: {
    architecture?: "approve" | "request_changes";
    validation?: "approve" | "request_changes";
    codeDiff?: "approve" | "request_changes";
    codeDiffSource?: "coder" | "architect-debug" | "architect-diagnosis";
  },
  updatedAt = "2026-08-06T00:00:00.000Z"
): Promise<void> {
  const record = (gate: string, decision?: "approve" | "request_changes", codeDiffSource?: string) => ({
    gate,
    required: true,
    status: decision ? "completed" : "pending",
    decision,
    requestId: decision ? `request-${gate}-${updatedAt}` : undefined,
    inputHash: decision ? `input-${gate}-${updatedAt}` : undefined,
    codeDiffSource,
    reportPath: `.ai/vcm/gate-reviews/${gate}-review.md`,
    promptPath: `.ai/vcm/gate-reviews/${gate}-prompt.md`,
    completedAt: decision ? updatedAt : undefined,
    updatedAt
  });
  const gateDir = path.join(context.taskRepoRoot, ".ai/vcm/gate-reviews");
  await fs.ensureDir(gateDir);
  await fs.writeJsonAtomic(path.join(gateDir, "index.json"), {
    version: 1,
    enabled: true,
    activeGate: null,
    gates: {
      "architecture-plan": record("architecture-plan", decisions.architecture),
      "validation-adequacy": record("validation-adequacy", decisions.validation),
      "code-diff": record("code-diff", decisions.codeDiff, decisions.codeDiff ? decisions.codeDiffSource ?? "coder" : undefined)
    },
    updatedAt
  });
}

async function writeGateStatus(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  gate: "architecture-plan" | "validation-adequacy" | "code-diff",
  status: "not_required" | "skipped" | "overridden",
  updatedAt: string
): Promise<void> {
  await writeGateIndex(fs, context, {}, updatedAt);
  const indexPath = path.join(context.taskRepoRoot, ".ai/vcm/gate-reviews/index.json");
  const index = await fs.readJson<Record<string, any>>(indexPath);
  index.gates[gate] = {
    ...index.gates[gate],
    status,
    decision: status === "overridden" ? "approve" : undefined,
    exceptionReason: status === "not_required" ? undefined : "explicit test exception",
    updatedAt
  };
  await fs.writeJsonAtomic(indexPath, index);
}

function failureInjectingFs(base: FileSystemAdapter): {
  fs: FileSystemAdapter;
  failNextJsonWrite(suffix: string): void;
} {
  let failureSuffix: string | undefined;
  return {
    fs: {
      ...base,
      async writeJsonAtomic(target, value) {
        if (failureSuffix && target.endsWith(failureSuffix)) {
          failureSuffix = undefined;
          throw new Error("injected workflow state write failure");
        }
        await base.writeJsonAtomic(target, value);
      }
    },
    failNextJsonWrite(suffix) {
      failureSuffix = suffix;
    }
  };
}

function historyEntry(
  sequence: number,
  targetRole: DispatchableRole,
  confirmedAt: string
): WorkflowProgressDocument["history"][number] {
  return {
    sequence,
    flow: "code-change",
    targetRole,
    evidence: `dispatch-${sequence}`,
    confirmedAt
  };
}

function sequenceClock() {
  let sequence = 0;
  return () => `2026-08-06T00:00:${String(sequence++).padStart(2, "0")}.000Z`;
}
