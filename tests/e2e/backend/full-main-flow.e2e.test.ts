import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderFinalAcceptanceTemplate } from "../../../src/backend/templates/handoff.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, git } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  getGateState,
  getWorkspaceState,
  requestGateReview,
  sleep,
  startHarnessEngineer,
  startRole,
  updatePreferences,
  updateGateSettings,
  waitFor,
  writeConfirmedArchitectureBrief
} from "./helpers/e2e-actions.js";
import type { GateReviewGate } from "../../../src/shared/types/gate-review.js";
import type { MockClaudePromptContext } from "./helpers/mock-claude-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E complete VCM flow with mock Claude Code", () => {
  it("runs architecture, code, test, gate callbacks, and final acceptance through backend orchestration", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-main-flow");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": true,
      "code-diff": true,
      "validation-adequacy": true
    });
    await updatePreferences(env.app, {
      autoTaskHarnessReviewEnabled: true,
      autoMemoryEnabled: false
    });
    let testerResultHandled = false;

    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", writeApproveGateReport, { once: false });
    env.mockRuntime.onPrompt("harness-engineer", "[VCM Task Harness Retrospective]", async (ctx) => {
      await ctx.userPromptSubmit();
      const resultPath = matchPromptField(ctx.prompt, "Write the analysis to Result Path");
      if (!resultPath) {
        throw new Error(`Unable to parse Harness Retrospective prompt:\n${ctx.prompt}`);
      }
      await ctx.writeAbsoluteFile(
        resultPath,
        "# Task Harness Retrospective\n\nComplete main flow reviewed by Harness Engineer.\n"
      );
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", "Build the complete mocked feature", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Routing to Architect.");
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-architect.md", [
        "---",
        "type: task",
        "---",
        "Create the architecture plan for the complete mocked feature.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("architect", "Create the architecture plan for the complete mocked feature.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Architecture plan complete.");
      await ctx.writeFile(".ai/vcm/handoffs/architecture-plan.md", [
        "# Architecture Plan",
        "",
        "Accepted Scope: complete mocked feature.",
        "Implementation Plan: add src/feature.txt and verify it with tester evidence.",
        ""
      ].join("\n"));
      await ctx.writeFile(".ai/vcm/handoffs/messages/architect-project-manager.md", [
        "---",
        "type: result",
        "artifact_refs: .ai/vcm/handoffs/architecture-plan.md",
        "---",
        "Architecture complete. Plan ready.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Architecture result received.");
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", /gate: architecture-plan[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Architecture gate approved. Routing to Coder.");
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-coder.md", [
        "---",
        "type: task",
        "artifact_refs: .ai/vcm/handoffs/architecture-plan.md",
        "---",
        "Implement the complete mocked feature from the approved architecture plan.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("coder", "Implement the complete mocked feature from the approved architecture plan.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Coder implementation complete.");
      await ctx.writeFile("src/feature.txt", "complete mocked feature\n");
      await ctx.writeFile(".ai/vcm/handoffs/coder-completion.md", [
        "# Coder Completion",
        "",
        "Decision: ready_for_review",
        "Validation: L0/L1 mock checks passed.",
        ""
      ].join("\n"));
      await git(ctx.cwd, "add", "src/feature.txt");
      await git(ctx.cwd, "commit", "-m", "implement mocked feature");
      await ctx.writeFile(".ai/vcm/handoffs/messages/coder-project-manager.md", [
        "---",
        "type: result",
        "artifact_refs: .ai/vcm/handoffs/coder-completion.md",
        "---",
        "Coder complete. Commit ready.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", "Coder complete. Commit ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Coder result received.");
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", /gate: code-diff[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Code diff gate approved. Routing to Tester.");
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-tester.md", [
        "---",
        "type: task",
        "artifact_refs: .ai/vcm/handoffs/coder-completion.md",
        "---",
        "Validate the complete mocked feature.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("tester", "Validate the complete mocked feature.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Tester validation passed.");
      await ctx.writeFile(".ai/vcm/handoffs/test-report.md", validTestReport());
      await ctx.writeFile(".ai/vcm/handoffs/messages/tester-project-manager.md", [
        "---",
        "type: result",
        "artifact_refs: .ai/vcm/handoffs/test-report.md",
        "---",
        "Tester passed. Test report ready.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", "Tester passed. Test report ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Tester result received.");
      await ctx.stop();
      testerResultHandled = true;
    });

    env.mockRuntime.onPrompt("project-manager", /gate: validation-adequacy[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Validation gate approved. Final acceptance complete.");
      await ctx.writeFile(
        ".ai/vcm/handoffs/final-acceptance.md",
        acceptedFinalAcceptance(task.taskSlug)
      );
      await ctx.stop();
    });

    await startRole(env.app, task.taskSlug, "project-manager");
    await startRole(env.app, task.taskSlug, "architect");
    await startRole(env.app, task.taskSlug, "coder");
    await startRole(env.app, task.taskSlug, "tester");
    const harnessSession = await startHarnessEngineer(env.app, task.taskSlug);
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    expect(pmSession).toBeDefined();

    env.mockRuntime.write(pmSession!.id, "Build the complete mocked feature");
    await env.mockRuntime.waitForIdle();
    await expect(fs.readFile(path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"), "utf8"))
      .resolves.toContain("complete mocked feature");

    await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    await waitForGate(env.app, task.taskSlug, "architecture-plan");
    await waitForFile(path.join(task.worktreePath, "src/feature.txt"));
    await env.mockRuntime.waitForIdle();

    await requestGateReview(env.app, task.taskSlug, "code-diff", { codeDiffSource: "coder" });
    await waitForGate(env.app, task.taskSlug, "code-diff");
    await waitForFile(path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md"));
    await env.mockRuntime.waitForIdle();
    await waitFor(() => testerResultHandled);

    await requestGateReview(env.app, task.taskSlug, "validation-adequacy");
    await waitForGate(env.app, task.taskSlug, "validation-adequacy");
    await waitFor(async () => {
      const content = await fs.readFile(
        path.join(task.worktreePath, ".ai/vcm/handoffs/final-acceptance.md"),
        "utf8"
      );
      expect(content).toContain("## Decision\n\naccepted");
    });
    await env.mockRuntime.waitForIdle();

    const finalAcceptance = await fs.readFile(path.join(task.worktreePath, ".ai/vcm/handoffs/final-acceptance.md"), "utf8");
    expect(finalAcceptance).toContain("## Decision\n\naccepted");
    const gateState = await getGateState(env.app, task.taskSlug);
    expect(gateState.gates["architecture-plan"]).toMatchObject({ status: "completed", decision: "approve" });
    expect(gateState.gates["code-diff"]).toMatchObject({ status: "completed", decision: "approve" });
    expect(gateState.gates["validation-adequacy"]).toMatchObject({ status: "completed", decision: "approve" });

    await waitFor(async () => {
      const workspace = await getWorkspaceState(env.app, task.taskSlug);
      expect(workspace.roundState.status).toBe("stopped");
      expect(workspace.roundState.roundId).toBeTruthy();
    });
    expect(env.mockRuntime.getWrites(harnessSession.id).join("\n"))
      .not.toContain("[VCM Task Harness Retrospective]");

    await env.deps.runtimeCoordinator.reconcileProject(repo.repoRoot, { taskSlug: task.taskSlug });
    await env.mockRuntime.waitForIdle();

    expect(env.mockRuntime.getWrites(harnessSession.id).join("\n"))
      .toContain("[VCM Task Harness Retrospective]");
    await expect(fs.readFile(
      path.join(repo.repoRoot, ".ai/vcm/harness-feedback/task-retrospectives", `${task.taskSlug}.md`),
      "utf8"
    )).resolves.toContain("Complete main flow reviewed by Harness Engineer.");
    await expect(fs.readFile(
      path.join(repo.repoRoot, ".ai/vcm/harness-feedback/task-retrospectives", `${task.taskSlug}.json`),
      "utf8"
    )).resolves.toContain('"trigger": "auto"');
  });
});

function acceptedFinalAcceptance(taskSlug: string): string {
  return renderFinalAcceptanceTemplate(taskSlug)
    .replaceAll("TBD", "Complete main flow evidence verified.")
    .replace(
      "## Decision\n\nComplete main flow evidence verified.",
      "## Decision\n\naccepted"
    );
}

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
    `Summary: ${gate} approved in complete flow E2E.`,
    "",
    ...architectureAnalysis,
    ...validationAnalysis,
    ...codeDiffAnalysis
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
    "",
    "## User Approval Evidence",
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
    "- Evidence Read: architecture plan, completion evidence, diff, and feature file",
    "- Changed Files And Symbols: src/feature.txt mocked feature",
    "- Changed Behavior: complete mocked feature inspected",
    "- Source Evidence Fit: implementation matches the approved plan",
    "- Callers And Public Surface: no callable surface change",
    "- State Lifecycle And Failure Paths: no state lifecycle change",
    "- Coding Standards: applicable standards inspected",
    "- Baseline Test Integrity: mock baseline evidence remains intact",
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

async function waitForFile(filePath: string): Promise<void> {
  await waitFor(async () => {
    await fs.access(filePath);
  }, 2_000);
  await sleep(20);
}
