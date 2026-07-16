export function renderArchitecturePlanTemplate(taskSlug: string): string {
  return `# Architecture Plan: ${taskSlug}

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

| ID | File / Action | Current Evidence / Why In Scope | Coder Work | Allowed Freedom | Expected VCM:CODE | Durable Comment Needs | Behavior / Contract Proof Points |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SCF-001 | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

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

export function renderKnownIssuesTemplate(taskSlug: string): string {
  return `# Known Issues: ${taskSlug}

## Task Issues

No unresolved task issues recorded yet.

## Escalation To Docs

At task close, promote still-relevant confirmed issues to \`docs/known-issues.md\`; delete this task-local file with the rest of \`.ai/vcm/\` runtime state.
`;
}

export function renderTestReportTemplate(taskSlug: string): string {
  return `# Test Report: ${taskSlug}

Test Result: pass|fail

## Evidence Reviewed

TBD

## Tests Added Or Updated

TBD

## Commands Run Or Checked

TBD

## Validation Results

TBD

## Failed Expectations

TBD

## Reproduction Steps

TBD

## Skipped Checks With Reasons

TBD

## Coverage Gaps

TBD

## Blocking Validation Issues

TBD
`;
}

export function renderCoderCompletionTemplate(taskSlug: string): string {
  return `# Coder Completion: ${taskSlug}

Decision: ready_for_review|incomplete|failed

## Scaffold Completion

TBD

## Remaining Markers

TBD

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

export function renderDocsSyncReportTemplate(taskSlug: string): string {
  return `# Docs Sync Report: ${taskSlug}

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

TBD
`;
}

export function renderFinalAcceptanceTemplate(taskSlug: string): string {
  return `# Final Acceptance: ${taskSlug}

## Decision

TBD

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
