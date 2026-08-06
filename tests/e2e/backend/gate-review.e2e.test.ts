import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, git } from "./helpers/e2e-repo.js";
import {
  cancelGateReview,
  connectAndCreateTask,
  getGateState,
  requestGateReview,
  startRole,
  updateGateSettings,
  waitFor,
  writeCompleteArchitecturePlan,
  writeConfirmedArchitectureBrief,
  writeReadyCoderCompletion
} from "./helpers/e2e-actions.js";
import type { GateReviewGate } from "../../../src/shared/types/gate-review.js";
import type { MockClaudePromptContext } from "./helpers/mock-claude-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E Gate Review with mock Claude Code", () => {
  it("cancels the exact running request before a replacement review starts", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "cancel-gate-review");
    await startRole(env.app, task.taskSlug, "project-manager");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompleteArchitecturePlan(task.worktreePath, task.taskSlug, "Initial plan.");
    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": true,
      "validation-adequacy": false,
      "code-diff": false
    });

    let releaseFirstPrompt: (() => void) | undefined;
    let markFirstPromptStarted: (() => void) | undefined;
    const firstPromptStarted = new Promise<void>((resolve) => {
      markFirstPromptStarted = resolve;
    });
    const firstPromptRelease = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve;
    });
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      await ctx.userPromptSubmit();
      markFirstPromptStarted?.();
      await firstPromptRelease;
      const request = matchPromptField(ctx.prompt, "Request");
      const report = matchPromptField(ctx.prompt, "Report");
      if (request && report) {
        await ctx.writeAbsoluteFile(report, architectureReport(request, "Obsolete cancelled result."));
      }
    });

    const first = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(first.status).toBe("started");
    const firstRequestId = first.record.requestId!;
    await firstPromptStarted;
    const firstReviewerProcess = env.mockRuntime.getSessionByRole(task.taskSlug, "reviewer");
    expect(firstReviewerProcess).toBeDefined();

    const stillRunning = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(stillRunning).toMatchObject({
      status: "running",
      record: { requestId: firstRequestId }
    });
    const cancelled = await cancelGateReview(env.app, task.taskSlug, "architecture-plan", {
      requestId: firstRequestId,
      reason: "Replace obsolete inputs"
    });
    expect(cancelled.activeGate).toBeNull();
    expect(cancelled.gates["architecture-plan"].status).toBe("pending");
    const restartedReviewerProcess = env.mockRuntime.getSessionByRole(task.taskSlug, "reviewer");
    expect(restartedReviewerProcess?.pid).not.toBe(firstReviewerProcess?.pid);

    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", writeApproveGateReport);
    await fs.appendFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"),
      "\nReplacement: current plan.\n",
      "utf8"
    );
    const second = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(second.status).toBe("started");
    const secondRequestId = second.record.requestId!;
    expect(secondRequestId).not.toBe(firstRequestId);
    await waitForGate(env.app, task.taskSlug, "architecture-plan");

    releaseFirstPrompt?.();
    await env.mockRuntime.waitForIdle();
    const finalState = await getGateState(env.app, task.taskSlug);
    expect(finalState.gates["architecture-plan"]).toMatchObject({
      status: "completed",
      decision: "approve",
      requestId: secondRequestId
    });
    const stableReport = await fs.readFile(
      path.join(task.worktreePath, ".ai/vcm/gate-reviews/architecture-plan-review.md"),
      "utf8"
    );
    expect(stableReport).toContain(`Request: ${secondRequestId}`);
    expect(stableReport).not.toContain(`Request: ${firstRequestId}`);
    const firstRequest = JSON.parse(await fs.readFile(
      path.join(task.worktreePath, ".ai/vcm/gate-reviews/requests", `${firstRequestId}.json`),
      "utf8"
    ));
    expect(firstRequest).toMatchObject({
      status: "cancelled",
      cancelReason: "Replace obsolete inputs"
    });
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    expect(pmSession).toBeDefined();
    expect(env.mockRuntime.getWrites(pmSession!.id)
      .filter((value) => value.includes("[VCM GATE REVIEW CALLBACK]"))).toHaveLength(1);
  });

  it("reviews only ready gate inputs and skips unchanged approved inputs", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-gates");
    const disabledArchitecture = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(disabledArchitecture.status).toBe("disabled");

    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": true,
      "validation-adequacy": true,
      "code-diff": true
    });
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", writeApproveGateReport, { once: false });

    const unconfirmedArchitecture = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(unconfirmedArchitecture.status).toBe("failed_to_start");
    expect(unconfirmedArchitecture.message).toContain("architecture-brief.md is not confirmed");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);

    const evidencePath = path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-evidence.md");
    const completeEvidence = await fs.readFile(evidencePath, "utf8");
    await fs.rm(evidencePath);
    const missingEvidenceArchitecture = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(missingEvidenceArchitecture.status).toBe("failed_to_start");
    expect(missingEvidenceArchitecture.message).toContain("architecture-evidence.md is incomplete");
    expect(missingEvidenceArchitecture.message).toContain("Artifact is missing");
    await fs.writeFile(evidencePath, completeEvidence, "utf8");

    await fs.writeFile(path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"), "", "utf8");
    const emptyArchitecture = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(emptyArchitecture.status).toBe("not_required");
    expect(emptyArchitecture.message).toContain(".ai/vcm/handoffs/architecture-plan.md is empty");

    await writeCompleteArchitecturePlan(task.worktreePath, task.taskSlug, "Gate E2E plan.");
    const architectureStarted = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(architectureStarted.status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "architecture-plan");
    const architectureApproved = await getGateState(env.app, task.taskSlug);
    const firstArchitectureHash = architectureApproved.gates["architecture-plan"].inputHash;
    expect(architectureApproved.gates["architecture-plan"]).toMatchObject({
      status: "completed",
      decision: "approve"
    });

    const unchangedArchitecture = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(unchangedArchitecture.status).toBe("already_approved");
    expect(unchangedArchitecture.record.inputHash).toBe(firstArchitectureHash);

    const briefPath = path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-brief.md");
    const revisedBrief = (await fs.readFile(briefPath, "utf8"))
      .replace("Use the behavior stated by the test task.", "Use the revised behavior confirmed by the test task.");
    await fs.writeFile(briefPath, revisedBrief, "utf8");
    const changedBriefArchitecture = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(changedBriefArchitecture.status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "architecture-plan");
    const architectureAfterBriefChange = await getGateState(env.app, task.taskSlug);
    expect(architectureAfterBriefChange.gates["architecture-plan"].inputHash).not.toBe(firstArchitectureHash);

    await fs.appendFile(evidencePath, "\nVerified Behavior: revised evidence.\n", "utf8");
    const changedEvidenceArchitecture = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(changedEvidenceArchitecture.status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "architecture-plan");
    const architectureAfterEvidenceChange = await getGateState(env.app, task.taskSlug);
    expect(architectureAfterEvidenceChange.gates["architecture-plan"].inputHash)
      .not.toBe(architectureAfterBriefChange.gates["architecture-plan"].inputHash);

    await fs.appendFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"),
      "\nImplementation Plan: revised.\n",
      "utf8"
    );
    const changedArchitecture = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(changedArchitecture.status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "architecture-plan");
    const architectureAfterChange = await getGateState(env.app, task.taskSlug);
    expect(architectureAfterChange.gates["architecture-plan"].inputHash).not.toBe(firstArchitectureHash);

    await fs.writeFile(path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md"), "", "utf8");
    const emptyValidation = await requestGateReview(env.app, task.taskSlug, "validation-adequacy");
    expect(emptyValidation.status).toBe("not_required");
    expect(emptyValidation.message).toContain(".ai/vcm/handoffs/test-report.md is empty");

    await fs.writeFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md"),
      incompleteTestReport(),
      "utf8"
    );
    const incompleteValidation = await requestGateReview(env.app, task.taskSlug, "validation-adequacy");
    expect(incompleteValidation.status).toBe("failed_to_start");
    expect(incompleteValidation.message).toContain(
      ".ai/vcm/handoffs/test-report.md is incomplete and cannot start validation-adequacy review"
    );

    await fs.writeFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md"),
      validTestReport(),
      "utf8"
    );
    const validationStarted = await requestGateReview(env.app, task.taskSlug, "validation-adequacy");
    expect(validationStarted.status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "validation-adequacy");
    const validationApproved = await getGateState(env.app, task.taskSlug);
    expect(validationApproved.gates["validation-adequacy"]).toMatchObject({
      status: "completed",
      decision: "approve"
    });

    await writeReadyCoderCompletion(task.worktreePath, task.taskSlug);
    const noCodeDiff = await requestGateReview(env.app, task.taskSlug, "code-diff", { codeDiffSource: "coder" });
    expect(noCodeDiff.status).toBe("not_required");
    expect(noCodeDiff.message).toBe("No new commits to review.");

    await fs.writeFile(path.join(task.worktreePath, "feature.txt"), "hello gate diff\n", "utf8");
    await git(task.worktreePath, "add", "feature.txt");
    await git(task.worktreePath, "commit", "-m", "implement feature");
    const staleCodeDiff = await requestGateReview(env.app, task.taskSlug, "code-diff", { codeDiffSource: "coder" });
    expect(staleCodeDiff.status).toBe("failed_to_start");
    expect(staleCodeDiff.message).toContain("current validation-adequacy approval");

    expect((await requestGateReview(env.app, task.taskSlug, "validation-adequacy")).status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "validation-adequacy");
    const codeDiffStarted = await requestGateReview(env.app, task.taskSlug, "code-diff", { codeDiffSource: "coder" });
    expect(codeDiffStarted.status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "code-diff");
    const codeDiffApproved = await getGateState(env.app, task.taskSlug);
    expect(codeDiffApproved.gates["code-diff"]).toMatchObject({
      status: "completed",
      decision: "approve",
      codeDiffSource: "coder"
    });
    expect(codeDiffApproved.gates["code-diff"].changedFiles).toContain("feature.txt");
  }, 10_000);

  it("blocks unresolved Tester-owned infrastructure repair and accepts repaired evidence", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "test-infrastructure-repair");

    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": false,
      "validation-adequacy": true,
      "code-diff": false
    });
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", writeApproveGateReport, { once: false });

    const reportPath = path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md");
    await fs.writeFile(reportPath, testInfrastructureReport("repair-required", "None."), "utf8");
    const unresolved = await requestGateReview(env.app, task.taskSlug, "validation-adequacy");
    expect(unresolved.status).toBe("failed_to_start");
    expect(unresolved.message).toContain("Route Tester repair first");

    const fixturePath = path.join(task.worktreePath, "tests/fixtures/feature.json");
    await fs.mkdir(path.dirname(fixturePath), { recursive: true });
    await fs.writeFile(fixturePath, '{"enabled":true}\n', "utf8");
    await git(task.worktreePath, "add", "tests/fixtures/feature.json");
    await git(task.worktreePath, "commit", "-m", "repair feature fixture");
    const repairCommit = (await git(task.worktreePath, "rev-parse", "HEAD")).stdout.trim();
    await fs.writeFile(reportPath, testInfrastructureReport("repaired", repairCommit), "utf8");

    const started = await requestGateReview(env.app, task.taskSlug, "validation-adequacy");
    expect(started.status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "validation-adequacy");
    expect((await getGateState(env.app, task.taskSlug)).gates["validation-adequacy"]).toMatchObject({
      status: "completed",
      decision: "approve"
    });
  });

  it("retains every Gate Review report and publishes only the latest report to the stable path", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "gate-report-history");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompleteArchitecturePlan(task.worktreePath, task.taskSlug, "Initial plan.");
    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": true,
      "validation-adequacy": false,
      "code-diff": false
    });

    const decisions: Array<"approve" | "request_changes"> = ["request_changes", "approve"];
    let round = 0;
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      round += 1;
      await writeArchitectureRoundReport(ctx, decisions.shift() ?? "approve", round);
    }, { once: false });

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "architecture-plan");
    const firstState = await getGateState(env.app, task.taskSlug);
    const firstRequestId = firstState.gates["architecture-plan"].requestId;
    expect(firstState.gates["architecture-plan"].decision).toBe("request_changes");

    await fs.appendFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"),
      "\nRevision: explicit ownership.\n",
      "utf8"
    );
    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "architecture-plan");
    const secondState = await getGateState(env.app, task.taskSlug);
    const secondRequestId = secondState.gates["architecture-plan"].requestId;
    expect(secondState.gates["architecture-plan"].decision).toBe("approve");
    expect(secondRequestId).not.toBe(firstRequestId);

    const requestDir = path.join(task.worktreePath, ".ai/vcm/gate-reviews/requests");
    const firstReportPath = path.join(requestDir, `${firstRequestId}.report.md`);
    const secondReportPath = path.join(requestDir, `${secondRequestId}.report.md`);
    expect(await fs.readFile(firstReportPath, "utf8")).toContain("Summary: Round 1 needs revision.");
    const secondReport = await fs.readFile(secondReportPath, "utf8");
    expect(secondReport).toContain("Summary: Round 2 approved.");
    expect(await fs.readFile(
      path.join(task.worktreePath, ".ai/vcm/gate-reviews/architecture-plan-review.md"),
      "utf8"
    )).toBe(secondReport);

    const firstRequest = JSON.parse(await fs.readFile(
      path.join(requestDir, `${firstRequestId}.json`),
      "utf8"
    ));
    const secondRequest = JSON.parse(await fs.readFile(
      path.join(requestDir, `${secondRequestId}.json`),
      "utf8"
    ));
    expect(firstRequest).toMatchObject({
      decision: "request_changes",
      summary: "Round 1 needs revision.",
      reportPath: `.ai/vcm/gate-reviews/requests/${firstRequestId}.report.md`,
      latestReportPath: ".ai/vcm/gate-reviews/architecture-plan-review.md"
    });
    expect(firstRequest.findings).toHaveLength(1);
    expect(secondRequest).toMatchObject({
      decision: "approve",
      summary: "Round 2 approved.",
      reportPath: `.ai/vcm/gate-reviews/requests/${secondRequestId}.report.md`,
      latestReportPath: ".ai/vcm/gate-reviews/architecture-plan-review.md",
      findings: []
    });
  });

  it("blocks unapproved coverage gaps and reviews an exact user-approved failed result", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "approved-test-gap");

    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": false,
      "validation-adequacy": true,
      "code-diff": false
    });
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", writeApproveGateReport, { once: false });

    const reportPath = path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md");
    await fs.writeFile(reportPath, approvedGapTestReport("None."), "utf8");

    const unapproved = await requestGateReview(env.app, task.taskSlug, "validation-adequacy");
    expect(unapproved.status).toBe("failed_to_start");
    expect(unapproved.message).toContain("User Approval Evidence is required");

    await fs.writeFile(
      reportPath,
      approvedGapTestReport("User approved retaining the live gateway coverage gap."),
      "utf8"
    );
    const started = await requestGateReview(env.app, task.taskSlug, "validation-adequacy");
    expect(started.status).toBe("started");
    await waitForGate(env.app, task.taskSlug, "validation-adequacy");

    const state = await getGateState(env.app, task.taskSlug);
    expect(state.gates["validation-adequacy"]).toMatchObject({
      status: "completed",
      decision: "approve"
    });
  });
});

