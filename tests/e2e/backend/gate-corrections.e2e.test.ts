import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderWorkflowProgress } from "../../../src/backend/services/workflow-control-service.js";
import { renderTestReportTemplate } from "../../../src/backend/templates/handoff.js";
import type {
  GateReviewDecision,
  GateReviewGate,
  GateReviewIndex
} from "../../../src/shared/types/gate-review.js";
import {
  connectAndCreateTask,
  getGateState,
  requestGateReview,
  startRole,
  updateGateSettings,
  waitFor,
  writeCompleteArchitecturePlan,
  writeCompletedArchitectDebug,
  writeConfirmedArchitectureBrief,
  writeReadyCoderCompletion
} from "./helpers/e2e-actions.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, git } from "./helpers/e2e-repo.js";
import type { MockClaudePromptContext } from "./helpers/mock-claude-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E Gate Review correction loops", () => {
  it("re-reviews a revised architecture plan after request_changes", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-architecture-correction");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await updateGateSettings(env.app, task.taskSlug, { "architecture-plan": true });
    await startRole(env.app, task.taskSlug, "project-manager");
    registerPmGateCallback(env, "architecture-plan");

    let reviewCount = 0;
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      reviewCount += 1;
      await writeGateReport(ctx, reviewCount === 1 ? "request_changes" : "approve");
    }, { once: false });

    const planPath = path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md");
    await writeCompleteArchitecturePlan(task.worktreePath, task.taskSlug, "Initial notification delivery plan.");

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    const rejected = await waitForGateDecision(env.app, task.taskSlug, "architecture-plan", "request_changes");
    const rejectedHash = rejected.gates["architecture-plan"].inputHash;
    expect(rejected.gates["architecture-plan"].callbackStatus).toBe("sent");

    await fs.appendFile(planPath, [
      "",
      "Implementation Plan: backend owns delivery state and completion events.",
      "Failure Model: retries preserve one durable delivery identity.",
      ""
    ].join("\n"), "utf8");

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    const approved = await waitForGateDecision(env.app, task.taskSlug, "architecture-plan", "approve");
    expect(approved.gates["architecture-plan"].inputHash).not.toBe(rejectedHash);
    expect(approved.gates["architecture-plan"].callbackStatus).toBe("sent");
    expect(reviewCount).toBe(2);
  });

  it("retains the coder source and original base when Architect fixes a rejected code diff", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-code-correction");
    await updateGateSettings(env.app, task.taskSlug, { "code-diff": true });
    await startRole(env.app, task.taskSlug, "project-manager");
    registerPmGateCallback(env, "code-diff");

    let reviewCount = 0;
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      reviewCount += 1;
      await writeGateReport(ctx, reviewCount === 1 ? "request_changes" : "approve");
    }, { once: false });

    await writeReadyCoderCompletion(task.worktreePath, task.taskSlug);
    await fs.writeFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md"),
      validTestReport(task.taskSlug, "Feature behavior -> L2 -> current implementation -> pass."),
      "utf8"
    );
    await fs.writeFile(path.join(task.worktreePath, "feature.txt"), "surface workaround\n", "utf8");
    await git(task.worktreePath, "add", "feature.txt");
    await git(task.worktreePath, "commit", "-m", "implement feature");

    expect((await requestGateReview(env.app, task.taskSlug, "code-diff", {
      codeDiffSource: "coder"
    })).status).toBe("started");
    const rejected = await waitForGateDecision(env.app, task.taskSlug, "code-diff", "request_changes");
    const originalBase = rejected.gates["code-diff"].baseCommit;
    expect(rejected.gates["code-diff"].codeDiffSources).toEqual(["coder"]);

    await writeCompletedArchitectDebug(task.worktreePath, task.taskSlug);
    await fs.writeFile(path.join(task.worktreePath, "feature.txt"), "durable write before completion\n", "utf8");
    await git(task.worktreePath, "add", "feature.txt");
    await git(task.worktreePath, "commit", "-m", "fix delivery completion ordering");

    expect((await requestGateReview(env.app, task.taskSlug, "code-diff", {
      codeDiffSource: "architect-debug"
    })).status).toBe("started");
    const approved = await waitForGateDecision(env.app, task.taskSlug, "code-diff", "approve");
    const record = approved.gates["code-diff"];
    expect(record.baseCommit).toBe(originalBase);
    expect(record.codeDiffSources).toEqual(["coder", "architect-debug"]);
    expect(record.commits).toHaveLength(2);
    expect(record.changedFiles).toEqual(["feature.txt"]);

    const reviewer = env.mockRuntime.getSessionByRole(task.taskSlug, "reviewer");
    expect(reviewer).toBeDefined();
    const prompts = env.mockRuntime.getWrites(reviewer!.id).filter((write) => write.includes("[VCM GATE REVIEW]"));
    expect(prompts.at(-1)).toContain("Code sources: coder -> architect-debug");
    expect(prompts.at(-1)).toContain(".ai/vcm/handoffs/coder-completion.md");
    expect(prompts.at(-1)).toContain(".ai/vcm/handoffs/architect-debug.md");
  });

  it("reconstructs coder and Architect Debug sources before the first code-diff review", async () => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-pre-gate-debug");
    await updateGateSettings(env.app, task.taskSlug, { "code-diff": true });
    await startRole(env.app, task.taskSlug, "project-manager");
    registerPmGateCallback(env, "code-diff");

    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      await writeGateReport(ctx, "approve");
    });

    await writeCompleteArchitecturePlan(task.worktreePath, task.taskSlug, "Initial delivery plan.");
    await writeReadyCoderCompletion(task.worktreePath, task.taskSlug);
    await writeCompletedArchitectDebug(task.worktreePath, task.taskSlug);
    await fs.writeFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md"),
      validTestReport(task.taskSlug, "Regression behavior -> L2 -> repaired implementation -> pass."),
      "utf8"
    );

    const testPath = path.join(task.worktreePath, "tests/feature.test.ts");
    await fs.mkdir(path.dirname(testPath), { recursive: true });
    await fs.writeFile(path.join(task.worktreePath, "feature.txt"), "incomplete behavior\n", "utf8");
    await fs.writeFile(testPath, "expect(runFeature()).toBeDefined();\n", "utf8");
    await git(task.worktreePath, "add", "feature.txt", "tests/feature.test.ts");
    await git(task.worktreePath, "commit", "-m", "implement feature");

    await fs.writeFile(path.join(task.worktreePath, "feature.txt"), "correct boundary behavior\n", "utf8");
    await fs.writeFile(testPath, "expect(runFeature()).toBe('correct boundary behavior');\n", "utf8");
    await git(task.worktreePath, "add", "feature.txt", "tests/feature.test.ts");
    await git(task.worktreePath, "commit", "-m", "repair feature boundary");

    const timestamp = "2026-08-09T00:00:00.000Z";
    const workflowProgress = renderWorkflowProgress({
      taskSlug: task.taskSlug,
      revision: 5,
      flow: "architect-debug",
      status: "active",
      history: [
        workflowHistory(1, "code-change", "architect", timestamp),
        workflowHistory(2, "code-change", "coder", timestamp),
        workflowHistory(3, "code-change", "tester", timestamp),
        workflowHistory(4, "architect-debug", "architect", timestamp),
        workflowHistory(5, "architect-debug", "tester", timestamp)
      ]
    });
    await fs.writeFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/workflow-progress.md"),
      workflowProgress,
      "utf8"
    );

    expect((await requestGateReview(env.app, task.taskSlug, "code-diff", {
      codeDiffSource: "architect-debug"
    })).status).toBe("started");
    const approved = await waitForGateDecision(env.app, task.taskSlug, "code-diff", "approve");
    expect(approved.gates["code-diff"].codeDiffSources).toEqual(["coder", "architect-debug"]);
    expect(approved.gates["code-diff"].commits).toHaveLength(2);
    expect(approved.gates["code-diff"].changedFiles).toEqual(["feature.txt", "tests/feature.test.ts"]);

    const reviewer = env.mockRuntime.getSessionByRole(task.taskSlug, "reviewer");
    const prompt = env.mockRuntime.getWrites(reviewer!.id).find((write) => write.includes("[VCM GATE REVIEW]"));
    expect(prompt).toContain("Code sources: coder -> architect-debug");
    expect(prompt).toContain(".ai/vcm/handoffs/architecture-plan.md");
    expect(prompt).toContain(".ai/vcm/handoffs/coder-completion.md");
    expect(prompt).toContain(".ai/vcm/handoffs/architect-debug.md");
    expect(prompt).toContain("tests/feature.test.ts");
  });

  it("keeps a standalone Architect Debug review separate from earlier flow history", async () => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-standalone-debug");
    await updateGateSettings(env.app, task.taskSlug, { "code-diff": true });
    await startRole(env.app, task.taskSlug, "project-manager");
    registerPmGateCallback(env, "code-diff");

    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      await writeGateReport(ctx, "approve");
    });

    await writeCompletedArchitectDebug(task.worktreePath, task.taskSlug);
    await fs.writeFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md"),
      validTestReport(task.taskSlug, "Standalone repair behavior -> L2 -> repaired implementation -> pass."),
      "utf8"
    );
    await fs.writeFile(path.join(task.worktreePath, "feature.txt"), "standalone debug repair\n", "utf8");
    await git(task.worktreePath, "add", "feature.txt");
    await git(task.worktreePath, "commit", "-m", "repair standalone feature");

    const timestamp = "2026-08-09T01:00:00.000Z";
    await fs.writeFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/workflow-progress.md"),
      renderWorkflowProgress({
        taskSlug: task.taskSlug,
        revision: 2,
        flow: "architect-debug",
        status: "active",
        history: [
          workflowHistory(1, "code-change", "coder", timestamp),
          workflowHistory(2, "architect-debug", "architect", timestamp)
        ]
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(task.worktreePath, ".ai/vcm/workflow-control.json"),
      JSON.stringify({
        version: 1,
        taskSlug: task.taskSlug,
        awaitingUser: null,
        pendingDispatch: null,
        activeDispatch: null,
        flowRun: {
          rootFlow: "architect-debug",
          startedAtSequence: 2
        },
        userAuthorizations: [],
        warnings: [],
        updatedAt: timestamp
      }, null, 2) + "\n",
      "utf8"
    );

    expect((await requestGateReview(env.app, task.taskSlug, "code-diff", {
      codeDiffSource: "architect-debug"
    })).status).toBe("started");
    const approved = await waitForGateDecision(env.app, task.taskSlug, "code-diff", "approve");
    expect(approved.gates["code-diff"].codeDiffSources).toEqual(["architect-debug"]);

    const reviewer = env.mockRuntime.getSessionByRole(task.taskSlug, "reviewer");
    const prompt = env.mockRuntime.getWrites(reviewer!.id).find((write) => write.includes("[VCM GATE REVIEW]"));
    expect(prompt).toContain("Code sources: architect-debug");
    expect(prompt).toContain(".ai/vcm/handoffs/architect-debug.md");
    expect(prompt).not.toContain(".ai/vcm/handoffs/coder-completion.md");
  });

  it("re-reviews revised Tester evidence and does not create Final Acceptance while rejected", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-validation-correction");
    await updateGateSettings(env.app, task.taskSlug, { "validation-adequacy": true });
    await startRole(env.app, task.taskSlug, "project-manager");
    registerPmGateCallback(env, "validation-adequacy");

    let reviewCount = 0;
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      reviewCount += 1;
      await writeGateReport(ctx, reviewCount === 1 ? "request_changes" : "approve");
    }, { once: false });

    const reportPath = path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md");
    await fs.writeFile(reportPath, validTestReport(task.taskSlug, "Only baseline behavior covered."), "utf8");

    expect((await requestGateReview(env.app, task.taskSlug, "validation-adequacy")).status).toBe("started");
    const rejected = await waitForGateDecision(env.app, task.taskSlug, "validation-adequacy", "request_changes");
    const rejectedHash = rejected.gates["validation-adequacy"].inputHash;
    const finalAcceptance = await fs.readFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/final-acceptance.md"),
      "utf8"
    );
    expect(finalAcceptance).not.toMatch(/^accepted$/m);

    await fs.writeFile(
      reportPath,
      validTestReport(task.taskSlug, "Integration and E2E behavior, retry, and recovery paths covered."),
      "utf8"
    );
    expect((await requestGateReview(env.app, task.taskSlug, "validation-adequacy")).status).toBe("started");
    const approved = await waitForGateDecision(env.app, task.taskSlug, "validation-adequacy", "approve");
    expect(approved.gates["validation-adequacy"].inputHash).not.toBe(rejectedHash);
    expect(approved.gates["validation-adequacy"].callbackStatus).toBe("sent");
    expect(reviewCount).toBe(2);
  });

  it("fails a malformed written Gate report instead of polling it forever", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-malformed-gate-report");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await writeCompleteArchitecturePlan(task.worktreePath, task.taskSlug, "Complete malformed-report scenario.");
    await updateGateSettings(env.app, task.taskSlug, { "architecture-plan": true });
    await startRole(env.app, task.taskSlug, "project-manager");
    registerPmGateCallback(env, "architecture-plan");

    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", async (ctx) => {
      await ctx.userPromptSubmit();
      const request = matchPromptField(ctx.prompt, "Request")!;
      const report = matchPromptField(ctx.prompt, "Report")!;
      await ctx.writeAbsoluteFile(report, [
        "Gate: architecture-plan",
        `Request: ${request}`,
        "Decision: request_changes",
        "Summary: The finding is malformed.",
        "",
        ...analysisForGate("architecture-plan"),
        "## Findings",
        "",
        "### high: Missing gap field",
        "- Evidence: Current evidence is incomplete.",
        "- Expected: The report names the exact gap.",
        "- Risk: The workflow could act on an incomplete finding.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    expect((await requestGateReview(env.app, task.taskSlug, "architecture-plan")).status).toBe("started");
    let state: GateReviewIndex | undefined;
    await waitFor(async () => {
      state = await getGateState(env.app, task.taskSlug);
      expect(state.gates["architecture-plan"].status).toBe("failed");
      expect(state.gates["architecture-plan"].callbackStatus).toBe("sent");
    }, 3_000);
    expect(state!.gates["architecture-plan"].error).toContain("field Gap");
  });
});

