import type { ArtifactCheckResult, ArtifactKind } from "../types/artifact.js";

const REQUIRED_HEADINGS: Record<ArtifactKind, readonly string[]> = {
  "architecture-plan": [
    "Accepted Scope",
    "Current Code Reality",
    "Planning Boundary",
    "Code Reading Evidence",
    "Existing Behavior Trace",
    "Code / Docs Conflicts",
    "Architecture Decision",
    "Changed Behavior Flow",
    "Ownership",
    "Data Flow",
    "Lifecycle",
    "Boundaries",
    "Invariants",
    "Failure Model",
    "Decision Rationale",
    "Module/File Plan",
    "Public Surface Impact",
    "Scaffold Manifest",
    "Tester Coverage Hints",
    "Docs Impact",
    "Known Risks",
    "Coder Handoff Notes"
  ],
  "known-issues": [
    "Task Issues",
    "Escalation To Docs"
  ],
  "test-report": [
    "Evidence Reviewed",
    "Tests Added Or Updated",
    "Commands Run Or Checked",
    "Validation Results",
    "Failed Expectations",
    "Reproduction Steps",
    "Skipped Checks With Reasons",
    "Coverage Gaps",
    "Blocking Validation Issues"
  ],
  "docs-sync-report": [
    "Summary",
    "Architecture Drift Check",
    "Docs Updated",
    "Docs Reviewed And Left Unchanged",
    "Public Contract / Module Boundary Notes",
    "Remaining Documentation Risks",
    "Known Issues Disposition",
    "Decision"
  ],
  "final-acceptance": [
    "Decision",
    "Evidence Reviewed",
    "Scope Traceability",
    "Validation Summary",
    "Review And Docs Sync",
    "Known Issues Disposition",
    "Gate Review Gates",
    "Cleanup Readiness",
    "Final User Summary"
  ]
};

const PLACEHOLDER_PATTERN = /(^|\n)\s*(TBD|Not run yet\.?|status:\s*draft)\s*(\n|$)/i;

export function checkMarkdownArtifact(
  kind: ArtifactKind,
  artifactPath: string,
  content: string | null
): ArtifactCheckResult {
  if (content === null) {
    return {
      kind,
      path: artifactPath,
      exists: false,
      isEmpty: true,
      hasPlaceholder: false,
      missingHeadings: [...REQUIRED_HEADINGS[kind]],
      invalidFields: [],
      status: "missing"
    };
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return {
      kind,
      path: artifactPath,
      exists: true,
      isEmpty: true,
      hasPlaceholder: false,
      missingHeadings: [...REQUIRED_HEADINGS[kind]],
      invalidFields: [],
      status: "empty"
    };
  }

  const missingHeadings = REQUIRED_HEADINGS[kind].filter((heading) => !hasHeading(trimmed, heading));
  const hasPlaceholder = PLACEHOLDER_PATTERN.test(trimmed);
  const invalidFields = validateArtifactFields(kind, trimmed);

  return {
    kind,
    path: artifactPath,
    exists: true,
    isEmpty: false,
    hasPlaceholder,
    missingHeadings,
    invalidFields,
    status: missingHeadings.length === 0 && !hasPlaceholder && invalidFields.length === 0 ? "ok" : "incomplete"
  };
}

function validateArtifactFields(kind: ArtifactKind, content: string): string[] {
  if (kind === "test-report") {
    const result = /^\s*Test Result\s*:\s*(\S+)\s*$/im.exec(content)?.[1]?.toLowerCase();
    return result === "pass" || result === "fail"
      ? []
      : ["Test Result must be pass or fail."];
  }

  if (kind === "docs-sync-report") {
    return validateDecision(content, ["synced", "unchanged", "blocked"]);
  }

  if (kind === "final-acceptance") {
    return validateDecision(content, [
      "accepted",
      "accepted-with-known-risks",
      "needs-coder-follow-up",
      "needs-architect-follow-up",
      "needs-docs-sync",
      "blocked-by-user-decision"
    ]);
  }

  return [];
}

function validateDecision(content: string, allowed: string[]): string[] {
  const decision = readArtifactSectionValue(content, "Decision")?.toLowerCase();
  return decision && allowed.includes(decision)
    ? []
    : [`Decision must be one of: ${allowed.join(", ")}.`];
}

export function readArtifactSectionValue(content: string, heading: string): string | undefined {
  const match = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, "im").exec(content);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const afterHeading = content.slice(match.index + match[0].length);
  const nextHeading = /\n#{1,6}\s+\S/.exec(afterHeading);
  const section = nextHeading?.index === undefined
    ? afterHeading
    : afterHeading.slice(0, nextHeading.index);
  return section.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function hasHeading(content: string, heading: string): boolean {
  const pattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, "im");
  return pattern.test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
