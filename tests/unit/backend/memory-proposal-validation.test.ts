import { describe, expect, it } from "vitest";
import { validateMemoryProposal } from "../../../src/backend/services/memory-proposal-validation.js";

describe("memory-proposal-validation", () => {
  it("accepts the exact no-change format", () => {
    expect(validateMemoryProposal([
      "# Memory Proposal",
      "Decision: no-change",
      "",
      "## Add",
      "none",
      "",
      "## Update",
      "none",
      "",
      "## Remove",
      "none",
      ""
    ].join("\n"))).toBeUndefined();
  });

  it("accepts structured add, update, and remove items", () => {
    expect(validateMemoryProposal([
      "# Memory Proposal",
      "Decision: update",
      "",
      "## Add",
      "### Item 1",
      "Target: shared",
      "Content: Backend hooks own lifecycle completion.",
      "Evidence: src/backend/services/claude-hook-service.ts",
      "",
      "## Update",
      "### Item 1",
      "Target: current-role",
      "Existing: Inspect lifecycle state.",
      "Content: Verify lifecycle state against backend hooks.",
      "Evidence: .ai/vcm/handoffs/final-acceptance.md",
      "",
      "## Remove",
      "### Item 1",
      "Target: current-role",
      "Existing: Frontend polling owns completion.",
      "Evidence: docs/ARCHITECTURE.md",
      ""
    ].join("\n"))).toBeUndefined();
  });

  it("rejects unstructured proposal prose", () => {
    expect(validateMemoryProposal([
      "# Memory Proposal",
      "Decision: update",
      "",
      "## Add",
      "Backend hooks own lifecycle completion.",
      "",
      "## Update",
      "none",
      "",
      "## Remove",
      "none",
      ""
    ].join("\n"))).toContain("Add must contain none or one or more ### Item N blocks");
  });

  it("rejects a no-change decision with proposed items", () => {
    expect(validateMemoryProposal([
      "# Memory Proposal",
      "Decision: no-change",
      "",
      "## Add",
      "### Item 1",
      "Target: shared",
      "Content: Backend hooks own lifecycle completion.",
      "Evidence: src/backend/services/claude-hook-service.ts",
      "",
      "## Update",
      "none",
      "",
      "## Remove",
      "none",
      ""
    ].join("\n"))).toContain("uses Decision: no-change but contains a memory item");
  });

  it("rejects an extra legacy evidence section", () => {
    expect(validateMemoryProposal([
      "# Memory Proposal",
      "Decision: no-change",
      "",
      "## Evidence",
      "none",
      "",
      "## Add",
      "none",
      "",
      "## Update",
      "none",
      "",
      "## Remove",
      "none",
      ""
    ].join("\n"))).toContain("must contain only the Add, Update, and Remove sections");
  });
});