function workflowHistory(
  sequence: number,
  flow: "code-change" | "architect-debug" | "architecture-diagnosis",
  targetRole: "architect" | "coder" | "tester",
  confirmedAt: string
) {
  return {
    sequence,
    flow,
    targetRole,
    evidence: `dispatch-${sequence}`,
    confirmedAt
  };
}

function registerPmGateCallback(
  env: Awaited<ReturnType<typeof createMockClaudeE2eApp>>,
  gate: GateReviewGate
): void {
  env.mockRuntime.onPrompt("project-manager", new RegExp(`gate: ${gate}`), async (ctx) => {
    await ctx.appendTranscriptText(`PM received ${gate} callback.`);
    await ctx.stop();
  }, { once: false });
}

async function waitForGateDecision(
  app: Parameters<typeof getGateState>[0],
  taskSlug: string,
  gate: GateReviewGate,
  decision: GateReviewDecision
): Promise<GateReviewIndex> {
  let state: GateReviewIndex | undefined;
  await waitFor(async () => {
    state = await getGateState(app, taskSlug);
    if (state.gates[gate].status === "failed") {
      throw new Error(state.gates[gate].error ?? `${gate} review failed without an error message.`);
    }
    expect(state.gates[gate]).toMatchObject({
      status: "completed",
      decision,
      callbackStatus: "sent"
    });
  }, 3_000);
  return state!;
}

