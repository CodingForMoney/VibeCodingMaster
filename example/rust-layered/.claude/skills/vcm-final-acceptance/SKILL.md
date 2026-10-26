---
name: vcm-final-acceptance
description: Use when project-manager is ready to close a complete VCM code-delivery flow.
---

# VCM Final Acceptance Skill

## Purpose

Use this skill only when project-manager is ready to close a complete VCM code-delivery flow, including Architect Debug Flow or an Architecture Diagnosis Flow that produced code changes.

Do not use it for Docs-Only Flow, Validation-Only Flow, Communication-Only Flow, PR-Preparation Flow, or analysis-only Diagnosis. After an Architect Debug Branch or Architecture Diagnosis Branch passes its code-diff Gate, use it for the parent flow the branch returned to, auditing the whole task; never for a branch that has not passed its code-diff Gate.

This skill is a final evidence audit. It does not replace architect documentation ownership, tester validation acceptance, coder implementation responsibility, or user approval for high-risk decisions.

Project-manager must not use this skill to perform technical design review, implementation review, source-code analysis, or test adequacy analysis. Missing or conflicting evidence must be routed to the responsible role.

## Required Inputs

Read the relevant task evidence before deciding:

- original user request, PM route message, or durable plan when present
- `.ai/vcm/handoffs/architecture-plan.md` when the task required architect planning
- `.ai/vcm/handoffs/architecture-diagnosis.md` when the flow used Architecture Diagnosis Mode
- `.ai/vcm/handoffs/test-report.md` when tester validation was required
- `.ai/vcm/handoffs/known-issues.md` when unresolved findings were recorded
- `.ai/vcm/gate-reviews/index.json` and referenced Gate Review reports when Gate Reviews were required, skipped, or overridden
- current `git status` and changed file list
- the architecture plan's Docs Impact and the code-diff Gate's Documentation Fit result when durable docs could be affected

## Evidence Audit

Check whether the required role evidence exists, is current, and gives a clear result or decision.

Acceptable evidence must show:

- architect plan or architecture diagnosis when required by the completed flow
- tester terminal `Test Result: pass|fail` and validation evidence when code, behavior, tests, or generated context changed; `incomplete` is not acceptance evidence
- required Gate Review decisions, skip reasons, or override reasons when Gate Reviews were enabled
- known-issues disposition when unresolved findings were recorded
- explicit user approval for accepted high-risk decisions or intentionally skipped required gates

## Scope Traceability Audit

Do not claim to prove that every diff hunk exactly matches the task.

Review the changed file list only, then classify files:

- expected files: directly named by the user request, route message, durable plan, architecture plan, or architecture diagnosis
- supporting files: tests, fixtures, generated context, docs, or wiring needed for expected files
- approved deviations: files explained by Replan, a Debug or Diagnosis fix, tester follow-up, a post-validation docs correction, or explicit user approval
- unexplained files: files with no traceable reason in the task evidence
- high-risk unexpected files: auth, permissions, payment, billing, schema, migrations, data deletion, secrets, dependencies, lockfiles, broad generated artifacts, or broad formatting churn

Unexplained files must be routed for explanation, follow-up, or removal before normal acceptance.

High-risk unexpected files require explicit user approval or architect Replan before acceptance.

## Acceptance Checks

Check:

- required route was followed, or an explicit user-approved exception is recorded
- required handoff artifacts exist and are current
- architecture plan, Architecture Diagnosis, Replan, or architect follow-up completion is recorded when required by the flow
- tester report records terminal `Test Result: pass|fail`, validation commands, results, and skipped checks with reasons; do not accept `Test Result: incomplete`
- required Gate Reviews are approved, or skipped/overridden through a VCM-recorded user action
- Gate Review enable state is confirmed authoritatively: do not infer that no Gate Reviews were required from an absent or empty `.ai/vcm/gate-reviews/index.json`. When Gate Review is enabled, a missing index or a required gate without a recorded decision means the gate was skipped — run the matching command from the `vcm-gate-review` skill, including the code source for `code-diff`, and do not accept until each required gate returns `approve`/`already_approved`, `disabled`/`not_required`, or a VCM-recorded user skip/override
- the code-diff Gate approval covers the current HEAD commit, so every doc correction and follow-up commit was reviewed; a commit made after the approval requires rerunning the code-diff Gate before acceptance
- `.ai/tools/check-durable-docs` passes when durable docs changed
- any cross-document inconsistency was resolved by the owning role
- known issues are either resolved, promoted to durable docs by architect, or explicitly accepted by the user; when `docs/known-issues.md` still needs a promotion or removal, decide `needs-architect-follow-up`
- temporary task state is ready to clean after durable facts are promoted

## Decisions

Choose exactly one:

- accepted
- accepted-with-known-risks
- needs-coder-follow-up
- needs-architect-follow-up
- blocked-by-user-decision

Do not accept when required role evidence is missing, required Gate Review evidence is missing, tester findings are unresolved, the code-diff approval does not cover the current HEAD, the durable-doc audit failed or is missing after durable-doc changes, known-issues disposition is missing, or unexplained high-risk files remain.

## Output

Write a complete candidate outside `.ai/vcm`, then submit it:

```text
.ai/tools/vcm-artifact final-acceptance --file <candidate> --mode final
```

Use this structure:

```md
# Final Acceptance: <task>

## Decision

accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|blocked-by-user-decision

## Evidence Reviewed

## Scope Traceability

### Expected Files

### Supporting Files

### Approved Deviations

### Unexplained Files

### High-Risk Unexpected Files

## Validation Summary

## Review And Documentation

## Known Issues Disposition

## Gate Review Gates

## Cleanup Readiness

## Final User Summary
```

Each rewrite must be a complete, self-contained snapshot of the current acceptance decision and supporting evidence. Restate every still-relevant evidence result, file classification, validation result, Gate decision, documentation result, known-issues disposition, cleanup result, risk, and next action; do not rely on a prior acceptance revision, route message, Session, or transcript.

The final user summary should be concise and include files changed, validation, docs updates, open risks, and next action.
