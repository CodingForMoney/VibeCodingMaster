---
name: vcm-task-state
description: Use only as project-manager to declare the current task workflow checkpoint to VCM.
---

# VCM Task State Skill

## Purpose

Use this skill only as project-manager to declare the current task workflow checkpoint to VCM.

The declaration is recoverable context, not a workflow controller. It does not authorize a transition, replace handoff artifacts, or decide the next role.

## Declaration

Record a recoverable checkpoint with:

```bash
.ai/tools/update-task-state --flow code-change --step architect-planning --status active
```

Supply only fields that changed. Use `none` to clear branch or resume point. Repeat `--evidence` for evidence paths.

Declare the selected flow before its first dispatch, update the step before later PM dispatches, and update no-route checkpoints such as waiting for Gate Review or completion. Use `vcm-ask-user`, not this advisory declaration, whenever PM asks the user a question. Do not put task-state or workflow-approval fields in route-message frontmatter.

If declaration fails, report the warning when relevant and continue the existing workflow. Never delay routing, Gate Review, final acceptance, or task close because task state is unavailable.
