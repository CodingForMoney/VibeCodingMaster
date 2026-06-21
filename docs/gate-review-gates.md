# Gate Review Gates

This document defines VCM Gate Review Gates.

Gate Review is an optional quality layer for complex tasks. It uses a fifth
VCM flow role, `gate-reviewer`, powered by Claude Code. The role uses the same
hook, Round, terminal, and translation path as the normal VCM roles, but it
does not participate in PM route-file dispatch.

## Gates

VCM supports three gates:

- `architecture-plan`: review architect's plan before coder dispatch.
- `validation-adequacy`: review reviewer validation coverage before docs sync
  or final acceptance.
- `final-diff`: review the final diff before PR preparation.

Each gate returns only:

- `approve`
- `request_changes`

Gate Reviewer does not choose owners, fixes, Replan, or user intervention. PM
routes follow-up by gate type.

## Ownership

VCM owns:

- global Gate Review switches in `~/.vcm/settings.json`
- current task gate state under `<taskRepoRoot>/.ai/vcm/gate-reviews/`
- starting/resuming the project-scoped Gate Reviewer Claude Code session
- sending the gate prompt
- waiting for the report
- binding the project-scoped Gate Reviewer session to the current task for hook,
  Round, and translation state
- sending the callback to PM

PM owns:

- triggering `vcm-gate-review` at the three gate points
- stopping after a `started` or `running` result
- handling the VCM callback
- routing `request_changes` to the responsible normal VCM role

Gate Reviewer owns:

- reviewing only the requested gate
- writing only the assigned report

## Session Scope

Gate Reviewer is project-scoped:

```text
<baseRepoRoot>/.ai/vcm/gate-reviewer/session.json
```

The session is reusable across tasks in the same project. The gate prompt must
therefore name the current task and task worktree path explicitly. Prior
session memory can help orientation, but only current worktree evidence can
decide the gate.

When a task uses Gate Reviewer, VCM records the active task binding on the
project session. Hook events from the long-lived session are resolved through
that binding so Round state and translation output are written to the current
task.

Gate reports remain task-scoped:

```text
<taskRepoRoot>/.ai/vcm/gate-reviews/
```

## Prompt Shape

VCM sends a short prompt:

```text
[VCM GATE REVIEW]
Task: <taskSlug>
Worktree: <taskRepoRoot>
Gate: <gate>
Request: <requestId>
Report: <absolute report path>

Evidence:
- <relative evidence file>
Diff: inspect git status/diff in Worktree.

Write only Report. Start exactly:
Gate: <gate>
Request: <requestId>
Decision: approve|request_changes
Summary: <one or two sentences>
[/VCM GATE REVIEW]
```

Detailed review rules live in `.claude/agents/gate-reviewer.md`, so the prompt
does not repeat role policy.

## Files

Harness-managed files:

```text
.claude/agents/gate-reviewer.md
.claude/skills/vcm-gate-review/SKILL.md
.ai/tools/request-gate-review
```

Task runtime files:

```text
.ai/vcm/gate-reviews/index.json
.ai/vcm/gate-reviews/architecture-plan-review.md
.ai/vcm/gate-reviews/validation-adequacy-review.md
.ai/vcm/gate-reviews/final-diff-review.md
.ai/vcm/gate-reviews/requests/<request-id>.json
.ai/vcm/gate-reviews/requests/<request-id>.prompt.md
```

## Flow

```text
PM reaches gate
  -> PM uses vcm-gate-review
  -> VCM checks global gate switch and task state
  -> VCM starts or resumes project Gate Reviewer session
  -> VCM sends short prompt with task/worktree/report paths
  -> VCM binds Gate Reviewer to the current task
  -> Gate Reviewer writes report
  -> standard Claude hooks update Gate Reviewer activity/Round state
  -> VCM validates report
  -> VCM callbacks PM
  -> PM continues or routes follow-up
```

Close Task stops task-scoped VCM role sessions only. It must not stop the
project-scoped Gate Reviewer session.
