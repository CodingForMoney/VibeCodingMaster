import { describe, expect, it } from "vitest";
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

## Evidence Reviewed
Reviewed.

## Tests Added Or Updated
Updated.

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
Reviewed.

## Architecture Decision
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
Pass.
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
});
