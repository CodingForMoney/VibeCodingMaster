import { describe, expect, it } from "vitest";
import { validateMemoryReviewReport } from "../../../src/backend/services/memory-review-validation.js";

const ROLES = ["project-manager", "architect", "coder", "tester"] as const;

describe("memory-review-validation", () => {
  it("accepts a complete auditable memory review block", () => {
    expect(validateMemoryReviewReport([
      "# Task Harness Retrospective",
      "",
      "## Memory Review",
      "Existing memory reviewed: complete",
      "",
      "### Proposal Dispositions",
      "- project-manager: no-change",
      "- architect: accepted",
      "- coder: rejected",
      "- tester: no-change",
      "",
      "### Existing Memory Changes",
      "- retained: verified lifecycle ownership",
      "- updated: one stale command",
      "- removed: none",
      "",
      "Reviewed memory set: complete",
      "",
      "## Findings",
      "none",
      ""
    ].join("\n"), [...ROLES])).toBeUndefined();
  });

  it("rejects a generic report without the memory review block", () => {
    expect(validateMemoryReviewReport(
      "# Task Harness Retrospective\n\nMemory reviewed.\n",
      [...ROLES]
    )).toContain("missing the ## Memory Review section");
  });

  it("rejects a report that omits a proposal disposition", () => {
    expect(validateMemoryReviewReport([
      "## Memory Review",
      "Existing memory reviewed: complete",
      "",
      "### Proposal Dispositions",
      "- project-manager: no-change",
      "- architect: accepted",
      "- coder: rejected",
      "",
      "### Existing Memory Changes",
      "- retained: verified entries",
      "- updated: none",
      "- removed: none",
      "",
      "Reviewed memory set: complete",
      ""
    ].join("\n"), [...ROLES])).toContain("disposition for tester");
  });

  it("rejects an empty existing-memory change summary", () => {
    expect(validateMemoryReviewReport([
      "## Memory Review",
      "Existing memory reviewed: complete",
      "",
      "### Proposal Dispositions",
      "- project-manager: no-change",
      "- architect: no-change",
      "- coder: no-change",
      "- tester: no-change",
      "",
      "### Existing Memory Changes",
      "- retained:",
      "- updated: none",
      "- removed: none",
      "",
      "Reviewed memory set: complete",
      ""
    ].join("\n"), [...ROLES])).toContain("non-empty retained summary");
  });
});
