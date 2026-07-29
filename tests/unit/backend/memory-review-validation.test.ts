import { describe, expect, it } from "vitest";
import {
  type MemoryReviewCandidate,
  parseMemoryReviewReport,
  validateMemoryReviewOutput,
  validateMemoryReviewReport
} from "../../../src/backend/services/memory-review-validation.js";

const CANDIDATES: MemoryReviewCandidate[] = [
  {
    id: "architect:add:1",
    source: "architect",
    operation: "add",
    target: "shared",
    content: "Backend hooks own lifecycle completion."
  },
  {
    id: "coder:remove:1",
    source: "coder",
    operation: "remove",
    target: "coder",
    existing: "Frontend polling owns lifecycle completion."
  }
];

describe("memory-review-validation", () => {
  it("accepts a complete item-level memory review block", () => {
    expect(validateMemoryReviewReport(
      renderReport(renderProposalDecisions()),
      CANDIDATES,
      true
    )).toBeUndefined();
  });

  it("rejects a generic report without the memory review block", () => {
    expect(validateMemoryReviewReport(
      "# Task Harness Retrospective\n\nMemory reviewed.\n",
      CANDIDATES
    )).toContain("missing the ## Memory Review section");
  });

  it("rejects a report that omits a candidate decision", () => {
    expect(validateMemoryReviewReport(
      renderReport(renderAddDecision()),
      CANDIDATES
    )).toContain("missing the proposal decision for coder:remove:1");
  });

  it("rejects a role-level blanket disposition", () => {
    expect(validateMemoryReviewReport(
      renderReport("- architect: accepted"),
      CANDIDATES
    )).toContain("one #### Candidate <id> block per memory candidate");
  });

  it("rejects an Add decision without independent necessity analysis", () => {
    const decision = renderAddDecision().replace(
      "Why memory is necessary: Workflow roles need one lifecycle owner across tasks.\n",
      ""
    );
    expect(validateMemoryReviewReport(
      renderReport(`${decision}\n\n${renderRemoveDecision()}`),
      CANDIDATES
    )).toContain("Why memory is necessary");
  });

  it("rejects an unfilled review placeholder", () => {
    const decision = renderAddDecision().replace(
      "Why memory is necessary: Workflow roles need one lifecycle owner across tasks.",
      "Why memory is necessary: <independent reason>"
    );
    expect(validateMemoryReviewReport(
      renderReport(`${decision}\n\n${renderRemoveDecision()}`),
      CANDIDATES
    )).toContain("replace every review placeholder");
  });

  it("rejects a candidate block that does not match the proposal", () => {
    const decision = renderAddDecision().replace(
      "Candidate: Backend hooks own lifecycle completion.",
      "Candidate: Frontend polling owns lifecycle completion."
    );
    expect(validateMemoryReviewReport(
      renderReport(`${decision}\n\n${renderRemoveDecision()}`),
      CANDIDATES
    )).toContain("does not match its source proposal");
  });

  it("requires none when no proposal candidate exists", () => {
    expect(validateMemoryReviewReport(
      renderReport("none"),
      []
    )).toBeUndefined();
    expect(validateMemoryReviewReport(
      renderReport(renderAddDecision()),
      []
    )).toContain("must be none when no memory candidate exists");
  });

  it("rejects an empty existing-memory change summary", () => {
    expect(validateMemoryReviewReport(
      renderReport(renderProposalDecisions()).replace("- retained: verified entries", "- retained:"),
      CANDIDATES
    )).toContain("non-empty retained summary");
  });

  it("rejects none when substantive existing memory is present", () => {
    expect(validateMemoryReviewReport(
      renderReport(renderProposalDecisions(), "none"),
      CANDIDATES,
      true
    )).toContain("cannot be none while substantive existing memory is present");
  });

  it("rejects reviewed output that omits accepted final content", async () => {
    const decisions = parseMemoryReviewReport(
      renderReport(renderProposalDecisions()),
      CANDIDATES,
      true
    ).decisions!;
    await expect(validateMemoryReviewOutput({
      before: memorySet({
        shared: "Backend lifecycle state is inferred by clients.",
        coder: "Frontend polling owns lifecycle completion."
      }),
      after: memorySet({ shared: "Unrelated memory." }),
      decisions,
      durableDocExists: async () => true
    })).resolves.toContain("exact Final content for architect:add:1");
  });

  it("rejects reviewed output that writes a rejected candidate", async () => {
    const report = renderReport(
      renderProposalDecisions().replace(
        [
          "Decision: keep-in-memory",
          "Final target: shared"
        ].join("\n"),
        [
          "Decision: reject",
          "Final target: none"
        ].join("\n")
      ).replace(
        "Final content: Backend hooks own lifecycle completion.",
        "Final content: none"
      )
    );
    const decisions = parseMemoryReviewReport(report, CANDIDATES, true).decisions!;
    await expect(validateMemoryReviewOutput({
      before: memorySet({
        shared: "Backend lifecycle state is inferred by clients.",
        coder: "Frontend polling owns lifecycle completion."
      }),
      after: memorySet({ shared: "Backend hooks own lifecycle completion." }),
      decisions,
      durableDocExists: async () => true
    })).resolves.toContain("rejected or durable-doc-only candidate architect:add:1");
  });

  it("rejects a memory reference to a missing durable document", async () => {
    const report = renderReport(
      renderProposalDecisions()
        .replace("Decision: keep-in-memory", "Decision: keep-memory-reference")
        .replace("Durable doc disposition: memory", "Durable doc disposition: memory-reference")
        .replace("Durable doc path: none", "Durable doc path: docs/ARCHITECTURE.md")
    );
    const decisions = parseMemoryReviewReport(report, CANDIDATES, true).decisions!;
    await expect(validateMemoryReviewOutput({
      before: memorySet({
        shared: "Backend lifecycle state is inferred by clients.",
        coder: "Frontend polling owns lifecycle completion."
      }),
      after: memorySet({ shared: "Backend hooks own lifecycle completion." }),
      decisions,
      durableDocExists: async () => false
    })).resolves.toContain("missing durable document for architect:add:1");
  });

  it("allows a durable-doc decision to identify a follow-up path", async () => {
    const report = renderReport(
      renderProposalDecisions()
        .replace("Decision: keep-in-memory", "Decision: move-to-durable-doc")
        .replace("Final target: shared", "Final target: none")
        .replace("Durable doc disposition: memory", "Durable doc disposition: durable-doc")
        .replace("Durable doc path: none", "Durable doc path: docs/ARCHITECTURE.md")
        .replace(
          "Final content: Backend hooks own lifecycle completion.",
          "Final content: none"
        )
    );
    const decisions = parseMemoryReviewReport(report, CANDIDATES, true).decisions!;
    await expect(validateMemoryReviewOutput({
      before: memorySet({
        shared: "Backend lifecycle state is inferred by clients.",
        coder: "Frontend polling owns lifecycle completion."
      }),
      after: memorySet(),
      decisions,
      durableDocExists: async () => false
    })).resolves.toBeUndefined();
  });

  it("allows a rejected duplicate when another reviewed candidate keeps the same content", async () => {
    await expect(validateMemoryReviewOutput({
      before: memorySet(),
      after: memorySet({ shared: "Backend hooks own lifecycle completion." }),
      decisions: [
        {
          candidateId: "architect-planning:add:1",
          source: "architect-planning",
          operation: "add",
          target: "shared",
          candidate: "Backend hooks own lifecycle completion.",
          decision: "reject",
          finalTarget: "none",
          whyMemoryIsNecessary: "The duplicate does not need a second entry.",
          impactIfAbsent: "No impact because the final Architect candidate retains it.",
          durableDocDisposition: "memory",
          durableDocAnalysis: "The retained duplicate is concise cross-task memory.",
          durableDocPath: "none",
          evidenceChecked: ".ai/vcm/handoffs/final-acceptance.md",
          finalContent: "none"
        },
        {
          candidateId: "architect:add:1",
          source: "architect",
          operation: "add",
          target: "shared",
          candidate: "Backend hooks own lifecycle completion.",
          decision: "keep-in-memory",
          finalTarget: "shared",
          whyMemoryIsNecessary: "Workflow roles need one lifecycle owner.",
          impactIfAbsent: "Roles may infer completion independently.",
          durableDocDisposition: "memory",
          durableDocAnalysis: "This concise cross-task invariant belongs in memory.",
          durableDocPath: "none",
          evidenceChecked: "src/backend/services/claude-hook-service.ts",
          finalContent: "Backend hooks own lifecycle completion."
        }
      ],
      durableDocExists: async () => true
    })).resolves.toBeUndefined();
  });
});

