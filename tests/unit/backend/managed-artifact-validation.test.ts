import { describe, expect, it } from "vitest";
import type { ArtifactKind } from "../../../src/shared/types/artifact.js";
import type { GateReviewGate } from "../../../src/shared/types/gate-review.js";
import {
  MANAGED_ARTIFACT_DEFINITIONS,
  getManagedArtifactDefinition
} from "../../../src/shared/validation/artifact-registry.js";
import {
  GATE_ANALYSIS_FIELDS,
  GATE_ANALYSIS_HEADINGS,
  parseCoderWorkerReportArtifact,
  parseGateReviewReportArtifact,
  parseHarnessFeedbackArtifact,
  parseMemoryProposalArtifact,
  parseRouteMessageArtifact,
  validateManagedArtifactContent
} from "../../../src/backend/services/managed-artifact-validation.js";
import {
  renderArchitectureBriefTemplate,
  renderArchitectureDiagnosisTemplate,
  renderArchitectureEvidenceTemplate,
  renderArchitecturePlanTemplate,
  renderArchitectDebugTemplate,
  renderCoderCompletionTemplate,
  renderDocsSyncReportTemplate,
  renderDocsUpdateReportTemplate,
  renderFinalAcceptanceTemplate,
  renderKnownIssuesTemplate,
  renderPlanningProgressTemplate,
  renderTestReportTemplate,
  renderWorkflowProgressTemplate
} from "../../../src/backend/templates/handoff.js";

const STATIC_TEMPLATES: Record<ArtifactKind, string> = {
  "architecture-brief": renderArchitectureBriefTemplate("demo"),
  "architecture-evidence": renderArchitectureEvidenceTemplate("demo"),
  "planning-progress": renderPlanningProgressTemplate("demo"),
  "architecture-plan": renderArchitecturePlanTemplate("demo"),
  "known-issues": renderKnownIssuesTemplate("demo"),
  "coder-completion": renderCoderCompletionTemplate("demo"),
  "architect-debug": renderArchitectDebugTemplate("demo"),
  "architecture-diagnosis": renderArchitectureDiagnosisTemplate("demo"),
  "test-report": renderTestReportTemplate("demo"),
  "docs-update-report": renderDocsUpdateReportTemplate("demo"),
  "docs-sync-report": renderDocsSyncReportTemplate("demo"),
  "workflow-progress": renderWorkflowProgressTemplate("demo"),
  "final-acceptance": renderFinalAcceptanceTemplate("demo")
};

