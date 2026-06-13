# Codex Gate: final-diff

Review whether the final task diff is ready for PR preparation.

## Required Evidence

- `../../CLAUDE.md`
- `../../.claude/agents/architect.md`
- `../../.claude/agents/coder.md`
- `../../.claude/agents/reviewer.md`
- `../../.ai/vcm/handoffs/architecture-plan.md`
- `../../.ai/vcm/handoffs/review-report.md`
- `../../.ai/vcm/handoffs/docs-sync-report.md`
- `../../.ai/vcm/handoffs/final-acceptance.md`
- current git status and diff from `../..`
- `../../.ai/generated/module-index.json`
- `../../.ai/generated/public-surface.json`

## Task

Check the final diff against the VCM Codex Reviewer rules in `AGENTS.md`.

Write exactly one Markdown report:

```text
../vcm/codex-reviews/final-diff-review.md
```

The report decision must be exactly `approve` or `request_changes`.
Do not modify any other file.
