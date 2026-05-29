import type { ArtifactCheckResult, ArtifactKind } from "../types/artifact.js";

const REQUIRED_HEADINGS: Record<ArtifactKind, readonly string[]> = {
  "architecture-plan": [
    "Context",
    "Architecture Decision",
    "Implementation Plan",
    "Risks",
    "Stop Conditions"
  ],
  "implementation-log": [
    "Summary",
    "Files Changed",
    "Validation",
    "Deviations From Architecture Plan",
    "Follow-ups"
  ],
  "validation-log": [
    "Validation"
  ],
  "review-report": [
    "Summary",
    "Findings",
    "Validation",
    "Decision"
  ]
};

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
      missingHeadings: [...REQUIRED_HEADINGS[kind]],
      status: "empty"
    };
  }

  const missingHeadings = REQUIRED_HEADINGS[kind].filter((heading) => !hasHeading(trimmed, heading));

  return {
    kind,
    path: artifactPath,
    exists: true,
    isEmpty: false,
    missingHeadings,
    status: missingHeadings.length === 0 ? "ok" : "incomplete"
  };
}

function hasHeading(content: string, heading: string): boolean {
  const pattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, "im");
  return pattern.test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