describe("managed artifact contracts", () => {
  it("registers all 18 managed artifact kinds exactly once", () => {
    expect(MANAGED_ARTIFACT_DEFINITIONS).toHaveLength(18);
    expect(new Set(MANAGED_ARTIFACT_DEFINITIONS.map((definition) => definition.kind)).size).toBe(18);
    expect(MANAGED_ARTIFACT_DEFINITIONS.filter((definition) => definition.storage === "handoff")).toHaveLength(13);
    expect(MANAGED_ARTIFACT_DEFINITIONS.filter((definition) => definition.storage === "dynamic")).toHaveLength(5);
    expect(getManagedArtifactDefinition("workflow-progress").allowedModes).toEqual(["final"]);
    expect(getManagedArtifactDefinition("gate-review-report").owner).toBe("reviewer");
  });

  it("keeps every static template aligned with its registered heading contract", () => {
    for (const definition of MANAGED_ARTIFACT_DEFINITIONS.filter((candidate) => candidate.storage === "handoff")) {
      const kind = definition.kind as ArtifactKind;
      const template = STATIC_TEMPLATES[kind];
      const result = validateManagedArtifactContent(kind, template, {
        path: `.ai/vcm/handoffs/${definition.fileName}`,
        mode: kind === "workflow-progress" ? "final" : "draft"
      });
      expect(result.errors.filter((error) => error.startsWith("Missing required heading:")), kind).toEqual([]);

      const heading = definition.requiredHeadings[0];
      const mutated = template.replace(new RegExp(`^#{2,6} ${escapeRegExp(heading)}\\s*$`, "m"), "## Removed Heading");
      const invalid = validateManagedArtifactContent(kind, mutated, {
        path: `.ai/vcm/handoffs/${definition.fileName}`,
        mode: kind === "workflow-progress" ? "final" : "draft"
      });
      expect(invalid.errors, `${kind}:${heading}`).toContain(`Missing required heading: ${heading}.`);
    }
  });

  it("parses valid dynamic artifacts through their shared consumer contracts", () => {
    expect(parseRouteMessageArtifact(validRouteMessage()).parsed).toMatchObject({
      type: "task",
      body: "Implement the accepted task."
    });
    expect(parseCoderWorkerReportArtifact(validWorkerReport()).parsed).toMatchObject({
      workerId: "worker-a",
      workerState: "completed",
      implementationResult: "success"
    });
    expect(parseMemoryProposalArtifact(validMemoryProposal()).parsed).toMatchObject({ decision: "no-change" });
    expect(parseHarnessFeedbackArtifact(validHarnessFeedback()).parsed).toMatchObject({
      reporterRole: "coder",
      urgency: "medium"
    });
    for (const gate of ["architecture-plan", "validation-adequacy", "code-diff"] as const) {
      expect(parseGateReviewReportArtifact(validGateReport(gate), {
        expectedGate: gate,
        expectedRequestId: "request-1"
      }).parsed).toMatchObject({ gate, requestId: "request-1", decision: "approve", findings: [] });
    }
  });

  it("rejects route, worker, memory, and feedback format mutations", () => {
    expect(parseRouteMessageArtifact(validRouteMessage().replace("type: task", "type: user-request")).errors)
      .toContain("Frontmatter type must be exactly one of task|question|revise|cancel|result|blocked|finding.");
    expect(parseRouteMessageArtifact(validRouteMessage().replace("Implement the accepted task.", "")).errors)
      .toContain("Route message body must not be empty.");

    for (const heading of getManagedArtifactDefinition("coder-worker-report").requiredHeadings) {
      const invalid = parseCoderWorkerReportArtifact(
        validWorkerReport().replace(`## ${heading}`, "## Removed Heading")
      );
      expect(invalid.errors.some((error) => error.includes(`Heading ${heading}`)), heading).toBe(true);
    }
    expect(parseCoderWorkerReportArtifact(
      validWorkerReport().replace("Implementation Result: success", "Implementation Result: partial")
    ).errors.some((error) => error.includes("success|has_failed_items"))).toBe(true);

    expect(parseMemoryProposalArtifact(validMemoryProposal().replace("## Update", "## Changed")).errors).not.toEqual([]);
    for (const field of [
      "Reporter role", "Task slug", "Summary", "Observed problem", "Expected behavior",
      "Evidence", "Suspected harness area", "Impact", "Urgency"
    ]) {
      const invalid = parseHarnessFeedbackArtifact(
        validHarnessFeedback().replace(new RegExp(`^- ${escapeRegExp(field)}:.*$`, "m"), "")
      );
      expect(invalid.errors.some((error) => error.includes(`field ${field}`)), field).toBe(true);
    }
  });

  it("requires every gate-specific analysis field in both approval and change reports", () => {
    for (const gate of ["architecture-plan", "validation-adequacy", "code-diff"] as const) {
      for (const field of GATE_ANALYSIS_FIELDS[gate]) {
        const invalid = parseGateReviewReportArtifact(
          validGateReport(gate).replace(`- ${field}: Verified.`, ""),
          { expectedGate: gate, expectedRequestId: "request-1" }
        );
        expect(invalid.errors.some((error) => error.includes(`field ${field}`)), `${gate}:${field}`).toBe(true);
      }
    }
  });

  it("enforces the gate decision and structured finding matrix", () => {
    expect(parseGateReviewReportArtifact(
      validGateReport("architecture-plan").replace("None.", "No issues."),
      { expectedGate: "architecture-plan", expectedRequestId: "request-1" }
    ).errors).toContain('Findings must contain exactly "None." when Decision is approve.');

    const finding = validGateReport("architecture-plan", "request_changes");
    expect(parseGateReviewReportArtifact(
      finding.replace("- Gap: Required behavior is absent.", ""),
      { expectedGate: "architecture-plan", expectedRequestId: "request-1" }
    ).errors.some((error) => error.includes("field Gap"))).toBe(true);

    const codeFinding = validGateReport("code-diff", "request_changes");
    expect(parseGateReviewReportArtifact(
      codeFinding.replace("- File: src/feature.ts", ""),
      { expectedGate: "code-diff", expectedRequestId: "request-1" }
    ).errors.some((error) => error.includes("field File"))).toBe(true);
    expect(parseGateReviewReportArtifact(codeFinding, {
      expectedGate: "code-diff",
      expectedRequestId: "different-request"
    }).errors.some((error) => error.includes("Request must be different-request"))).toBe(true);
  });
});

function validRouteMessage(): string {
  return "---\ntype: task\nartifact_refs: .ai/vcm/handoffs/architecture-plan.md\n---\nImplement the accepted task.\n";
}

function validWorkerReport(): string {
  return `# Coder Worker Report: worker-a

Worker State: completed
Implementation Result: success

## Assigned Scope
module-a

## Item Dispositions
All items completed.

## Files Changed
src/feature.ts

## Tests Added Or Updated
tests/feature.test.ts

## L0/L1 Checks
Passed.

## Commit
abc1234

## Skipped Assigned Checks
None.

## Objective Failures
None.
`;
}

function validMemoryProposal(): string {
  return "# Memory Proposal\nDecision: no-change\n\n## Add\nnone\n\n## Update\nnone\n\n## Remove\nnone\n";
}

function validHarnessFeedback(): string {
  return `# Reusable harness problem

- Reporter role: coder
- Task slug: demo
- Summary: A reusable route rule is unclear.
- Observed problem: Coder emitted an ambiguous route.
- Expected behavior: The route contract should be explicit.
- Evidence: The current task route file.
- Suspected harness area: route skill
- Impact: The workflow can dispatch incorrectly.
- Urgency: medium
`;
}

function validGateReport(
  gate: GateReviewGate,
  decision: "approve" | "request_changes" = "approve"
): string {
  const analysis = GATE_ANALYSIS_FIELDS[gate].map((field) => `- ${field}: Verified.`);
  const finding = decision === "approve"
    ? ["None."]
    : [
        "### high: Missing required behavior",
        ...(gate === "code-diff"
          ? ["- File: src/feature.ts", "- Line Or Symbol: feature", "- Finding Scope: implementation"]
          : []),
        "- Evidence: Current evidence shows the behavior is absent.",
        "- Expected: The required behavior is present.",
        "- Gap: Required behavior is absent.",
        "- Risk: The accepted flow can fail."
      ];
  return [
    `Gate: ${gate}`,
    "Request: request-1",
    `Decision: ${decision}`,
    "Summary: The complete gate input was reviewed.",
    "",
    `## ${GATE_ANALYSIS_HEADINGS[gate]}`,
    "",
    ...analysis,
    "",
    "## Findings",
    "",
    ...finding,
    ""
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
