import type { ArtifactCheckResult, ArtifactKind } from "../types/artifact.js";

const REQUIRED_HEADINGS: Record<ArtifactKind, readonly string[]> = {
  "architecture-plan": [
    "Context",
    "Architecture Decision",
    "Implementation Plan",
    "Risks",
    "Stop Conditions"
  ],
  "known-issues": [
    "Task Issues",
    "Escalation To Docs"
  ],
  "review-report": [
    "Summary",
    "Findings",
    "Validation",
    "Decision"
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
      status: "empty"
    };
  }

  const missingHeadings = REQUIRED_HEADINGS[kind].filter((heading) => !hasHeading(trimmed, heading));
  const hasPlaceholder = PLACEHOLDER_PATTERN.test(trimmed);

  return {
    kind,
    path: artifactPath,
    exists: true,
    isEmpty: false,
    hasPlaceholder,
    missingHeadings,
    status: missingHeadings.length === 0 && !hasPlaceholder ? "ok" : "incomplete"
  };
}

function hasHeading(content: string, heading: string): boolean {
  const pattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, "im");
  return pattern.test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