async function writeGateReport(ctx: MockClaudePromptContext, decision: GateReviewDecision): Promise<void> {
  await ctx.userPromptSubmit();
  const gate = matchPromptField(ctx.prompt, "Gate") as GateReviewGate;
  const request = matchPromptField(ctx.prompt, "Request");
  const report = matchPromptField(ctx.prompt, "Report");
  if (!gate || !request || !report) {
    throw new Error(`Unable to parse gate prompt:\n${ctx.prompt}`);
  }

  await ctx.writeAbsoluteFile(report, [
    `Gate: ${gate}`,
    `Request: ${request}`,
    `Decision: ${decision}`,
    `Summary: ${decision === "approve" ? "Corrected evidence is acceptable." : "Current evidence requires correction."}`,
    "",
    ...analysisForGate(gate),
    "## Findings",
    "",
    ...findingsForDecision(gate, decision)
  ].join("\n"));
  await ctx.stop();
}

function analysisForGate(gate: GateReviewGate): string[] {
  if (gate === "architecture-plan") {
    return [
      "## Architecture Analysis",
      "",
      "- Evidence Read: plan, current source, and affected callers",
      "- Architecture Brief Fit: confirmed decisions are preserved",
      "- End-To-End Flow: entry through completion",
      "- Scope Fit: accepted scope inspected",
      "- Code Reality: current implementation inspected",
      "- Invalidated Assumptions: affected assumptions inspected",
      "- Existing-Class Completeness: related class members reconstructed",
      "- Ownership: state owner inspected",
      "- Data Flow: producer and consumer inspected",
      "- Lifecycle: completion and retry inspected",
      "- Invariants: one durable owner",
      "- Boundaries And Public Surface: affected boundary inspected",
      "- Failure Model: partial failure inspected",
      "- Coder Readiness: implementation decisions are explicit",
      ""
    ];
  }
  if (gate === "validation-adequacy") {
    return [
      "## Validation Analysis",
      "",
      "- Evidence Read: report, production path, and tests",
      "- Changed Behavior And Risk: delivery completion and retry",
      "- Coverage Mapping: behavior mapped to concrete tests",
      "- Baseline Coverage: callable branches inspected",
      "- L2 Integration Coverage: public path inspected",
      "- L3 Trigger Assessment: no mandatory L3 trigger",
      "- L3 End-To-End Coverage: not required",
      "- Boundary And Failure Coverage: retry and recovery inspected",
      "- Public Contract Coverage: observable result asserted",
      "- Test Integrity: real behavior path retained",
      "- Test Infrastructure: no unresolved test-infrastructure defect",
      "- Skips And Gaps: none after correction",
      "- User Approval And Gap Disposition: none",
      "- Validation Readiness: evidence is reviewable",
      ""
    ];
  }
  return [
    "## Code Diff Analysis",
    "",
    "- Commit Range And Sources: complete named range and source chain",
    "- Evidence Read: source artifacts and changed implementation",
    "- Changed Files And Symbols: feature.txt line 1",
    "- Changed Behavior: delivery completion ordering",
    "- Source Evidence Fit: implementation compared with source evidence",
    "- Callers And Public Surface: affected consumers inspected",
    "- State Lifecycle And Failure Paths: write, completion, and retry inspected",
    "- Coding Standards: applicable standards inspected",
    "- Baseline Test Integrity: baseline evidence preserved",
    "- Generated Context And Durable Docs: no additional impact",
    "- Code Readiness: corrected range is reviewable",
    ""
  ];
}

