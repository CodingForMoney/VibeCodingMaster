import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
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
  renderDocsSyncReportTemplate,
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
    const service = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "override-1" });
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

  it("denies skipping directly to Coder and accepts only an exact one-time user override", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "override-1" });
    const deniedReason = "Transition code-change/coder is not legal after the confirmed Workflow Progress history.";
    const proposal = initialProposal("coder");

    await expect(service.submitProgress(context, renderWorkflowProgress(proposal))).rejects.toMatchObject({
      code: "WORKFLOW_TRANSITION_DENIED"
    });

    proposal.proposal = {
      ...proposal.proposal!,
      authorizationId: "request",
      authorizationQuote: "Allow Coder to start before Architect for this dispatch only.",
      violatedRule: deniedReason
    };
    await expect(service.submitProgress(context, renderWorkflowProgress(proposal))).rejects.toMatchObject({
      code: "WORKFLOW_OVERRIDE_PENDING"
    });
    await service.approveOverride(context, "override-1", proposal.proposal.authorizationQuote!);

    proposal.proposal.authorizationId = "override-1";
    await service.submitProgress(context, renderWorkflowProgress(proposal));
    await service.claimDispatch({
      ...context,
      routePath: routePath("coder"),
      targetRole: "coder",
      routeContentHash: "route-hash",
      messageId: "message-1"
    });
    await service.confirmDispatch(context, "message-1");

    expect((await service.getState(context)).overrideRequests).toEqual([
      expect.objectContaining({ id: "override-1", status: "consumed" })
    ]);
    await expect(service.assertRouteAuthorized({
      ...context,
      routePath: routePath("coder"),
      targetRole: "coder"
    })).rejects.toMatchObject({ code: "WORKFLOW_ROUTE_NOT_APPROVED" });
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
    await expect(fs.readText(progressPath)).resolves.toContain("Revision: 0");

    await fs.writeText(progressPath, "# broken workflow record\n");
    const state = await service.getState(context);
    expect(state.warnings[0]).toContain("Workflow Progress is invalid and was preserved unchanged");
    await expect(service.submitProgress(context, renderWorkflowProgress(initialProposal("architect")))).rejects.toMatchObject({
      code: "WORKFLOW_STATE_INVALID"
    });
    await expect(fs.readText(progressPath)).resolves.toBe("# broken workflow record\n");
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

  it("enforces the complete Code-Change path before accepting completion", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "code-change", "accepted task");
    await writeFinalArtifact(fs, context, "architecture-plan.md", renderArchitecturePlanTemplate(context.taskSlug), [
      ["Planning Result: complete|incomplete|user clarification required", "Planning Result: complete"]
    ]);
    await writeGateIndex(fs, context, { architecture: "approve" });

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

    await advance(service, fs, context, "architect", undefined, "passed validation and code-diff Gates");
    await writeFinalArtifact(fs, context, "docs-sync-report.md", renderDocsSyncReportTemplate(context.taskSlug), [
      ["synced|unchanged|blocked", "synced"]
    ]);
    await writeFinalArtifact(fs, context, "final-acceptance.md", renderFinalAcceptanceTemplate(context.taskSlug), [
      [
        "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision",
        "accepted"
      ]
    ]);

    const current = await readProgress(fs, context);
    await service.submitProgress(context, renderWorkflowProgress({
      ...current,
      revision: current.revision + 1,
      status: "completed",
      proposal: undefined
    }));

    const completed = await readProgress(fs, context);
    expect(completed.status).toBe("completed");
    expect(completed.history.map((entry) => entry.targetRole)).toEqual([
      "architect",
      "coder",
      "tester",
      "architect"
    ]);
  });

  it("resumes Architecture Diagnosis validation after one user-authorized repair without reusing stale evidence", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "override-1" });

    await advance(service, fs, context, "architect", "architecture-diagnosis", "accepted diagnosis task");
    await writeArchitectureDiagnosis(fs, context, "initial diagnosis");
    await advance(service, fs, context, "tester", undefined, "implemented diagnosis");
    await writeTestReport(fs, context, "fail");
    await writeGateIndex(fs, context, { validation: "request_changes" }, "2026-08-06T00:00:10.000Z");

    await expect(propose(service, fs, context, "architect", undefined, "repair after Tester failure"))
      .rejects.toMatchObject({
        code: "WORKFLOW_TRANSITION_DENIED",
        hint: expect.stringContaining("Architecture Diagnosis stopped after the current Tester failure")
      });

    await advanceWithOverride(
      service,
      fs,
      context,
      "architect",
      "repair after Tester failure",
      "Continue Architecture Diagnosis repair after the reported Tester failure."
    );

    await expect(propose(service, fs, context, "tester", undefined, "revalidate repair"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });

    await writeArchitectureDiagnosis(fs, context, "repaired diagnosis");
    const restored = createWorkflowControlService({ fs, now: sequenceClock(), id: () => "override-2" });
    await advance(restored, fs, context, "tester", undefined, "revalidate repaired diagnosis");
    await writeTestReport(fs, context, "pass");

    await expect(propose(restored, fs, context, "tester", undefined, "stale validation revision"))
      .rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });

    await writeGateIndex(fs, context, { validation: "request_changes" }, "2026-08-06T00:00:20.000Z");
    await advance(restored, fs, context, "tester", undefined, "current validation revision");

    expect((await readProgress(fs, context)).history.map((entry) => entry.targetRole)).toEqual([
      "architect",
      "tester",
      "architect",
      "tester",
      "tester"
    ]);
  });

  it("routes a failed Architect Debug validation through Diagnosis and back to Tester", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "architect-debug", "accepted debug task");
    await writeArchitectDebug(fs, context, "debug repair");
    await advance(service, fs, context, "tester", undefined, "validate debug repair");
    await writeTestReport(fs, context, "fail");

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

  it("distinguishes post-Gate Diagnosis docs sync from another implementation repair", async () => {
    const { context, fs } = await createContext(roots);
    const service = createWorkflowControlService({ fs, now: sequenceClock() });

    await advance(service, fs, context, "architect", "architecture-diagnosis", "accepted diagnosis task");
    await writeArchitectureDiagnosis(fs, context, "implemented diagnosis");
    await advance(service, fs, context, "tester", undefined, "validate diagnosis implementation");
    await writeTestReport(fs, context, "pass");
    await writeGateIndex(fs, context, {
      validation: "approve",
      codeDiff: "approve",
      codeDiffSource: "architect-diagnosis"
    });

    await advance(service, fs, context, "architect", undefined, "approved validation and code diff");
    await writeFinalArtifact(fs, context, "docs-sync-report.md", renderDocsSyncReportTemplate(context.taskSlug), [
      ["synced|unchanged|blocked", "synced"]
    ]);
    await writeFinalArtifact(fs, context, "final-acceptance.md", renderFinalAcceptanceTemplate(context.taskSlug), [[
      "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision",
      "accepted"
    ]]);

    const current = await readProgress(fs, context);
    await service.submitProgress(context, renderWorkflowProgress({
      ...current,
      revision: current.revision + 1,
      status: "completed",
      proposal: undefined
    }));

    expect((await readProgress(fs, context)).status).toBe("completed");
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

  it("rejects Docs-Only completion without a complete accepted Docs Sync Report", async () => {
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

    await fs.writeText(
      path.join(context.taskRepoRoot, context.handoffDir, "docs-sync-report.md"),
      "# Docs Sync Report\n\n## Decision\n\nsynced\n"
    );
    await expect(service.submitProgress(context, completion)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID"
    });

    await writeFinalArtifact(fs, context, "docs-sync-report.md", renderDocsSyncReportTemplate(context.taskSlug), [
      ["synced|unchanged|blocked", "blocked"]
    ]);
    await expect(service.submitProgress(context, completion)).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETION_INVALID"
    });
  });

  for (const decision of ["synced", "unchanged"] as const) {
    it(`completes Docs-Only Flow from a complete ${decision} Docs Sync Report`, async () => {
      const { context, fs } = await createContext(roots);
      const service = createWorkflowControlService({ fs, now: sequenceClock() });
      await advance(service, fs, context, "architect", "docs-only", "accepted docs task");
      await writeFinalArtifact(fs, context, "docs-sync-report.md", renderDocsSyncReportTemplate(context.taskSlug), [
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
    await writeFinalArtifact(fs, context, "docs-sync-report.md", renderDocsSyncReportTemplate(context.taskSlug), [
      ["synced|unchanged|blocked", "synced"]
    ]);
    await writeFinalArtifact(fs, context, "final-acceptance.md", renderFinalAcceptanceTemplate(context.taskSlug), [
      [
        "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision",
        "needs-architect-follow-up"
      ]
    ]);
    await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:00:04.000Z");

    const coderProposal: WorkflowProgressDocument = {
      ...(await readProgress(fs, context)),
      revision: 6,
      proposal: { targetRole: "coder", evidence: "revised architecture plan" }
    };
    await expect(service.submitProgress(context, renderWorkflowProgress(coderProposal))).rejects.toMatchObject({
      code: "WORKFLOW_TRANSITION_DENIED"
    });

    await writeGateIndex(fs, context, { architecture: "approve" }, "2026-08-06T00:00:06.000Z");
    await service.submitProgress(context, renderWorkflowProgress(coderProposal));
    expect((await service.getState(context)).pendingDispatch).toMatchObject({ targetRole: "coder" });
  });
});

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
  authorizationText: string
): Promise<void> {
  const current = await readProgress(fs, context);
  const effectiveFlow = current.flow!;
  const violatedRule = `Transition ${effectiveFlow}/${targetRole} is not legal after the confirmed Workflow Progress history.`;
  const proposal: WorkflowProgressDocument = {
    ...current,
    revision: current.revision + 1,
    proposal: {
      targetRole,
      evidence,
      authorizationId: "request",
      authorizationQuote: authorizationText,
      violatedRule
    }
  };
  await expect(service.submitProgress(context, renderWorkflowProgress(proposal))).rejects.toMatchObject({
    code: "WORKFLOW_OVERRIDE_PENDING"
  });
  await service.approveOverride(context, "override-1", authorizationText);
  proposal.proposal!.authorizationId = "override-1";
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

async function writeArchitectureDiagnosis(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  assessment: string
): Promise<void> {
  await writeFinalArtifact(
    fs,
    context,
    "architecture-diagnosis.md",
    renderArchitectureDiagnosisTemplate(context.taskSlug),
    [
      ["## Architecture Assessment\n\nTBD", `## Architecture Assessment\n\n${assessment}`],
      ["analysis completed|diagnosis implementation completed|user clarification required", "diagnosis implementation completed"]
    ]
  );
}

async function writeArchitectDebug(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  rootCause: string
): Promise<void> {
  await writeFinalArtifact(fs, context, "architect-debug.md", renderArchitectDebugTemplate(context.taskSlug), [
    ["Status: pending|completed", "Status: completed"],
    ["## Confirmed Root Cause\n\nTBD", `## Confirmed Root Cause\n\n${rootCause}`]
  ]);
}

async function writeTestReport(
  fs: FileSystemAdapter,
  context: WorkflowControlContext,
  result: "pass" | "fail"
): Promise<void> {
  await writeFinalArtifact(fs, context, "test-report.md", renderTestReportTemplate(context.taskSlug), [
    ["Test Result: pass|fail|incomplete", `Test Result: ${result}`],
    ["L3 Required: yes|no", "L3 Required: no"],
    ["Status: none|repair-required|repaired|production-change-required", "Status: none"]
  ]);
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
    template
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
