import { describe, expect, it } from "vitest";
import { renderArchitectHarnessRules } from "../../../src/backend/templates/harness/architect-agent.js";
import { renderArchitectEvidenceWorkerHarnessRules } from "../../../src/backend/templates/harness/architect-evidence-worker-agent.js";
import { renderArchitectScaffoldWorkerHarnessRules } from "../../../src/backend/templates/harness/architect-scaffold-worker-agent.js";
import { renderArchitectValidationWorkerHarnessRules } from "../../../src/backend/templates/harness/architect-validation-worker-agent.js";
import { renderRootClaudeHarnessRules } from "../../../src/backend/templates/harness/claude-root.js";
import { renderCoderHarnessRules } from "../../../src/backend/templates/harness/coder-agent.js";
import { renderCoderWorkerHarnessRules } from "../../../src/backend/templates/harness/coder-worker-agent.js";
import { renderReviewerAgentRules } from "../../../src/backend/templates/harness/gate-review.js";
import { renderProjectCodingStandardsRules } from "../../../src/backend/templates/harness/project-coding-standards.js";
import { renderTesterHarnessRules } from "../../../src/backend/templates/harness/tester-agent.js";
import { renderVcmArchitectureInterviewSkillRules } from "../../../src/backend/templates/harness/vcm-architecture-interview-skill.js";
import { renderVcmFinalAcceptanceSkillRules } from "../../../src/backend/templates/harness/vcm-final-acceptance-skill.js";
import { renderVcmLongRunningValidationSkillRules } from "../../../src/backend/templates/harness/vcm-long-running-validation-skill.js";
import { renderVcmRouteMessageSkillRules } from "../../../src/backend/templates/harness/vcm-route-message-skill.js";
import { renderVcmProposeMemorySkillRules } from "../../../src/backend/templates/harness/vcm-propose-memory-skill.js";
import { renderVcmReportHarnessIssueSkillRules } from "../../../src/backend/templates/harness/vcm-report-harness-issue-skill.js";
import {
  renderArchitecturePlanTemplate,
  renderCoderCompletionTemplate,
  renderFinalAcceptanceTemplate,
  renderTestReportTemplate
} from "../../../src/backend/templates/handoff.js";

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

  it("keeps task-scoped validation and worker evidence until task cleanup", () => {
    const longRunningValidation = renderVcmLongRunningValidationSkillRules();
    const architect = renderArchitectHarnessRules();
    const coder = renderCoderHarnessRules();

    expect(longRunningValidation).toContain("Record job ID, command, result, duration");
    expect(longRunningValidation).not.toContain("## Cleanup");
    expect(longRunningValidation).not.toContain("Delete it after the command result");
    expect(architect).not.toContain("Remove `.ai/vcm/architect-workers/`");
    expect(coder).not.toContain("clean `.ai/vcm/coder-workers/`");
  });

  it("requires safe worker report filenames and file-backed completion", () => {
    for (const rules of [
      renderCoderWorkerHarnessRules(),
      renderArchitectEvidenceWorkerHarnessRules(),
      renderArchitectScaffoldWorkerHarnessRules(),
      renderArchitectValidationWorkerHarnessRules()
    ]) {
      expect(rules).toContain("worker-<worker-id>-candidate.md");
      expect(rules).toContain("`report`, `summary`, `findings`, or `analysis` (case-insensitive)");
      expect(rules).toContain("rename it and retry");
      expect(rules).toContain("not just response text");
    }

    const architect = renderArchitectHarnessRules();
    expect(architect).toContain(".ai/vcm/architect-workers/<worker-type>/worker-<worker-id>.md");
    expect(architect).toContain("Read the assigned report file before accepting");
    const scaffold = renderArchitectScaffoldWorkerHarnessRules();
    expect(scaffold).toContain(".ai/vcm/architect-workers/scaffold/worker-<worker-id>.md");
    expect(scaffold).toContain("including when scaffold work remains incomplete");
    expect(scaffold).toContain("completed and remaining Scaffold Manifest IDs");
    expect(scaffold).toContain("exact L0 check commands and results");
    expect(scaffold).toContain("Return the report path");
  });

  it("uses the exact final-acceptance decision options in the skill template", () => {
    expect(renderVcmFinalAcceptanceSkillRules()).toContain(
      "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision"
    );
  });

  it("distinguishes relative artifact destinations from candidate files and repository roots", () => {
    const memory = renderVcmProposeMemorySkillRules();
    const feedback = renderVcmReportHarnessIssueSkillRules();
    expect(memory).toContain("assigned repository-relative destination unchanged to `--path`");
    expect(memory).toContain("`--file`\n  names the candidate file, not the destination");
    expect(feedback).toContain(".ai/vcm/harness-feedback/pending/<UTC timestamp>-<reporter-role>-<short-slug>.md");
    expect(feedback).not.toContain("${VCM_BASE_REPO_ROOT}/.ai/vcm/harness-feedback");
    expect(feedback).toContain("destination inside the base repository root, not the task");
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

  it("requires every rewritten handoff to be a self-contained current snapshot", () => {
    const root = renderRootClaudeHarnessRules();
    const architect = renderArchitectHarnessRules();
    const coder = renderCoderHarnessRules();
    const tester = renderTesterHarnessRules();
    const route = renderVcmRouteMessageSkillRules();

    expect(root).toContain("## VCM Current Handoff Contract");
    expect(root).toContain("make the new revision self-contained");
    expect(architect).toContain("complete, self-contained current executable plan");
    expect(coder).toContain("complete, self-contained current implementation completion evidence");
    expect(tester).toContain("complete, self-contained current validation evidence");
    expect(tester).toContain("as recorded in the prior round");
    expect(route).toContain("current revision is complete and self-contained");

    for (const artifact of [
      renderArchitecturePlanTemplate("demo"),
      renderCoderCompletionTemplate("demo"),
      renderTestReportTemplate("demo"),
      renderFinalAcceptanceTemplate("demo")
    ]) {
      expect(artifact).toContain("VCM current handoff: replace this file with one complete, self-contained snapshot");
    }
  });
});
