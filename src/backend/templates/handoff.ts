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

export function renderImplementationLogTemplate(taskSlug: string): string {
  return `# Implementation Log: ${taskSlug}

## Summary

TBD

## Files Changed

TBD

## Validation

TBD

## Deviations From Architecture Plan

TBD

## Follow-ups

TBD
`;
}

export function renderValidationLogTemplate(taskSlug: string): string {
  return `# Validation Log: ${taskSlug}

## Validation

Not run yet.
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

## Decision

TBD
`;
}