async function writeApproveGateReport(ctx: MockClaudePromptContext): Promise<void> {
  await ctx.userPromptSubmit();
  const gate = matchPromptField(ctx.prompt, "Gate") as GateReviewGate;
  const request = matchPromptField(ctx.prompt, "Request");
  const report = matchPromptField(ctx.prompt, "Report");
  if (!gate || !request || !report) {
    throw new Error(`Unable to parse gate prompt:\n${ctx.prompt}`);
  }
  await ctx.writeOutput(`Gate ${gate} approved\n`);
  const architectureAnalysis = gate === "architecture-plan"
    ? [
        "## Architecture Analysis",
        "",
        "- Evidence Read: architecture plan, current source, and callers",
        "- Architecture Brief Fit: confirmed decisions are preserved",
        "- End-To-End Flow: entry to owner to completion",
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
        "## Findings",
        "",
        "None.",
        ""
      ]
    : [];
  const validationAnalysis = gate === "validation-adequacy"
    ? validationAnalysisLines()
    : [];
  const codeDiffAnalysis = gate === "code-diff"
    ? codeDiffAnalysisLines()
    : [];
  await ctx.writeAbsoluteFile(report, [
    `Gate: ${gate}`,
    `Request: ${request}`,
    "Decision: approve",
    `Summary: ${gate} inputs are acceptable for this E2E scenario.`,
    "",
    ...architectureAnalysis,
    ...validationAnalysis,
    ...codeDiffAnalysis
  ].join("\n"));
  await ctx.stop();
}

