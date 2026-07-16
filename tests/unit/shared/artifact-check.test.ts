import { describe, expect, it } from "vitest";
import {
  renderArchitecturePlanTemplate,
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

## Commands Run Or Checked
Checked.

## Validation Results
Passed.

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
`);
    expect(result.status).toBe("ok");
    expect(result.hasPlaceholder).toBe(false);
  });

  it("requires Scaffold Manifest in architecture plans", () => {
    const result = checkMarkdownArtifact("architecture-plan", "architecture-plan.md", `
# Architecture Plan

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

  it("requires code-reading evidence and explicit architecture decisions", () => {
    const result = checkMarkdownArtifact("architecture-plan", "architecture-plan.md", `
# Architecture Plan

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
    const content = renderTestReportTemplate("demo").replaceAll("TBD", "None.");
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain("Test Result must be pass or fail.");
  });

  it("rejects pass test reports with blocking validation issues", () => {
    const content = renderTestReportTemplate("demo")
      .replace("Test Result: pass|fail", "Test Result: pass")
      .replaceAll("TBD", "None.")
      .replace("## Blocking Validation Issues\n\nNone.", "## Blocking Validation Issues\n\nMissing E2E coverage.");
    const result = checkMarkdownArtifact("test-report", "test-report.md", content);

    expect(result.status).toBe("incomplete");
    expect(result.invalidFields).toContain(
      "Blocking Validation Issues must be None when Test Result is pass."
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
    expect(result.invalidFields[0]).toContain("synced, unchanged, blocked");
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
      ["architecture-plan", renderArchitecturePlanTemplate("demo")],
      ["test-report", renderTestReportTemplate("demo")],
      ["final-acceptance", renderFinalAcceptanceTemplate("demo")]
    ] as const;

    for (const [kind, content] of templates) {
      const completed = completeTemplate(kind, content);
      const result = checkMarkdownArtifact(kind, `${kind}.md`, completed);
      expect(result.missingHeadings, kind).toEqual([]);
      expect(result.status, kind).toBe("ok");
    }
  });
});

function completeTemplate(kind: "architecture-plan" | "test-report" | "final-acceptance", content: string): string {
  const completed = content.replaceAll("TBD", "None.");
  if (kind === "test-report") {
    return completed.replace("Test Result: pass|fail", "Test Result: pass");
  }
  if (kind === "final-acceptance") {
    return completed.replace("## Decision\n\nNone.", "## Decision\n\naccepted");
  }
  return completed;
}
