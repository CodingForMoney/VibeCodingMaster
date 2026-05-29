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
  });
});
