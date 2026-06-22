---
name: vcm-gate-review
description: Use when project-manager reaches a Gate Review trigger or receives a VCM Gate Review callback.
---

# VCM Gate Review Skill

## Purpose

Use this skill when project-manager reaches a VCM Gate Review or receives a VCM Gate Review callback.

## Trigger Points

- `architecture-plan`: after architect writes `.ai/vcm/handoffs/architecture-plan.md`, before coder dispatch.
- `validation-adequacy`: after reviewer writes `.ai/vcm/handoffs/review-report.md`, before docs sync or final acceptance.
- `final-diff`: after final acceptance evidence is ready, before PR preparation.

## Request

Run:

```sh
.ai/tools/request-gate-review --gate <architecture-plan|validation-adequacy|final-diff>
```

Interpret the first output line:

- `disabled`, `not_required`, `already_approved`: continue the normal VCM flow.
- `started` or `running`: stop this turn and wait for the VCM callback.
- `failed_to_start`: report the failure to the user.

## Callback

When VCM sends `[VCM GATE REVIEW CALLBACK]`, read the named report path.

- `approve`: continue to the next normal VCM gate.
- `request_changes`: summarize the findings and route follow-up through the responsible VCM role.
- `failed`: stop and ask the user to retry, skip, or override in VCM.
- `skipped` or `overridden`: record the exception reason in PM context and continue only as appropriate.

Do not ask Gate Reviewer to choose owners, fixes, Replan, or user-intervention needs. PM routes those decisions through normal VCM responsibilities.
