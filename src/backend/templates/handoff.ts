import {
  ARCHITECT_DEBUG_DISPOSITIONS,
  ARCHITECT_DEBUG_STATUSES,
  ARCHITECTURE_BRIEF_STATUSES,
  ARCHITECTURE_DIAGNOSIS_DISPOSITIONS,
  ARCHITECTURE_EVIDENCE_STATUSES,
  ARCHITECTURE_PLAN_RESULTS,
  CODER_COMPLETION_DECISIONS,
  DOCS_REPORT_DECISIONS,
  FINAL_ACCEPTANCE_DECISIONS,
  L3_ACTIONS,
  L3_REQUIRED_VALUES,
  PLANNING_PROGRESS_STATUSES,
  STRICT_NONE_VALUE,
  TEST_INFRASTRUCTURE_STATUSES,
  TEST_RESULTS,
  renderArtifactOptions
} from "../../shared/validation/artifact-contract.js";

const CURRENT_HANDOFF_NOTICE = "<!-- VCM current handoff: replace this file with one complete, self-contained snapshot of the current result. Restate all still-relevant evidence; do not refer to a prior revision, route message, Session, or transcript as evidence. -->";

export function renderArchitectureBriefTemplate(taskSlug: string): string {
  return `# Architecture Brief: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

Architecture Brief Status: ${renderArtifactOptions(ARCHITECTURE_BRIEF_STATUSES)}

## Accepted Outcome

TBD

## Confirmed User Decisions

TBD

## Existing Constraints

TBD

## Unresolved User Decisions

${STRICT_NONE_VALUE}

## User Confirmation

TBD
`;
}

export function renderArchitecturePlanTemplate(taskSlug: string): string {
  return `# Architecture Plan: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

Planning Result: ${renderArtifactOptions(ARCHITECTURE_PLAN_RESULTS)}

## Accepted Scope

TBD

## Current Code Reality

### Planning Boundary

TBD

### Code Reading Evidence

| File / Symbol | Called By | Calls / Consumers | State / Side Effects | Verified Behavior |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD |

### Existing Behavior Trace

TBD

### Code / Docs Conflicts

TBD

## Architecture Decision

### Changed Behavior Flow

TBD

### Ownership

TBD

### Data Flow

TBD

### Lifecycle

TBD

### Boundaries

TBD

### Invariants

TBD

### Failure Model

TBD

### Decision Rationale

TBD

## Module/File Plan

TBD

## Public Surface Impact

TBD

## Scaffold Manifest

Task-specific context and coder guidance go here, not in source-code comments.
Source-code comments should only describe durable behavior, contracts, invariants,
error boundaries, or non-obvious logic that should remain useful after this task.
Use an ID matching \`[A-Z]{2,6}-[0-9]{1,4}\`, choose exactly one Action
(\`create\`, \`change\`, or \`delete\`), put the repo-relative File path in
backticks, and enumerate every implementation item explicitly.
When no scaffold item exists, replace the table with exactly \`No scaffold items.\`;
an empty table is invalid.

| ID | Action | File | Symbol Or Site | Coder Work | Allowed Implementation Freedom | Behavior / Contract Proof Point |
| --- | --- | --- | --- | --- | --- | --- |
| <ID> | <create|change|delete> | \`<repo-relative-file>\` | TBD | TBD | TBD | TBD |

## Scaffold Build Evidence

| Check | Command | Result | Scaffold Commit |
| --- | --- | --- | --- |
| TBD | TBD | TBD | TBD |

## Tester Coverage Hints

TBD

## Docs Impact

TBD

## Known Risks

TBD

## Coder Handoff Notes

TBD
`;
}

export function renderArchitectureEvidenceTemplate(taskSlug: string): string {
  return `# Architecture Evidence: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

Architecture Evidence Status: ${renderArtifactOptions(ARCHITECTURE_EVIDENCE_STATUSES)}

## Planning Boundary

TBD

## Entry Points And Behavior Paths

TBD

## State And Lifecycle

TBD

## Callers And Consumers

TBD

## Existing Assumptions

TBD

## Related Class Inventories

TBD

## External Boundaries

TBD

## Code And Docs Conflicts

TBD

## Evidence Commands

TBD
`;
}

export function renderPlanningProgressTemplate(taskSlug: string): string {
  return `# Planning Progress: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

Planning Progress Status: ${renderArtifactOptions(PLANNING_PROGRESS_STATUSES)}

## Planning Steps

| Step | Scope | Deliverable | Done Criterion | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| Architecture Evidence Verification | TBD | TBD | TBD | pending | TBD |
`;
}

export function renderKnownIssuesTemplate(taskSlug: string): string {
  return `# Known Issues: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

## Task Issues

No unresolved task issues recorded yet.

## Escalation To Docs

At task close, promote still-relevant confirmed issues to \`docs/known-issues.md\`; delete this task-local file with the rest of \`.ai/vcm/\` runtime state.
`;
}

