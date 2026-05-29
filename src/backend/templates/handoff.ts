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
