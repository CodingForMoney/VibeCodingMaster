import { describe, expect, it } from "vitest";
import { renderArchitectHarnessRules } from "../../../src/backend/templates/harness/architect-agent.js";
import { renderCoderHarnessRules } from "../../../src/backend/templates/harness/coder-agent.js";
import { renderCoderWorkerHarnessRules } from "../../../src/backend/templates/harness/coder-worker-agent.js";
import { renderReviewerAgentRules } from "../../../src/backend/templates/harness/gate-review.js";
import { renderProjectCodingStandardsRules } from "../../../src/backend/templates/harness/project-coding-standards.js";
import { renderVcmArchitectureInterviewSkillRules } from "../../../src/backend/templates/harness/vcm-architecture-interview-skill.js";
import { renderVcmFinalAcceptanceSkillRules } from "../../../src/backend/templates/harness/vcm-final-acceptance-skill.js";
import { renderVcmRouteMessageSkillRules } from "../../../src/backend/templates/harness/vcm-route-message-skill.js";

describe("machine-consumed harness contracts", () => {
  it("uses the route frontmatter format parsed by the backend", () => {
    const rules = renderVcmRouteMessageSkillRules();

    expect(rules).toContain(
      "artifact_refs: .ai/vcm/handoffs/architecture-plan.md, docs/plans/example.md"
    );
    expect(rules).toContain("artifact_refs: .ai/vcm/handoffs/example.md");
    expect(rules).not.toContain("artifact_refs:\n  -");
  });

  it("gives Coder the exact initial worker state shape", () => {
    const rules = renderCoderHarnessRules();

    expect(rules).toContain('"workerId": "<worker-id>"');
    expect(rules).toContain('"status": "running"');
    expect(rules).toContain('"reportPath": ".ai/vcm/coder-workers/reports/<worker-id>.md"');
    expect(rules).toContain('"handled": false');
    expect(rules).toContain("add the exact `commitHash`");
  });

  it("gives workers the exact running and completed state contract", () => {
    const rules = renderCoderWorkerHarnessRules();

    expect(rules).toContain('"workerId": "<worker-id>"');
    expect(rules).toContain('"status": "running"');
    expect(rules).toContain('"handled": false');
    expect(rules).toContain('add `"commitHash": "<exact-report-commit-hash>"`');
  });

  it("uses the exact final-acceptance decision options in the skill template", () => {
    expect(renderVcmFinalAcceptanceSkillRules()).toContain(
      "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision"
    );
  });

  it("requires an upstream disposition for a third file-local workaround", () => {
    const codingStandards = renderProjectCodingStandardsRules();
    const architect = renderArchitectHarnessRules();
    const reviewer = renderReviewerAgentRules();

    expect(codingStandards).toContain("into a third file");
    expect(codingStandards).toContain("Extracting the repeated local workaround into a helper");
    expect(architect).toContain("already exists in at least two other files");
    expect(architect).toContain("record the unresolved issue and affected call sites");
    expect(reviewer).toContain("search the current worktree for the same mechanism");
    expect(reviewer).toContain("Classify the finding as `implementation`");
  });

  it("requires backward architecture review of existing assumptions and related classes", () => {
    const interview = renderVcmArchitectureInterviewSkillRules();
    const architect = renderArchitectHarnessRules();
    const reviewer = renderReviewerAgentRules();

    expect(interview).toContain("## Existing Assumptions");
    expect(interview).toContain("## Related Class Inventories");
    expect(architect).toContain("Existing Assumptions And Class Coverage");
    expect(architect).toContain("Touched Site | Verified Assumption Or Contract | Evidence | Plan Effect | Disposition");
    expect(architect).toContain("Class Source | Completeness Basis | Member | Plan Disposition");
    expect(reviewer).toContain("Run a backward-impact pass over the plan");
    expect(reviewer).toContain("- Invalidated Assumptions:");
    expect(reviewer).toContain("- Existing-Class Completeness:");
  });
});