export function renderTestReportTemplate(taskSlug: string): string {
  return `# Test Report: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

Test Result: ${renderArtifactOptions(TEST_RESULTS)}

## Evidence Reviewed

TBD

## Tests Added Or Updated

TBD

## Coverage Mapping

TBD

## Validation Progress

### Completed Validation

TBD

### Remaining Validation

${STRICT_NONE_VALUE}

## L3 Coverage

L3 Required: ${renderArtifactOptions(L3_REQUIRED_VALUES)}

### Trigger Assessment

TBD

### Affected End-To-End Flows

| Flow | Trigger | Case ID | Test File | Entry Point | Final Observable Result | Action | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD | TBD | <${renderArtifactOptions(L3_ACTIONS)}> | TBD |

### L3 Commands And Evidence

TBD

### Not-Required Evidence

TBD

## Commands Run Or Checked

TBD

## Validation Results

TBD

## Test Infrastructure

Status: ${renderArtifactOptions(TEST_INFRASTRUCTURE_STATUSES)}

### Affected Files

${STRICT_NONE_VALUE}

### Boundary Evidence

${STRICT_NONE_VALUE}

### Defect-Class Sweep

${STRICT_NONE_VALUE}

### Repair Commit

${STRICT_NONE_VALUE}

## Failed Expectations

${STRICT_NONE_VALUE}

## Reproduction Steps

${STRICT_NONE_VALUE}

## Skipped Checks With Reasons

${STRICT_NONE_VALUE}

## Coverage Gaps

${STRICT_NONE_VALUE}

## Blocking Validation Issues

${STRICT_NONE_VALUE}

## User Approval Evidence

${STRICT_NONE_VALUE}
`;
}

export function renderCoderCompletionTemplate(taskSlug: string): string {
  return `# Coder Completion: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

Decision: ${renderArtifactOptions(CODER_COMPLETION_DECISIONS)}

## Scaffold Completion

| ID | Action | Result | Marker State | Proof Evidence |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD |

## Changed Files

TBD

## Private Helpers Added

TBD

## Manifest Deviations

TBD

## Generated Context

TBD

## Baseline Tests Added Or Updated

TBD

## L0/L1 Validation

TBD

## Worker Results

TBD

## Objective Failures

TBD
`;
}

export function renderArchitectDebugTemplate(taskSlug: string): string {
  return `# Architect Debug: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

Status: ${renderArtifactOptions(ARCHITECT_DEBUG_STATUSES)}

## PM-Routed Failure

TBD

## Confirmed Root Cause

TBD

## Implementation

TBD

## Changed Files And Public Surface

TBD

## Baseline Tests

TBD

## Diagnostic And L0/L1 Validation

TBD

## L2/L3 Validation

| Level | Applicable | Command Or Test | Failure Path | Result | Evidence |
|---|---|---|---|---|---|
| L2 | TBD | TBD | TBD | TBD | TBD |
| L3 | TBD | TBD | TBD | TBD | TBD |

## Generated Context

TBD

## Remaining Failure Evidence

TBD

## Final Disposition

${renderArtifactOptions(ARCHITECT_DEBUG_DISPOSITIONS)}
`;
}

export function renderArchitectureDiagnosisTemplate(taskSlug: string): string {
  return `# Architecture Diagnosis: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

## Diagnosis Boundary

TBD

## Documents And Runtime Evidence

TBD

## Code Reading Closure

TBD

## Current Architecture

TBD

## Previous Debug Failure

TBD

## Failure Trace

TBD

## Architecture Assessment

TBD

## Required Architecture Direction

TBD

## Implementation And Validation

### Changed Files And Public Surface

TBD

### Baseline Tests

TBD

### Diagnostic And L0/L1 Validation

TBD

### L2/L3 Validation

| Level | Applicable | Command Or Test | Failure Path | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| L2 | TBD | TBD | TBD | TBD | TBD |
| L3 | TBD | TBD | TBD | TBD | TBD |

### Generated Context

TBD

### Commit

TBD

## Final Disposition

${renderArtifactOptions(ARCHITECTURE_DIAGNOSIS_DISPOSITIONS)}
`;
}

export function renderDocsSyncReportTemplate(taskSlug: string): string {
  return `# Docs Sync Report: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

## Summary

TBD

## Architecture Drift Check

TBD

## Docs Updated

TBD

## Docs Reviewed And Left Unchanged

TBD

## Public Contract / Module Boundary Notes

TBD

## Remaining Documentation Risks

TBD

## Known Issues Disposition

TBD

## Decision

${renderArtifactOptions(DOCS_REPORT_DECISIONS)}
`;
}

export function renderDocsUpdateReportTemplate(taskSlug: string, assignmentId = "docs-only"): string {
  return `# Docs Update Report: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

## Summary

TBD

## Assignment ID

${assignmentId}

## Documents Updated

TBD

## Documents Reviewed And Left Unchanged

TBD

## Evidence Reviewed

TBD

## Checks Performed

TBD

## Commit

TBD

## Remaining Documentation Issues

TBD

## Decision

${renderArtifactOptions(DOCS_REPORT_DECISIONS)}
`;
}

export function renderWorkflowProgressTemplate(taskSlug: string): string {
  return `# Workflow Progress: ${taskSlug}

Revision: 0
Flow: none
Status: not-started

## Dispatch History

none

## Proposed Dispatch

Requested Flow: none
Target Role: none
Evidence: none

## User Authorization

Authorization Text: none
Violated Rule: none
`;
}

export function renderFinalAcceptanceTemplate(taskSlug: string): string {
  return `# Final Acceptance: ${taskSlug}

${CURRENT_HANDOFF_NOTICE}

## Decision

${renderArtifactOptions(FINAL_ACCEPTANCE_DECISIONS)}

## Evidence Reviewed

TBD

## Scope Traceability

### Expected Files

TBD

### Supporting Files

TBD

### Approved Deviations

TBD

### Unexplained Files

TBD

### High-Risk Unexpected Files

TBD

## Validation Summary

TBD

## Review And Docs Sync

TBD

## Known Issues Disposition

TBD

## Gate Review Gates

TBD

## Cleanup Readiness

TBD

## Final User Summary

TBD
`;
}

export function renderMessageRouteTemplate(): string {
  return "";
}
