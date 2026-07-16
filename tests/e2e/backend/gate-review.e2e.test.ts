import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, git } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  getGateState,
  requestGateReview,
  updateGateSettings,
  waitFor
} from "./helpers/e2e-actions.js";
import type { GateReviewGate } from "../../../src/shared/types/gate-review.js";
import type { MockClaudePromptContext } from "./helpers/mock-claude-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("backend E2E Gate Review with mock Claude Code", () => {
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
    env.mockRuntime.onPrompt("gate-reviewer", "[VCM GATE REVIEW]", writeApproveGateReport, { once: false });

    await fs.writeFile(path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"), "", "utf8");
    const emptyArchitecture = await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    expect(emptyArchitecture.status).toBe("not_required");
    expect(emptyArchitecture.message).toContain(".ai/vcm/handoffs/architecture-plan.md is empty");

    await fs.writeFile(
      path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"),
      "# Architecture Plan\n\nAccepted Scope: gate E2E.\n",
      "utf8"
    );
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

    const noCodeDiff = await requestGateReview(env.app, task.taskSlug, "code-diff", { codeDiffSource: "coder" });
    expect(noCodeDiff.status).toBe("not_required");
    expect(noCodeDiff.message).toBe("No new commits to review.");

    await fs.writeFile(path.join(task.worktreePath, "feature.txt"), "hello gate diff\n", "utf8");
    await git(task.worktreePath, "add", "feature.txt");
    await git(task.worktreePath, "commit", "-m", "implement feature");
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
  });
});

async function writeApproveGateReport(ctx: MockClaudePromptContext): Promise<void> {
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
  await ctx.writeAbsoluteFile(report, [
    `Gate: ${gate}`,
    `Request: ${request}`,
    "Decision: approve",
    `Summary: ${gate} inputs are acceptable for this E2E scenario.`,
    "",
    ...architectureAnalysis,
    ...validationAnalysis
  ].join("\n"));
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
    "## Commands Run Or Checked",
    "Mock integration check: pass.",
    "",
    "## Validation Results",
    "Pass.",
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
    ""
  ].join("\n");
}

function validationAnalysisLines(): string[] {
  return [
    "## Validation Analysis",
    "",
    "- Evidence Read: test report, feature entry point, and integration case",
    "- Changed Behavior And Risk: feature behavior and integration risk",
    "- Coverage Mapping: feature mapped to the integration case",
    "- Baseline Coverage: baseline evidence inspected",
    "- Integration And E2E Coverage: integration path covered",
    "- Boundary And Failure Coverage: relevant boundary covered",
    "- Public Contract Coverage: public behavior asserted",
    "- Test Integrity: real path and observable assertion inspected",
    "- Skips And Gaps: none",
    "- Validation Readiness: ready",
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
