---
name: vcm-report-harness-issue
description: Use when a VCM role notices a reusable harness problem and needs to record feedback for Harness Engineer review.
---

# VCM Report Harness Issue Skill

Use this skill when a VCM role notices a reusable harness problem: a tool, skill, role definition, routing rule, validation rule, bootstrap rule, generated-context rule, or VCM managed instruction may be unclear, brittle, incomplete, or repeatedly causing mistakes.

This skill records feedback only. It must not call Harness Engineer directly and must not edit harness files.

## Write Location

Write one markdown file under:

```
${VCM_BASE_REPO_ROOT}/.ai/vcm/harness-feedback/pending/
```

If `VCM_BASE_REPO_ROOT` is not set, use the current git root as a fallback.

Use a filename like:

```
<UTC timestamp>-<reporter-role>-<short-slug>.md
```

Use only safe filename characters: letters, numbers, dot, dash, and underscore.

## Required Content

The file must include:

- reporter role
- task slug when known
- summary
- observed problem
- expected behavior
- evidence, with relevant file paths, command names, logs, or repeated failure pattern
- suspected harness area
- impact
- urgency

## Constraints

- Keep the report concise and factual.
- Include enough evidence for Harness Engineer to verify the issue.
- Do not include secrets, private logs, or unnecessary source content.
- Continue the current VCM role work after writing the report unless the original task is blocked.
