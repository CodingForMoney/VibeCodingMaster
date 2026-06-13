---
name: vcm-codex-review-gate
description: Use when project-manager reaches a Codex Review Gate or receives a VCM Codex Review callback.
---

# VCM Codex Review Gate Skill

## Purpose

Use this skill when project-manager reaches a VCM Codex Review Gate or receives a VCM Codex Review callback.

## Trigger Points

- `architecture-plan`: after architect writes `.ai/vcm/handoffs/architecture-plan.md`, before coder dispatch.
- `validation-adequacy`: after reviewer writes `.ai/vcm/handoffs/review-report.md`, before docs sync or final acceptance.
- `final-diff`: after final acceptance evidence is ready, before PR preparation.

## Request

Run:

```sh
.ai/tools/request-codex-review --gate <architecture-plan|validation-adequacy|final-diff>
```

Interpret the first output line:

- `disabled`, `not_required`, `already_approved`: continue the normal VCM flow.
- `started` or `running`: stop this turn and wait for the VCM callback.
- `failed_to_start`: report the failure to the user.

Do not run `codex exec` yourself. VCM owns the Codex adapter and gate state.

## Callback

When VCM sends `[VCM CODEX REVIEW CALLBACK]`, read the named report path.

- `approve`: continue to the next normal VCM gate.
- `request_changes`: summarize the findings and route follow-up through the responsible VCM role.
- `failed`: stop and ask the user to retry, skip, or override in VCM.
- `skipped` or `overridden`: record the exception reason in PM context and continue only as appropriate.

Do not ask Codex Reviewer to choose owners, fixes, Replan, or user-intervention needs. PM routes those decisions through normal VCM responsibilities.
