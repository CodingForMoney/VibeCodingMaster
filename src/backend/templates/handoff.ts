export function renderArchitecturePlanTemplate(taskSlug: string): string {
  return `# Architecture Plan: ${taskSlug}

## Context

TBD

## Architecture Decision

TBD

## Implementation Plan

TBD

## Risks

TBD

## Stop Conditions

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

export function renderReviewReportTemplate(taskSlug: string): string {
  return `# Review Report: ${taskSlug}

## Summary

TBD

## Findings

TBD

## Validation

TBD

## Decision

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

### Expected Changes

TBD

### Supporting Changes

TBD

### Approved Deviations

TBD

### Unexplained Changes

TBD

### High-Risk Unexpected Changes

TBD

## Validation Summary

TBD

## Review And Docs Sync

TBD

## Known Issues Disposition

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
