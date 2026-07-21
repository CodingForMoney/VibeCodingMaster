---
name: vcm-final-acceptance
description: Use when project-manager is ready to close a complete VCM code-delivery flow.
---

# VCM Final Acceptance Skill

## Purpose

Use this skill only when project-manager is ready to close a complete VCM code-delivery flow, including Architect Debug Flow or an Architecture Diagnosis Flow that produced code changes.

Do not use it for Docs-Only Flow, Validation-Only Flow, Communication-Only Flow, PR-Preparation Flow, analysis-only Diagnosis, Architect Debug Branch, or Architecture Diagnosis Branch.

This skill is a final evidence audit. It does not replace architect docs sync, tester validation acceptance, coder implementation responsibility, or user approval for high-risk decisions.

Project-manager must not use this skill to perform technical design review, implementation review, source-code analysis, or test adequacy analysis. Missing or conflicting evidence must be routed to the responsible role.

## Required Inputs

Read the relevant task evidence before deciding:

- original user request, PM route message, or durable plan when present
- `.ai/vcm/handoffs/architecture-plan.md` when the task required architect planning
- `.ai/vcm/handoffs/architecture-diagnosis.md` when the flow used Architecture Diagnosis Mode
- `.ai/vcm/handoffs/test-report.md` when tester validation was required
- `.ai/vcm/handoffs/docs-sync-report.md` when durable docs could be affected
- `.ai/vcm/handoffs/known-issues.md` when unresolved findings were recorded
- `.ai/vcm/gate-reviews/index.json` and referenced Gate Review reports when Gate Reviews were required, skipped, or overridden
- current `git status` and changed file list
- relevant long-term docs only when needed to confirm that a docs-sync artifact exists and names the correct durable docs

## Evidence Audit

Check whether the required role evidence exists, is current, and gives a clear result or decision.

Acceptable evidence must show:

- architect plan, architecture diagnosis, or docs-sync decision when required by the completed flow
- tester `Test Result: pass|fail` and validation evidence when code, behavior, tests, or generated context changed
- required Gate Review decisions, skip reasons, or override reasons when Gate Reviews were enabled
- known-issues disposition when unresolved findings were recorded
- explicit user approval for accepted high-risk decisions or intentionally skipped required gates

## Scope Traceability Audit

Do not claim to prove that every diff hunk exactly matches the task.

Review the changed file list only, then classify files:

- expected files: directly named by the user request, route message, durable plan, architecture plan, or architecture diagnosis
- supporting files: tests, fixtures, generated context, docs, or wiring needed for expected files
- approved deviations: files explained by Replan, tester follow-up, docs-sync, or explicit user approval
- unexplained files: files with no traceable reason in the task evidence
- high-risk unexpected files: auth, permissions, payment, billing, schema, migrations, data deletion, secrets, dependencies, lockfiles, broad generated artifacts, or broad formatting churn

Unexplained files must be routed for explanation, follow-up, or removal before normal acceptance.

High-risk unexpected files require explicit user approval or architect Replan before acceptance.

## Acceptance Checks

Check:

- required route was followed, or an explicit user-approved exception is recorded
- required handoff artifacts exist and are current
- architecture plan, Architecture Diagnosis, Replan, or architect follow-up completion is recorded when required by the flow
- tester report records `Test Result: pass|fail`, validation commands, results, and skipped checks with reasons
- required Gate Reviews are approved, or skipped/overridden through a VCM-recorded user action
- Gate Review enable state is confirmed authoritatively: do not infer that no Gate Reviews were required from an absent or empty `.ai/vcm/gate-reviews/index.json`. When Gate Review is enabled, a missing index or a required gate without a recorded decision means the gate was skipped — run the matching command from the `vcm-gate-review` skill, including the code source for `code-diff`, and do not accept until each required gate returns `approve`/`already_approved`, `disabled`/`not_required`, or a VCM-recorded user skip/override
- docs-sync report records docs updated, docs intentionally left unchanged, or required follow-up when docs sync was required
- when durable docs changed, docs-sync or tester evidence records a passing `.ai/tools/check-durable-docs` result and any cross-document inconsistency was resolved by the owning role
- known issues are either resolved, promoted to durable docs by architect, or explicitly accepted by the user
- temporary task state is ready to clean after durable facts are promoted

## Decisions

Choose exactly one:

- accepted
- accepted-with-known-risks
- needs-coder-follow-up
- needs-architect-follow-up
- needs-docs-sync
- blocked-by-user-decision

Do not accept when required role evidence is missing, required Gate Review evidence is missing, tester findings are unresolved, docs sync is missing for durable changes, the durable-doc audit failed or is missing after durable-doc changes, known-issues disposition is missing, or unexplained high-risk files remain.

## Output

Write or update:

```text
.ai/vcm/handoffs/final-acceptance.md
```

Use this structure:

```md
# Final Acceptance: <task>

## Decision

accepted | accepted-with-known-risks | needs-coder-follow-up | needs-architect-follow-up | needs-docs-sync | blocked-by-user-decision

## Evidence Reviewed

## Scope Traceability

### Expected Files

### Supporting Files

### Approved Deviations

### Unexplained Files

### High-Risk Unexpected Files

## Validation Summary

## Review And Docs Sync

## Known Issues Disposition

## Gate Review Gates

## Cleanup Readiness

## Final User Summary
```

The final user summary should be concise and include files changed, validation, docs updates, open risks, and next action.