function findingsForDecision(gate: GateReviewGate, decision: GateReviewDecision): string[] {
  if (decision === "approve") {
    return ["None.", ""];
  }
  return [
    `### high: ${gate} correction required`,
    ...(gate === "code-diff"
      ? ["- File: feature.txt", "- Line Or Symbol: line 1", "- Finding Scope: implementation"]
      : []),
    "- Evidence: current artifact omits required behavior evidence",
    "- Expected: artifact proves the complete behavior and failure path",
    "- Gap: required evidence is absent",
    "- Risk: the workflow could approve an incomplete implementation",
    ""
  ];
}

function validTestReport(taskSlug: string, coverage: string): string {
  return renderTestReportTemplate(taskSlug)
    .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
    .replace(
      "Status: none|repair-required|repaired|production-change-required",
      "Status: none"
    )
    .replace("L3 Required: yes|no", "L3 Required: no")
    .replaceAll("TBD", "None.")
    .replace("## Evidence Reviewed\n\nNone.", "## Evidence Reviewed\n\nProduction entry point and current tests.")
    .replace("## Tests Added Or Updated\n\nNone.", "## Tests Added Or Updated\n\nDelivery behavior coverage.")
    .replace("## Coverage Mapping\n\nNone.", `## Coverage Mapping\n\n${coverage}`)
    .replace("### Trigger Assessment\n\nNone.", "### Trigger Assessment\n\nNo mandatory L3 trigger applies.")
    .replace(
      "### Not-Required Evidence\n\nNone.",
      "### Not-Required Evidence\n\nThe fixture changes no externally observable end-to-end behavior, documented L3 path, lifecycle, external contract, or critical invariant; L2 completely proves it."
    )
    .replace("## Commands Run Or Checked\n\nNone.", "## Commands Run Or Checked\n\nMock validation: pass.")
    .replace("## Validation Results\n\nNone.", "## Validation Results\n\nPass.");
}

function matchPromptField(prompt: string, field: string): string | undefined {
  return prompt.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim();
}
