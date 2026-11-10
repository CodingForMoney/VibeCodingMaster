// Fixtures for E2E flows that walk a task through the Code-Change Flow with a
// mock Claude Code: a Reviewer that approves every Gate, a passing Test Report,
// and an accepted Final Acceptance.
import { renderFinalAcceptanceTemplate } from "../../../../src/backend/templates/handoff.js";
import type { GateReviewGate } from "../../../../src/shared/types/gate-review.js";
import type { MockClaudePromptContext } from "./mock-claude-runtime.js";

export function acceptedFinalAcceptance(taskSlug: string): string {
  return renderFinalAcceptanceTemplate(taskSlug)
    .replaceAll("TBD", "Complete main flow evidence verified.")
    .replace(
      "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|blocked-by-user-decision",
      "accepted"
    );
}

export async function writeApproveGateReport(ctx: MockClaudePromptContext): Promise<void> {
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
        "- Invalidated Assumptions: verified",
        "- Existing-Class Completeness: verified",
        "- Relationship Evidence: decision-bearing relationships cite search evidence and were re-searched",
        "- Architecture Docs: owning docs updated with the plan and its decisions",
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

export function validTestReport(): string {
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
    "- Evidence Read: architecture plan, completion evidence, diff, and feature file",
    "- Changed Files And Symbols: src/feature.txt mocked feature",
    "- Changed Behavior: complete mocked feature inspected",
    "- Source Evidence Fit: implementation matches the approved plan",
    "- Callers And Public Surface: no callable surface change",
    "- State Lifecycle And Failure Paths: no state lifecycle change",
    "- Coding Standards: applicable standards inspected",
    "- Baseline Test Integrity: mock baseline evidence remains intact",
    "- Documentation Fit: no generated or durable impact",
    "- Code Readiness: ready",
    "",
    "## Findings",
    "",
    "None.",
    ""
  ];
}

export function matchPromptField(prompt: string, field: string): string | undefined {
  return prompt.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

// Answers a Translator batch prompt by writing each item's translation to its
// result path.
export async function writeBatchTranslations(
  ctx: MockClaudePromptContext,
  translate: (sourceText: string) => string
): Promise<void> {
  await ctx.userPromptSubmit();
  for (const item of parseTranslationBatchPrompt(ctx.prompt)) {
    await ctx.writeAbsoluteFile(item.resultPath, translate(item.sourceText));
  }
  await ctx.stop();
}

export function parseTranslationBatchPrompt(prompt: string): Array<{ resultPath: string; sourceText: string }> {
  const items: Array<{ resultPath: string; sourceText: string }> = [];
  const regex = /Result Path \d+:\s*(.+?)\n<VCM_TEXT\d+>\n([\s\S]*?)\n<\/VCM_TEXT\d+>/g;
  for (const match of prompt.matchAll(regex)) {
    const resultPath = match[1]?.trim();
    const sourceText = match[2]?.trim();
    if (resultPath && sourceText) {
      items.push({ resultPath, sourceText });
    }
  }
  if (items.length === 0) {
    throw new Error(`No translation items found in prompt:\n${prompt}`);
  }
  return items;
}
