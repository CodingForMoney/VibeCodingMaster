import { describe, expect, it } from "vitest";
import { checkMarkdownArtifact } from "../../../src/shared/validation/artifact-check.js";

describe("checkMarkdownArtifact", () => {
  it("reports missing artifacts", () => {
    const result = checkMarkdownArtifact("architecture-plan", "architecture-plan.md", null);
    expect(result.status).toBe("missing");
    expect(result.exists).toBe(false);
  });

  it("reports ok when required headings exist", () => {
    const result = checkMarkdownArtifact("review-report", "review-report.md", `
# Review Report

## Summary
Done

## Findings
None

## Validation
Checked

## Decision
Pass
`);
    expect(result.status).toBe("ok");
    expect(result.hasPlaceholder).toBe(false);
  });

  it("keeps placeholder artifacts incomplete", () => {
    const result = checkMarkdownArtifact("implementation-log", "implementation-log.md", `
# Implementation Log

## Summary
TBD

## Files Changed
TBD

## Validation
TBD

## Deviations From Architecture Plan
TBD

## Follow-ups
TBD
`);
    expect(result.status).toBe("incomplete");
    expect(result.hasPlaceholder).toBe(true);
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

## Decision
Pass.
`);
    expect(result.status).toBe("ok");
  });
});
