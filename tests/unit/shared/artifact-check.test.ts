import { describe, expect, it } from "vitest";
import {
  renderArchitectureBriefTemplate,
  renderArchitecturePlanTemplate,
  renderDocsUpdateReportTemplate,
  renderDocsSyncReportTemplate,
  renderFinalAcceptanceTemplate,
  renderTestReportTemplate
} from "../../../src/backend/templates/handoff.js";
import { checkMarkdownArtifact } from "../../../src/shared/validation/artifact-check.js";

describe("checkMarkdownArtifact", () => {
  it("reports missing artifacts", () => {
    const result = checkMarkdownArtifact("architecture-plan", "architecture-plan.md", null);
    expect(result.status).toBe("missing");
    expect(result.exists).toBe(false);
  });

  it("reports ok when required headings exist", () => {
    const result = checkMarkdownArtifact("test-report", "test-report.md", `
# Test Report

Test Result: pass

## Evidence Reviewed
Reviewed.

## Tests Added Or Updated
Updated.

## Coverage Mapping
Feature behavior -> tests/feature.test.ts -> pass.

## Validation Progress

### Completed Validation
L0, L1, and L2 completed.

### Remaining Validation
None.

## L3 Coverage

L3 Required: no

### Trigger Assessment
No mandatory L3 trigger applies.

### Affected End-To-End Flows
None.

### L3 Commands And Evidence
None.

### Not-Required Evidence
No end-to-end behavior, documented L3 path, lifecycle, external contract, or critical invariant changed; L2 completely proves the behavior.

## Commands Run Or Checked
Checked.

## Validation Results
Passed.

## Test Infrastructure

Status: none

### Affected Files
None.

### Boundary Evidence
None.

### Defect-Class Sweep
None.

### Repair Commit
None.

## Failed Expectations
None.

## Reproduction Steps
None.

## Skipped Checks With Reasons
None.

## Coverage Gaps
None.

## Blocking Validation Issues
None.

## User Approval Evidence
None.
`);
    expect(result.status).toBe("ok");
    expect(result.hasPlaceholder).toBe(false);
  });

  it("requires Scaffold Manifest in architecture plans", () => {
    const result = checkMarkdownArtifact("architecture-plan", "architecture-plan.md", `
# Architecture Plan

Planning Result: complete

## Accepted Scope
Ready.

## Current Code Reality

### Planning Boundary
Feature boundary.

### Code Reading Evidence
Read the entry point and callers.

### Existing Behavior Trace
Entry to completion.

### Code / Docs Conflicts
None.

## Architecture Decision

### Changed Behavior Flow
Entry to owner to completion.

### Ownership
Existing service.

### Data Flow
Request to service.

### Lifecycle
Start to completion.

### Boundaries
Existing module boundary.

### Invariants
Single source of truth.

### Failure Model
Errors propagate to caller.

### Decision Rationale
Use the existing boundary.

## Module/File Plan
One scoped change.

## Public Surface Impact
None.

## Scaffold Manifest
No code scaffold needed.

## Scaffold Build Evidence
Compile check passed at the scaffold commit.

## Tester Coverage Hints
Cover changed behavior.

## Docs Impact
None.

## Known Risks
None.

## Coder Handoff Notes
Implement the manifest.
`);
    expect(result.status).toBe("ok");
  });

  it("requires Scaffold Build Evidence in architecture plans", () => {
    const content = completeTemplate("architecture-plan", renderArchitecturePlanTemplate("demo"))
      .replace("## Scaffold Build Evidence", "Scaffold Build Evidence");
    const result = checkMarkdownArtifact("architecture-plan", "architecture-plan.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.missingHeadings).toContain("Scaffold Build Evidence");
  });

  it("accepts only complete architecture planning results", () => {
    const content = completeTemplate("architecture-plan", renderArchitecturePlanTemplate("demo"));
    const result = checkMarkdownArtifact("architecture-plan", "architecture-plan.md", content);

    expect(result.status).toBe("ok");
    expect(result.invalidFields).toEqual([]);
  });

  it.each([
    "incomplete",
    "user clarification required",
    "complete|incomplete|user clarification required",
    "unknown"
  ])("rejects architecture planning result %s", (planningResult) => {
    const content = completeTemplate("architecture-plan", renderArchitecturePlanTemplate("demo"))
      .replace("Planning Result: complete", `Planning Result: ${planningResult}`);
    const result = checkMarkdownArtifact("architecture-plan", "architecture-plan.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      `Planning Result must be exactly one of "complete"; found "${planningResult}".`
    );
  });

  it("rejects architecture plans without a planning result", () => {
    const content = completeTemplate("architecture-plan", renderArchitecturePlanTemplate("demo"))
      .replace("Planning Result: complete\n", "");
    const result = checkMarkdownArtifact("architecture-plan", "architecture-plan.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Planning Result must be exactly one of \"complete\"; found <missing>."
    );
  });

  it("requires code-reading evidence and explicit architecture decisions", () => {
    const result = checkMarkdownArtifact("architecture-plan", "architecture-plan.md", `
# Architecture Plan

Planning Result: complete

## Accepted Scope
Ready.

## Current Code Reality
Reviewed.

## Architecture Decision
Use the existing boundary.

## Module/File Plan
One scoped change.

## Public Surface Impact
None.

## Scaffold Manifest
One implementation row.

## Tester Coverage Hints
Cover changed behavior.

## Docs Impact
None.

## Known Risks
None.

## Coder Handoff Notes
Implement the manifest.
`);

    expect(result.status).toBe("incomplete");
    expect(result.missingHeadings).toContain("Code Reading Evidence");
    expect(result.missingHeadings).toContain("Changed Behavior Flow");
    expect(result.missingHeadings).toContain("Invariants");
    expect(result.missingHeadings).toContain("Failure Model");
  });

  it("supports docs sync reports", () => {
    const result = checkMarkdownArtifact("docs-sync-report", "docs-sync-report.md", `
# Docs Sync Report

## Summary
Checked.

## Architecture Drift Check
No drift.

## Docs Updated
None.

## Docs Reviewed And Left Unchanged
README.md remains current.

## Public Contract / Module Boundary Notes
No changes.

## Remaining Documentation Risks
None.

## Known Issues Disposition
No task issues to promote.

## Decision
unchanged
`);
    expect(result.status).toBe("ok");
  });

  it("supports final acceptance reports", () => {
    const result = checkMarkdownArtifact("final-acceptance", "final-acceptance.md", `
# Final Acceptance

## Decision
accepted

## Evidence Reviewed
All handoffs.

## Scope Traceability
All changes traced.

## Validation Summary
Checks passed.

## Review And Docs Sync
Tester and docs sync complete.

## Known Issues Disposition
No task issues to promote.

## Gate Review Gates
Complete.

## Cleanup Readiness
Ready.

## Final User Summary
Done.
`);
    expect(result.status).toBe("ok");
  });

  it("supports task-local known issues", () => {
    const result = checkMarkdownArtifact("known-issues", "known-issues.md", `
# Known Issues

## Task Issues
No unresolved task issues.

## Escalation To Docs
Nothing to promote.
`);
    expect(result.status).toBe("ok");
  });

  it("rejects unresolved test-report results", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"));
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Test Result must be exactly one of \"pass|fail|incomplete\"; found \"pass|fail|incomplete\"."
    );
  });

  it("accepts a complete in-progress test report as continuation state", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: incomplete")
      .replace(
        "### Completed Validation\n\nNone.",
        "### Completed Validation\n\nL0 and L1 completed successfully."
      )
      .replace(
        "### Remaining Validation\n\nNone.",
        "### Remaining Validation\n\nRun the required L2 integration matrix."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content, { mode: "draft" });

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toEqual([]);
  });

  it("rejects an incomplete test report without remaining validation", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: incomplete")
      .replace(
        "### Completed Validation\n\nNone.",
        "### Completed Validation\n\nL0 and L1 completed successfully."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Remaining Validation must list continuation work when Test Result is incomplete."
    );
  });

  it("rejects blocking issues disguised as incomplete validation", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: incomplete")
      .replace(
        "### Completed Validation\n\nNone.",
        "### Completed Validation\n\nL0 and L1 completed successfully."
      )
      .replace(
        "### Remaining Validation\n\nNone.",
        "### Remaining Validation\n\nRun the required L2 integration matrix."
      )
      .replace(
        "## Blocking Validation Issues\n\nNone.",
        "## Blocking Validation Issues\n\nThe integration environment is unavailable."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Blocking Validation Issues must contain exactly \"None.\" when Test Result is incomplete; found \"The integration environment is unavailable.\"."
    );
  });

  it("rejects pass test reports with blocking validation issues", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
      .replace("## Blocking Validation Issues\n\nNone.", "## Blocking Validation Issues\n\nMissing E2E coverage.");
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Blocking Validation Issues must contain exactly \"None.\" when Test Result is pass; found \"Missing E2E coverage.\"."
    );
  });

  it("rejects pass test reports with coverage gaps", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
      .replace("## Coverage Gaps\n\nNone.", "## Coverage Gaps\n\nMissing E2E coverage.");
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Coverage Gaps must contain exactly \"None.\" when Test Result is pass; found \"Missing E2E coverage.\"."
    );
  });

  it("rejects pass test reports with remaining validation", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
      .replace(
        "### Remaining Validation\n\nNone.",
        "### Remaining Validation\n\nRun the required L2 integration matrix."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Remaining Validation must contain exactly \"None.\" when Test Result is pass; found \"Run the required L2 integration matrix.\"."
    );
  });

  it("rejects unresolved test-infrastructure repair status in a passing report", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
      .replace(
        "Status: none",
        "Status: repair-required"
      )
      .replace("### Affected Files\n\nNone.", "### Affected Files\n\ntests/e2e/runner.sh")
      .replace(
        "### Boundary Evidence\n\nNone.",
        "### Boundary Evidence\n\nOnly the current L3 runner is affected."
      )
      .replace(
        "### Defect-Class Sweep\n\nNone.",
        "### Defect-Class Sweep\n\nChecked sibling runners for the same pipefail assignment."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Test Result must be fail when Test Infrastructure Status is repair-required."
    );
  });

  it("accepts a completed test-infrastructure repair with concrete evidence", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
      .replace(
        "Status: none",
        "Status: repaired"
      )
      .replace("### Affected Files\n\nNone.", "### Affected Files\n\ntests/e2e/runner.sh")
      .replace(
        "### Boundary Evidence\n\nNone.",
        "### Boundary Evidence\n\nThe repair changes only the test runner."
      )
      .replace(
        "### Defect-Class Sweep\n\nNone.",
        "### Defect-Class Sweep\n\nChecked every sibling runner using the same count pipeline."
      )
      .replace("### Repair Commit\n\nNone.", "### Repair Commit\n\nabc1234 fix test runner");
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("ok");
  });

  it("rejects fail test reports without blocking evidence", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: fail");
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Blocking Validation Issues must contain concrete evidence when Test Result is fail."
    );
  });

  it("rejects coverage gaps without user approval evidence", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: fail")
      .replace("## Coverage Gaps\n\nNone.", "## Coverage Gaps\n\nMissing live gateway coverage.")
      .replace(
        "## Blocking Validation Issues\n\nNone.",
        "## Blocking Validation Issues\n\nLive gateway validation remains unavailable."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "User Approval Evidence is required when Coverage Gaps are recorded."
    );
  });

  it("accepts user-approved coverage gaps as a failed test result", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: fail")
      .replace("## Coverage Gaps\n\nNone.", "## Coverage Gaps\n\nMissing live gateway coverage.")
      .replace(
        "## Blocking Validation Issues\n\nNone.",
        "## Blocking Validation Issues\n\nLive gateway validation remains unavailable."
      )
      .replace(
        "## User Approval Evidence\n\nNone.",
        "## User Approval Evidence\n\nUser approved retaining the live gateway coverage gap."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("ok");
  });

  it("rejects user approval evidence when no coverage gap is recorded", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: fail")
      .replace(
        "## Blocking Validation Issues\n\nNone.",
        "## Blocking Validation Issues\n\nA runtime assertion failed."
      )
      .replace(
        "## User Approval Evidence\n\nNone.",
        "## User Approval Evidence\n\nUser approved an unrelated exception."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "User Approval Evidence must contain exactly \"None.\" when no Coverage Gaps are recorded; found \"User approved an unrelated exception.\"."
    );
  });

  it("requires an explicit L3 applicability decision", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
      .replace("L3 Required: no", "L3 Required: undecided");
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "L3 Required must be exactly one of \"yes|no\"; found \"undecided\"."
    );
  });

  it("requires L3 mapping and execution evidence when L3 is required", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
      .replace("L3 Required: no", "L3 Required: yes")
      .replace("### Affected End-To-End Flows\n\n|", "### Affected End-To-End Flows\n\nNone.\n\n|");
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Affected End-To-End Flows are required when L3 Required is yes."
    );
    expect(result.invalidFields).toContain(
      "L3 Commands And Evidence are required when L3 Required is yes."
    );
  });

  it("accepts complete required L3 mapping and execution evidence", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
      .replace("L3 Required: no", "L3 Required: yes")
      .replace(
        "| None. | None. | None. | None. | None. | None. | <run-existing|updated|added> | None. |",
        "| Checkout flow | observable result changed | E2E-001 | tests/e2e/checkout.spec.ts | public checkout entry | persisted order | updated | pass |"
      )
      .replace(
        "### L3 Commands And Evidence\n\nNone.",
        "### L3 Commands And Evidence\n\nnpm run e2e -- checkout: pass."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("ok");
  });

  it("requires concrete evidence when L3 is not required", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
      .replace(
        "### Not-Required Evidence\n\nNo mandatory L3 trigger applies because the change is fully proved at L2.",
        "### Not-Required Evidence\n\nNone."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Not-Required Evidence is required when L3 Required is no."
    );
  });

  it("rejects invalid docs-sync decisions", () => {
    const result = checkMarkdownArtifact("docs-sync-report", "docs-sync-report.md", `
# Docs Sync Report

## Summary
Checked.
## Architecture Drift Check
None.
## Docs Updated
None.
## Docs Reviewed And Left Unchanged
README.md.
## Public Contract / Module Boundary Notes
None.
## Remaining Documentation Risks
None.
## Known Issues Disposition
None.
## Decision
looks-good
`);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields[0]).toContain("synced|unchanged|blocked");
  });

  it("rejects invalid final-acceptance decisions", () => {
    const content = renderFinalAcceptanceTemplate("demo")
      .replaceAll("TBD", "None.");
    const result = checkMarkdownArtifact("final-acceptance", "final-acceptance.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields[0]).toContain("accepted-with-known-risks");
  });

  it("keeps generated artifact templates aligned with required headings", () => {
    const templates = [
      ["architecture-brief", renderArchitectureBriefTemplate("demo")],
      ["architecture-plan", renderArchitecturePlanTemplate("demo")],
      ["test-report", renderTestReportTemplate("demo")],
      ["docs-update-report", renderDocsUpdateReportTemplate("demo")],
      ["docs-sync-report", renderDocsSyncReportTemplate("demo")],
      ["final-acceptance", renderFinalAcceptanceTemplate("demo")]
    ] as const;

    for (const [kind, content] of templates) {
      const completed = completeTemplate(kind, content);
      const result = checkMarkdownArtifact(kind, `${kind}.md`, completed);
      expect(result.missingHeadings, kind).toEqual([]);
      expect(result.status, kind).toBe("ok");
    }
  });

  it("exposes every machine-enforced option in generated templates", () => {
    expect(renderArchitectureBriefTemplate("demo")).toContain(
      "Architecture Brief Status: interviewing|confirmed"
    );
    expect(renderArchitecturePlanTemplate("demo")).toContain(
      "Planning Result: complete|incomplete|user clarification required"
    );
    expect(renderArchitecturePlanTemplate("demo")).toContain(
      "| <ID> | <create|change|delete> | `<repo-relative-file>` |"
    );
    expect(renderArchitecturePlanTemplate("demo")).toContain(
      "Use an ID matching `[A-Z]{2,6}-[0-9]{1,4}`"
    );
    expect(renderTestReportTemplate("demo")).toContain("Test Result: pass|fail|incomplete");
    expect(renderTestReportTemplate("demo")).toContain(
      "Status: none|repair-required|repaired|production-change-required"
    );
    expect(renderTestReportTemplate("demo")).toContain("L3 Required: yes|no");
    expect(renderTestReportTemplate("demo")).toContain("<run-existing|updated|added>");
    expect(renderDocsSyncReportTemplate("demo")).toContain(
      "## Decision\n\nsynced|unchanged|blocked"
    );
    expect(renderDocsUpdateReportTemplate("demo")).toContain(
      "## Decision\n\nsynced|unchanged|blocked"
    );
    expect(renderFinalAcceptanceTemplate("demo")).toContain(
      "## Decision\n\naccepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision"
    );
  });

  it("rejects text appended after an exact None section value", () => {
    const content = completeL3NotRequired(renderTestReportTemplate("demo"))
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass")
      .replace(
        "## Coverage Gaps\n\nNone.",
        "## Coverage Gaps\n\nNone.\n\nExtra explanation."
      );
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Coverage Gaps must contain exactly \"None.\" when Test Result is pass; found \"None. Extra explanation.\"."
    );
  });

  it("rejects text appended after confirmed unresolved decisions", () => {
    const content = completeTemplate("architecture-brief", renderArchitectureBriefTemplate("demo"))
      .replace(
        "## Unresolved User Decisions\n\nNone.",
        "## Unresolved User Decisions\n\nNone.\n\nNo action needed."
      );
    const result = checkMarkdownArtifact("architecture-brief", "architecture-brief.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Unresolved User Decisions must contain exactly \"None.\" when Architecture Brief Status is confirmed; found \"None. No action needed.\"."
    );
  });

  it("rejects explanations appended to exact decision sections", () => {
    const content = completeTemplate("final-acceptance", renderFinalAcceptanceTemplate("demo"))
      .replace("## Decision\n\naccepted", "## Decision\n\naccepted\n\nEverything passed.");
    const result = checkMarkdownArtifact("final-acceptance", "final-acceptance.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Decision must contain exactly \"accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision\"; found \"accepted Everything passed.\"."
    );
  });
});

