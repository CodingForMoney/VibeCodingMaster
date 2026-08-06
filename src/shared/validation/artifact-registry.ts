import type { ArtifactKind } from "../types/artifact.js";
import type { RoleName } from "../types/role.js";

export interface ArtifactDefinition {
  kind: ArtifactKind;
  fileName: string;
  owner: RoleName;
  requiredHeadings: readonly string[];
}

export const ARTIFACT_DEFINITIONS: readonly ArtifactDefinition[] = [
  {
    kind: "architecture-brief",
    fileName: "architecture-brief.md",
    owner: "architect",
    requiredHeadings: [
      "Accepted Outcome",
      "Confirmed User Decisions",
      "Existing Constraints",
      "Unresolved User Decisions",
      "User Confirmation"
    ]
  },
  {
    kind: "architecture-evidence",
    fileName: "architecture-evidence.md",
    owner: "architect",
    requiredHeadings: [
      "Planning Boundary",
      "Entry Points And Behavior Paths",
      "State And Lifecycle",
      "Callers And Consumers",
      "Existing Assumptions",
      "Related Class Inventories",
      "External Boundaries",
      "Code And Docs Conflicts",
      "Evidence Commands"
    ]
  },
  {
    kind: "planning-progress",
    fileName: "planning-progress.md",
    owner: "architect",
    requiredHeadings: ["Planning Steps"]
  },
  {
    kind: "architecture-plan",
    fileName: "architecture-plan.md",
    owner: "architect",
    requiredHeadings: [
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
      "Scaffold Build Evidence",
      "Tester Coverage Hints",
      "Docs Impact",
      "Known Risks",
      "Coder Handoff Notes"
    ]
  },
  {
    kind: "known-issues",
    fileName: "known-issues.md",
    owner: "architect",
    requiredHeadings: ["Task Issues", "Escalation To Docs"]
  },
  {
    kind: "coder-completion",
    fileName: "coder-completion.md",
    owner: "coder",
    requiredHeadings: [
      "Scaffold Completion",
      "Changed Files",
      "Private Helpers Added",
      "Manifest Deviations",
      "Generated Context",
      "Baseline Tests Added Or Updated",
      "L0/L1 Validation",
      "Worker Results",
      "Objective Failures"
    ]
  },
  {
    kind: "architect-debug",
    fileName: "architect-debug.md",
    owner: "architect",
    requiredHeadings: [
      "PM-Routed Failure",
      "Confirmed Root Cause",
      "Implementation",
      "Changed Files And Public Surface",
      "Baseline Tests",
      "Diagnostic And L0/L1 Validation",
      "L2/L3 Validation",
      "Generated Context",
      "Remaining Failure Evidence",
      "Final Disposition"
    ]
  },
  {
    kind: "architecture-diagnosis",
    fileName: "architecture-diagnosis.md",
    owner: "architect",
    requiredHeadings: [
      "Diagnosis Boundary",
      "Documents And Runtime Evidence",
      "Code Reading Closure",
      "Current Architecture",
      "Previous Debug Failure",
      "Failure Trace",
      "Architecture Assessment",
      "Required Architecture Direction",
      "Implementation And Validation",
      "Changed Files And Public Surface",
      "Baseline Tests",
      "Diagnostic And L0/L1 Validation",
      "L2/L3 Validation",
      "Generated Context",
      "Commit",
      "Final Disposition"
    ]
  },
  {
    kind: "test-report",
    fileName: "test-report.md",
    owner: "tester",
    requiredHeadings: [
      "Evidence Reviewed",
      "Tests Added Or Updated",
      "Coverage Mapping",
      "Validation Progress",
      "Completed Validation",
      "Remaining Validation",
      "L3 Coverage",
      "Trigger Assessment",
      "Affected End-To-End Flows",
      "L3 Commands And Evidence",
      "Not-Required Evidence",
      "Commands Run Or Checked",
      "Validation Results",
      "Test Infrastructure",
      "Affected Files",
      "Boundary Evidence",
      "Defect-Class Sweep",
      "Repair Commit",
      "Failed Expectations",
      "Reproduction Steps",
      "Skipped Checks With Reasons",
      "Coverage Gaps",
      "Blocking Validation Issues",
      "User Approval Evidence"
    ]
  },
  {
    kind: "docs-sync-report",
    fileName: "docs-sync-report.md",
    owner: "architect",
    requiredHeadings: [
      "Summary",
      "Architecture Drift Check",
      "Docs Updated",
      "Docs Reviewed And Left Unchanged",
      "Public Contract / Module Boundary Notes",
      "Remaining Documentation Risks",
      "Known Issues Disposition",
      "Decision"
    ]
  },
  {
    kind: "final-acceptance",
    fileName: "final-acceptance.md",
    owner: "project-manager",
    requiredHeadings: [
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
  }
] as const;

const DEFINITION_BY_KIND = new Map(ARTIFACT_DEFINITIONS.map((definition) => [definition.kind, definition]));

export function getArtifactDefinition(kind: ArtifactKind): ArtifactDefinition {
  const definition = DEFINITION_BY_KIND.get(kind);
  if (!definition) {
    throw new Error(`Unknown artifact kind: ${kind}`);
  }
  return definition;
}

export function isArtifactKind(value: string): value is ArtifactKind {
  return DEFINITION_BY_KIND.has(value as ArtifactKind);
}
