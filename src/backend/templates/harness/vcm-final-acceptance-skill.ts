export function renderVcmFinalAcceptanceSkillRules(): string {
  return `## Purpose

Use this skill when project-manager is ready to decide whether a VCM-managed task can be accepted, returned for follow-up, or blocked for a decision.

This skill is a final evidence audit. It does not replace architect docs sync, reviewer acceptance, validation, or user approval for high-risk decisions.

## Required Inputs

Read the relevant task evidence before deciding:

- route messages or durable plan
- \`.ai/vcm/handoffs/architecture-plan.md\`
- \`.ai/vcm/handoffs/known-issues.md\`
- \`.ai/vcm/handoffs/review-report.md\`
- \`.ai/vcm/handoffs/docs-sync-report.md\`
- current \`git status\` and \`git diff\`
- relevant long-term docs when the task touched public behavior, architecture, tests, security, dependencies, or plans

## Scope Traceability Audit

Do not claim to prove that the diff is exactly equal to the task scope.

Instead, classify changed files and meaningful hunks:

- expected changes: directly named by the user request, durable plan, route message, or architecture plan
- supporting changes: tests, fixtures, types, docs, or wiring needed for expected changes
- approved deviations: changes explained by Replan, reviewer follow-up, or explicit user / project-manager approval
- unexplained changes: changes with no traceable reason in the task evidence
- high-risk unexpected changes: auth, permissions, payment, billing, schema, migrations, data deletion, secrets, generated artifacts, dependencies, lockfiles, or broad formatting churn

Unexplained changes must be explained, reverted, or routed for follow-up before normal acceptance.

High-risk unexpected changes require project-manager / user approval or Replan before acceptance.

## Acceptance Checks

Check:

- required route was followed, or a user-approved exception is recorded
- required handoff artifacts exist and are current
- architecture plan was followed, or Replan was approved
- reviewer decision is acceptable, or findings are routed for follow-up
- docs sync is complete, or docs intentionally left unchanged are justified
- task-local known issues were resolved, promoted to \`docs/known-issues.md\`, or explicitly left out with a reason
- public behavior has direct tests or a recorded exception
- tests were not weakened, deleted, or skipped just to pass
- temporary task state is ready to clean after durable facts are promoted

## Decisions

Choose exactly one:

- accepted
- accepted-with-known-risks
- needs-coder-follow-up
- needs-architect-replan
- needs-docs-sync
- blocked-by-user-decision

Do not accept when validation evidence is missing, reviewer findings are unresolved, docs sync is missing for durable changes, or unexplained high-risk changes remain.

## Output

Write or update:

\`\`\`text
.ai/vcm/handoffs/final-acceptance.md
\`\`\`

Use this structure:

\`\`\`md
# Final Acceptance: <task>

## Decision

accepted | accepted-with-known-risks | needs-coder-follow-up | needs-architect-replan | needs-docs-sync | blocked-by-user-decision

## Evidence Reviewed

## Scope Traceability

### Expected Changes

### Supporting Changes

### Approved Deviations

### Unexplained Changes

### High-Risk Unexpected Changes

## Validation Summary

## Review And Docs Sync

## Cleanup Readiness

## Final User Summary
\`\`\`

The final user summary should be concise and include files changed, validation, docs updates, open risks, and next action.
`;
}