function completeTemplate(
  kind: "architecture-brief" | "architecture-plan" | "test-report" | "docs-update-report" | "docs-sync-report" | "final-acceptance",
  content: string
): string {
  const completed = content.replaceAll("TBD", "None.");
  if (kind === "architecture-brief") {
    return completed.replace(
      "Architecture Brief Status: interviewing|confirmed",
      "Architecture Brief Status: confirmed"
    );
  }
  if (kind === "test-report") {
    return completeL3NotRequired(completed)
      .replace("Test Result: pass|fail|incomplete", "Test Result: pass");
  }
  if (kind === "final-acceptance") {
    return completed.replace(
      "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision",
      "accepted"
    );
  }
  if (kind === "architecture-plan") {
    return completed.replace(
      "Planning Result: complete|incomplete|user clarification required",
      "Planning Result: complete"
    );
  }
  if (kind === "docs-update-report" || kind === "docs-sync-report") {
    return completed.replace("synced|unchanged|blocked", "unchanged");
  }
  return completed;
}

function completeL3NotRequired(content: string): string {
  return content
    .replace(
      "Status: none|repair-required|repaired|production-change-required",
      "Status: none"
    )
    .replace("L3 Required: yes|no", "L3 Required: no")
    .replaceAll("TBD", "None.")
    .replace(
      "### Trigger Assessment\n\nNone.",
      "### Trigger Assessment\n\nNo mandatory L3 trigger applies."
    )
    .replace(
      "### Not-Required Evidence\n\nNone.",
      "### Not-Required Evidence\n\nNo mandatory L3 trigger applies because the change is fully proved at L2."
    );
}
