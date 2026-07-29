import { describe, expect, it } from "vitest";
import {
  parseMemoryProposal,
  validateMemoryProposal
} from "../../../src/backend/services/memory-proposal-validation.js";

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
    const content = [
      "# Memory Proposal",
      "Decision: update",
      "",
      "## Add",
      "### Item 1",
      "Target: shared",
      "Content: Backend hooks own lifecycle completion.",
      "Reason: Workflow roles need the backend-owned completion rule across tasks.",
      "Impact if absent: Roles may infer completion independently.",
      "Durable doc disposition: memory",
      "Durable doc path: none",
      "Evidence: src/backend/services/claude-hook-service.ts",
      "",
      "## Update",
      "### Item 1",
      "Target: current-role",
      "Existing: Inspect lifecycle state.",
      "Content: Verify lifecycle state against backend hooks.",
      "Reason: The role must use the current lifecycle source of truth.",
      "Impact if absent: The role may follow stale frontend state.",
      "Durable doc disposition: memory-reference",
      "Durable doc path: docs/ARCHITECTURE.md",
      "Evidence: .ai/vcm/handoffs/final-acceptance.md",
      "",
      "## Remove",
      "### Item 1",
      "Target: current-role",
      "Existing: Frontend polling owns completion.",
      "Evidence: docs/ARCHITECTURE.md",
      ""
    ].join("\n");
    expect(validateMemoryProposal(content)).toBeUndefined();
    expect(parseMemoryProposal(content).proposal?.items).toEqual([
      expect.objectContaining({
        operation: "add",
        ordinal: 1,
        target: "shared",
        content: "Backend hooks own lifecycle completion."
      }),
      expect.objectContaining({
        operation: "update",
        ordinal: 1,
        target: "current-role",
        existing: "Inspect lifecycle state."
      }),
      expect.objectContaining({
        operation: "remove",
        ordinal: 1,
        target: "current-role",
        existing: "Frontend polling owns completion."
      })
    ]);
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
      "Reason: Workflow roles need the backend-owned completion rule across tasks.",
      "Impact if absent: Roles may infer completion independently.",
      "Durable doc disposition: memory",
      "Durable doc path: none",
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

  it("rejects an add without necessity and durable-document analysis", () => {
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
      "none",
      "",
      "## Remove",
      "none",
      ""
    ].join("\n"))).toContain("Reason, Impact if absent, Durable doc disposition");
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
