# Codex Gate: architecture-plan

Review whether the architecture plan is ready for coder implementation.

## Required Evidence

- `../../CLAUDE.md`
- `../../.claude/agents/architect.md`
- `../../.claude/agents/coder.md`
- `../../.claude/agents/reviewer.md`
- `../../.ai/vcm/handoffs/architecture-plan.md`
- current git status and scaffold diff from `../..`
- `../../.ai/generated/module-index.json`
- `../../.ai/generated/public-surface.json`

## Task

Check the plan against the VCM Codex Reviewer rules in `AGENTS.md`.

Write exactly one Markdown report:

```text
../vcm/codex-reviews/architecture-plan-review.md
```

The report decision must be exactly `approve` or `request_changes`.
Do not modify any other file.