function renderReport(
  proposalDecisions: string,
  existingDecisions = [
    "#### Item 1",
    "Target: shared",
    "Existing: Backend lifecycle state is inferred by clients.",
    "Decision: retain",
    "Reason: Workflow roles need one lifecycle owner across tasks.",
    "Impact if removed: Roles may infer completion independently.",
    "Durable doc disposition: memory",
    "Durable doc path: none",
    "Evidence: src/backend/services/claude-hook-service.ts"
  ].join("\n")
): string {
  return [
    "# Task Harness Retrospective",
    "",
    "## Memory Review",
    "Existing memory reviewed: complete",
    "",
    "### Proposal Decisions",
    proposalDecisions,
    "",
    "### Existing Memory Decisions",
    existingDecisions,
    "",
    "### Existing Memory Changes",
    "- retained: verified entries",
    "- updated: none",
    "- removed: none",
    "",
    "Reviewed memory set: complete",
    "",
    "## Findings",
    "none",
    ""
  ].join("\n");
}

function renderProposalDecisions(): string {
  return `${renderAddDecision()}\n\n${renderRemoveDecision()}`;
}

function renderAddDecision(): string {
  return [
    "#### Candidate architect:add:1",
    "Source: architect",
    "Operation: add",
    "Target: shared",
    "Candidate: Backend hooks own lifecycle completion.",
    "Decision: keep-in-memory",
    "Final target: shared",
    "Why memory is necessary: Workflow roles need one lifecycle owner across tasks.",
    "Impact if absent: Roles may infer completion independently.",
    "Durable doc disposition: memory",
    "Durable doc analysis: This concise cross-task invariant belongs in shared memory.",
    "Durable doc path: none",
    "Evidence checked: src/backend/services/claude-hook-service.ts",
    "Final content: Backend hooks own lifecycle completion."
  ].join("\n");
}

function renderRemoveDecision(): string {
  return [
    "#### Candidate coder:remove:1",
    "Source: coder",
    "Operation: remove",
    "Target: coder",
    "Existing: Frontend polling owns lifecycle completion.",
    "Decision: remove",
    "Reason: The statement contradicts the backend-owned lifecycle.",
    "Evidence checked: src/backend/services/claude-hook-service.ts"
  ].join("\n");
}

function memorySet(
  values: Partial<Record<keyof ReturnType<typeof emptyMemorySet>, string>>
): ReturnType<typeof emptyMemorySet> {
  return { ...emptyMemorySet(), ...values };
}

function emptyMemorySet() {
  return {
    shared: "",
    "project-manager": "",
    architect: "",
    coder: "",
    tester: "",
    reviewer: "",
    "harness-engineer": ""
  };
}
