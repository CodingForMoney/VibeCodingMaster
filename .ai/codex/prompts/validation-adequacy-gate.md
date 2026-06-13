# Codex Gate: validation-adequacy

Review whether the reviewer report provides enough validation evidence for the task to continue toward docs sync or final acceptance.

## Required Evidence

- `../../CLAUDE.md`
- `../../.claude/agents/reviewer.md`
- `../../.ai/vcm/handoffs/architecture-plan.md`
- `../../.ai/vcm/handoffs/review-report.md`
- `../../docs/TESTING.md`
- `../../.ai/generated/module-index.json`
- `../../.ai/generated/public-surface.json`

## Task

Check validation adequacy against the VCM Codex Reviewer rules in `AGENTS.md`.

Write exactly one Markdown report:

```text
../vcm/codex-reviews/validation-adequacy-review.md
```

The report decision must be exactly `approve` or `request_changes`.
Do not modify any other file.
