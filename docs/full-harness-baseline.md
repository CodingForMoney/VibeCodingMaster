# Full Harness Baseline

Last updated: 2026-06-21

Status: Current implementation reference.

This file tracks the VCM fixed harness currently installed by
`src/backend/services/harness-service.ts` and
`src/backend/cli/install-vcm-harness.ts`.

## Principles

VCM separates three file classes:

- Harness-managed files: VCM installs, upgrades, repairs, and can overwrite
  inside managed blocks or whole-file templates.
- Project-owned durable docs: VCM may create starter docs, but project roles own
  their content afterward.
- Runtime state: VCM writes these during task execution and cleanup removes them
  when the task is closed.

The current implementation no longer uses `.ai/vcm-harness-manifest.json`.
Harness ownership is defined by the deterministic installer and by managed
markers such as `<!-- VCM:BEGIN version=1 -->`.

## Fixed Harness Files

Managed-block files:

```text
CLAUDE.md
.gitignore
.github/pull_request_template.md
.claude/agents/project-manager.md
.claude/agents/architect.md
.claude/agents/coder.md
.claude/agents/reviewer.md
.claude/agents/gate-reviewer.md
.claude/agents/translator.md
```

Whole-file or raw-file harness files:

```text
.claude/skills/vcm-route-message/SKILL.md
.claude/skills/vcm-final-acceptance/SKILL.md
.claude/skills/vcm-long-running-validation/SKILL.md
.claude/skills/vcm-harness-bootstrap/SKILL.md
.claude/skills/vcm-gate-review/SKILL.md
.claude/agents/translator.md
.ai/tools/generate-module-index
.ai/tools/generate-public-surface
.ai/tools/request-gate-review
.ai/tools/run-long-check
.ai/tools/watch-job
.ai/tools/vcm-bash-guard
```

Durable doc templates created only when missing:

```text
docs/ARCHITECTURE.md
docs/TESTING.md
docs/known-issues.md
```

Directory roots created by the installer:

```text
.claude/agents/
.claude/skills/
.claude/skills/vcm-final-acceptance/
.claude/skills/vcm-harness-bootstrap/
.claude/skills/vcm-long-running-validation/
.claude/skills/vcm-route-message/
.claude/skills/vcm-gate-review/
.ai/vcm/translations/
.ai/vcm/gate-reviews/
.ai/tools/
.ai/generated/
```

## Installed Skills

- `vcm-route-message`: route-file write protocol.
- `vcm-final-acceptance`: PM final evidence audit.
- `vcm-long-running-validation`: foreground supervision protocol for long jobs.
- `vcm-harness-bootstrap`: AI-assisted project understanding and generated
  context refresh.
- `vcm-gate-review`: PM protocol for requesting Gate Review and handling VCM
  callbacks.

## Installed Tools

```text
.ai/tools/generate-module-index
.ai/tools/generate-public-surface
.ai/tools/request-gate-review
.ai/tools/run-long-check
.ai/tools/watch-job
.ai/tools/vcm-bash-guard
```

`generate-module-index` and `generate-public-surface` support Rust/Cargo
projects and npm workspace TypeScript/JavaScript projects. Other repository
shapes can still install the fixed harness, but generated context should be
treated as unsupported until project-specific generators exist.

## Runtime State

Task runtime state lives in the task worktree:

```text
<taskRepoRoot>/.ai/vcm/sessions/<task>.json
<taskRepoRoot>/.ai/vcm/messages/<task>.jsonl
<taskRepoRoot>/.ai/vcm/orchestration/<task>.json
<taskRepoRoot>/.ai/vcm/translation/<task>/
<taskRepoRoot>/.ai/vcm/handoffs/
<taskRepoRoot>/.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
<taskRepoRoot>/.ai/vcm/handoffs/architecture-plan.md
<taskRepoRoot>/.ai/vcm/handoffs/known-issues.md
<taskRepoRoot>/.ai/vcm/handoffs/review-report.md
<taskRepoRoot>/.ai/vcm/handoffs/docs-sync-report.md
<taskRepoRoot>/.ai/vcm/handoffs/final-acceptance.md
<taskRepoRoot>/.ai/vcm/jobs/<job-id>/
<taskRepoRoot>/.ai/vcm/gate-reviews/
```

Project-scoped runtime state lives in the base repository:

```text
<baseRepoRoot>/.ai/vcm/harness-engineer/session.json
<baseRepoRoot>/.ai/vcm/translations/
<baseRepoRoot>/.ai/vcm/bootstrap/session.json
```

App-local state lives under `vcmDataDir`:

```text
<vcmDataDir>/settings.json
<vcmDataDir>/projects/index.json
<vcmDataDir>/projects/<project-id>/config.json
<vcmDataDir>/projects/<project-id>/tasks/<task>.json
<vcmDataDir>/gateway/
```

Ordinary VCM role sessions no longer persist raw terminal logs under
`.ai/vcm/handoffs/logs/`. Claude transcript JSONL files under
`~/.claude/projects/` remain the semantic source for output translation and
session recovery.

## Cleanup

Close Task removes the task-owned worktree, branch, app-local task record, and
task-local runtime state. It stops task-scoped VCM role sessions for that task.
It must not stop project-scoped Translator or Harness Engineer sessions.

Durable facts that should survive task cleanup must be promoted into code,
tests, durable docs, PR text, commit history, or release notes before closing
the task.
