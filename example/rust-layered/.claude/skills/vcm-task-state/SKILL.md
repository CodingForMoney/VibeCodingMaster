---
name: vcm-task-state
description: Use only as project-manager to declare the current task workflow checkpoint to VCM.
---

# VCM Task State Skill

## Purpose

Use this skill only as project-manager to declare the current task workflow checkpoint to VCM.

The declaration is recoverable context, not a workflow controller. It does not authorize a transition, replace handoff artifacts, or decide the next role.

## Declaration

For a PM role dispatch, put the current declaration in the route-file frontmatter:

```yaml
workflow_flow: code-change
workflow_step: coder-implementation
workflow_branch: none
workflow_resume_point: none
workflow_status: active
workflow_evidence_refs: .ai/vcm/handoffs/architecture-plan.md
```

For a checkpoint without a role route, run:

```bash
.ai/tools/update-task-state --flow code-change --step awaiting-user --status awaiting-user
```

Supply only fields that changed. Use `none` to clear branch or resume point. Repeat `--evidence` for evidence paths.

Declare the selected flow before its first dispatch, update the step on later PM dispatches, and update no-route checkpoints such as waiting for the user, waiting for Gate Review, or completion.

If declaration fails, report the warning when relevant and continue the existing workflow. Never delay routing, Gate Review, final acceptance, or task close because task state is unavailable.