function architectureReport(requestId: string, summary: string): string {
  return [
    "Gate: architecture-plan",
    `Request: ${requestId}`,
    "Decision: approve",
    `Summary: ${summary}`,
    "",
    "## Architecture Analysis",
    "",
    "- Evidence Read: architecture plan, current source, and callers",
    "- Architecture Brief Fit: confirmed decisions are preserved",
    "- End-To-End Flow: entry to owner to completion",
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
    "## Findings",
    "",
    "None.",
    ""
  ].join("\n");
}

async function writeArchitectureRoundReport(
  ctx: MockClaudePromptContext,
  decision: "approve" | "request_changes",
  round: number
): Promise<void> {
  await ctx.userPromptSubmit();
  const request = matchPromptField(ctx.prompt, "Request");
  const report = matchPromptField(ctx.prompt, "Report");
  if (!request || !report) {
    throw new Error(`Unable to parse gate prompt:\n${ctx.prompt}`);
  }
  const findings = decision === "request_changes"
    ? [
        "## Findings",
        "",
        "### high: Ownership is incomplete",
        "- Evidence: the initial plan omits the state owner",
        "- Expected: one state owner",
        "- Gap: ownership is ambiguous",
        "- Risk: duplicate state"
      ]
    : ["## Findings", "", "None."];
  await ctx.writeAbsoluteFile(report, [
    "Gate: architecture-plan",
    `Request: ${request}`,
    `Decision: ${decision}`,
    `Summary: Round ${round} ${decision === "approve" ? "approved." : "needs revision."}`,
    "",
    "## Architecture Analysis",
    "",
    "- Evidence Read: architecture plan, current source, and callers",
    "- Architecture Brief Fit: confirmed decisions are preserved",
    "- End-To-End Flow: entry to owner to completion",
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

function validTestReport(): string {
  return [
    "# Test Report",
    "",
    "Test Result: pass",
    "",
    "## Evidence Reviewed",
    "src/feature.txt and the mock feature test.",
    "",
    "## Tests Added Or Updated",
    "Mock feature integration case.",
    "",
    "## Coverage Mapping",
    "Feature behavior -> L2 -> mock feature integration case -> public path -> pass.",
    "",
    "## Validation Progress",
    "",
    "### Completed Validation",
    "L0, L1, and L2 completed.",
    "",
    "### Remaining Validation",
    "None.",
    "",
    "## L3 Coverage",
    "",
    "L3 Required: no",
    "",
    "### Trigger Assessment",
    "No mandatory L3 trigger applies.",
    "",
    "### Affected End-To-End Flows",
    "None.",
    "",
    "### L3 Commands And Evidence",
    "None.",
    "",
    "### Not-Required Evidence",
    "The fixture changes no externally observable end-to-end behavior, documented L3 path, lifecycle, external contract, or critical invariant; L2 completely proves it.",
    "",
    "## Commands Run Or Checked",
    "Mock integration check: pass.",
    "",
    "## Validation Results",
    "Pass.",
    "",
    "## Test Infrastructure",
    "",
    "Status: none",
    "",
    "### Affected Files",
    "None.",
    "",
    "### Boundary Evidence",
    "None.",
    "",
    "### Defect-Class Sweep",
    "None.",
    "",
    "### Repair Commit",
    "None.",
    "",
    "## Failed Expectations",
    "None.",
    "",
    "## Reproduction Steps",
    "None.",
    "",
    "## Skipped Checks With Reasons",
    "None.",
    "",
    "## Coverage Gaps",
    "None.",
    "",
    "## Blocking Validation Issues",
    "None.",
    "",
    "## User Approval Evidence",
    "None.",
    ""
  ].join("\n");
}

function approvedGapTestReport(userApproval: string): string {
  return validTestReport()
    .replace("Test Result: pass", "Test Result: fail")
    .replace("## Coverage Gaps\nNone.", "## Coverage Gaps\nMissing live gateway coverage.")
    .replace(
      "## Blocking Validation Issues\nNone.",
      "## Blocking Validation Issues\nLive gateway validation remains unavailable."
    )
    .replace("## User Approval Evidence\nNone.", `## User Approval Evidence\n${userApproval}`);
}

function incompleteTestReport(): string {
  return validTestReport()
    .replace("Test Result: pass", "Test Result: incomplete")
    .replace(
      "### Remaining Validation\nNone.",
      "### Remaining Validation\nRun the remaining L2 integration matrix."
    );
}

function testInfrastructureReport(
  status: "repair-required" | "repaired",
  repairCommit: string
): string {
  return validTestReport()
    .replace("Test Result: pass", `Test Result: ${status === "repaired" ? "pass" : "fail"}`)
    .replace("Status: none", `Status: ${status}`)
    .replace("### Affected Files\nNone.", "### Affected Files\ntests/fixtures/feature.json")
    .replace(
      "### Boundary Evidence\nNone.",
      "### Boundary Evidence\nThe defect is confined to a tracked fixture and requires no production change."
    )
    .replace(
      "### Defect-Class Sweep\nNone.",
      "### Defect-Class Sweep\nChecked every feature fixture for the same missing enabled field."
    )
    .replace("### Repair Commit\nNone.", `### Repair Commit\n${repairCommit}`)
    .replace(
      "## Failed Expectations\nNone.",
      `## Failed Expectations\n${status === "repaired" ? "None." : "The feature fixture omits the required enabled field."}`
    )
    .replace(
      "## Blocking Validation Issues\nNone.",
      `## Blocking Validation Issues\n${status === "repaired" ? "None." : "The feature fixture cannot validate the enabled path."}`
    );
}

function validationAnalysisLines(): string[] {
  return [
    "## Validation Analysis",
    "",
    "- Evidence Read: test report, feature entry point, and integration case",
    "- Changed Behavior And Risk: feature behavior and integration risk",
    "- Coverage Mapping: feature mapped to the integration case",
    "- Baseline Coverage: baseline evidence inspected",
    "- L2 Integration Coverage: integration path covered",
    "- L3 Trigger Assessment: no mandatory L3 trigger",
    "- L3 End-To-End Coverage: not required",
    "- Boundary And Failure Coverage: relevant boundary covered",
    "- Public Contract Coverage: public behavior asserted",
    "- Test Integrity: real path and observable assertion inspected",
    "- Test Infrastructure: no unresolved test-infrastructure defect",
    "- Skips And Gaps: none",
    "- User Approval And Gap Disposition: none",
    "- Validation Readiness: ready",
    "",
    "## Findings",
    "",
    "None.",
    ""
  ];
}

function codeDiffAnalysisLines(): string[] {
  return [
    "## Code Diff Analysis",
    "",
    "- Commit Range And Sources: current coder commit range",
    "- Evidence Read: source evidence, changed file, and diff",
    "- Changed Files And Symbols: feature.txt content",
    "- Changed Behavior: mock feature artifact inspected",
    "- Source Evidence Fit: implementation matches source evidence",
    "- Callers And Public Surface: no callable surface change",
    "- State Lifecycle And Failure Paths: no state lifecycle change",
    "- Coding Standards: applicable standards inspected",
    "- Baseline Test Integrity: no weakened test behavior",
    "- Generated Context And Durable Docs: no generated or durable impact",
    "- Code Readiness: ready",
    "",
    "## Findings",
    "",
    "None.",
    ""
  ];
}

function matchPromptField(prompt: string, field: string): string | undefined {
  return prompt.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

async function waitForGate(app: Parameters<typeof getGateState>[0], taskSlug: string, gate: GateReviewGate): Promise<void> {
  await waitFor(async () => {
    const state = await getGateState(app, taskSlug);
    expect(state.gates[gate].status).toBe("completed");
  }, 2_000);
}
