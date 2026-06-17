# Full Harness Baseline

Last updated: 2026-06-12

Status: Temporary working document.

This file tracks the current VCM 0.2 harness baseline as represented by
`example/rust-layered`. It is not a broad inventory of the old
`cc-best-practices.md` baseline.

When the example stabilizes, migrate the durable decisions into
`docs/vcm-cc-best-practices.md` and delete this file.

## Current Principle

VCM separates three kinds of files:

- Harness-managed files: VCM owns, upgrades, repairs, and can uninstall these
  through `.ai/vcm-harness-manifest.json`.
- Project-owned durable docs: VCM bootstrap may create or initialize these, but
  they become project truth and are not VCM-owned harness.
- Runtime state: VCM writes these during task execution and deletes them during
  task cleanup. Runtime files are not manifest entries.

The manifest is a harness ownership and lifecycle record. It should include
VCM-managed rules, agents, skills, settings merges, harness tools, generated
context artifacts, PR template managed blocks, marker metadata, JSON ownership,
lifecycle labels, runtime roots, and uninstall actions.

The manifest should not list project-owned durable docs such as
`docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/known-issues.md`,
`docs/plans/`, or module-level `ARCHITECTURE.md` files as managed entries. It
should not list `.ai/vcm/**` runtime files as managed entries either.

## Install And Bootstrap Flow

VCM 0.2 uses a two-stage harness setup:

1. Fixed install: VCM runs the deterministic fixed installer. This creates or
   updates VCM-owned managed blocks, whole-file skills, role agents, settings
   hooks, harness tools, generated-context directories, the PR template, and
   `.ai/vcm-harness-manifest.json`.
2. AI bootstrap: VCM starts a temporary Claude Code terminal in the repository
   root and instructs it to use `vcm-harness-bootstrap`. This fills
   project-owned content and generated artifacts.

The fixed install does not copy example project content. It may create blank
durable doc templates when missing, but project-specific facts are added only by
bootstrap or by later role work.

Bootstrap should produce or refresh:

```text
CLAUDE.md project context outside the VCM managed block
docs/ARCHITECTURE.md
<module>/ARCHITECTURE.md
docs/TESTING.md
.ai/generated/module-index.json
.ai/generated/public-surface.json
```

Bootstrap runtime metadata is temporary:

```text
.ai/vcm/bootstrap/session.json
.ai/vcm/bootstrap/bootstrap.log
```

These files are runtime state, not manifest entries. They can be deleted after
the generated artifacts and durable docs are complete.

## Current Manifest Entries

These entries match the current `example/rust-layered/.ai/vcm-harness-manifest.json`.

| Area | Path | Ownership | Lifecycle | Notes |
| --- | --- | --- | --- | --- |
| Manifest | `.ai/vcm-harness-manifest.json` | whole-file | Long-term | VCM harness ownership record. |
| Root rules | `CLAUDE.md` | managed-block | Long-term | VCM HTML marker block only; project context outside the block is project-owned. |
| Ignore rules | `.gitignore` | managed-block | Long-term | VCM hash-comment marker block. The example comments `.ai/vcm/` so readers can inspect runtime artifacts. |
| Claude settings | `.claude/settings.json` | json-merge | Long-term | VCM owns hook entries matching VCM command markers. |
| Agent directory | `.claude/agents/` | VCM-created directory | Long-term | Contains the four core VCM role agents. |
| Core agent | `.claude/agents/project-manager.md` | managed-block | Long-term | Project-manager role rules. |
| Core agent | `.claude/agents/architect.md` | managed-block | Long-term | Architect role rules: plan document, Scaffold Manifest, code scaffolding, Debug Mode, docs sync. |
| Core agent | `.claude/agents/coder.md` | managed-block | Long-term | Coder role rules: scaffold implementation, coding standards, baseline unit checks. |
| Core agent | `.claude/agents/reviewer.md` | managed-block | Long-term | Reviewer role rules: independent validation, TESTING.md strategy, integration/E2E case lists. |
| Skill directory | `.claude/skills/` | VCM-created directory | Conditional long-term | Keep while repo-local VCM skills are installed. |
| Skill directory | `.claude/skills/vcm-route-message/` | VCM-created directory | Conditional long-term | Claude Code registration directory for the route-message skill. |
| Skill directory | `.claude/skills/vcm-final-acceptance/` | VCM-created directory | Conditional long-term | Claude Code registration directory for the final-acceptance skill. |
| Skill directory | `.claude/skills/vcm-long-running-validation/` | VCM-created directory | Conditional long-term | Claude Code registration directory for the long-running-validation skill. |
| Skill directory | `.claude/skills/vcm-harness-bootstrap/` | VCM-created directory | Conditional long-term | Claude Code registration directory for the harness-bootstrap skill. |
| Skill | `.claude/skills/vcm-route-message/SKILL.md` | whole-file | Conditional long-term | Route-file authoring protocol. |
| Skill | `.claude/skills/vcm-final-acceptance/SKILL.md` | whole-file | Conditional long-term | PM final evidence audit. |
| Skill | `.claude/skills/vcm-long-running-validation/SKILL.md` | whole-file | Conditional long-term | Role-independent long-running command protocol: worker-enforced 60 minute ceiling, supervision lease, windowed foreground watching. |
| Skill | `.claude/skills/vcm-harness-bootstrap/SKILL.md` | whole-file | Conditional long-term | AI-assisted project understanding procedure. |
| Harness tool directory | `.ai/tools/` | VCM-created directory | Long-term | Repo-local harness tools. |
| Generated-context tool | `.ai/tools/generate-module-index` | whole-file | Long-term | Generates `.ai/generated/module-index.json`. |
| Generated-context tool | `.ai/tools/generate-public-surface` | whole-file | Long-term | Generates `.ai/generated/public-surface.json`. |
| Runtime tool | `.ai/tools/run-long-check` | whole-file | Conditional long-term | Starts the only VCM-allowed file-backed validation job; its worker enforces the job ceiling (max 60m) and a supervision lease, and refuses concurrent jobs. |
| Runtime tool | `.ai/tools/watch-job` | whole-file | Conditional long-term | Foreground watcher and lease renewer; watches in windows up to 8 minutes and exits 125 while the job still runs instead of killing it. |
| Runtime tool | `.ai/tools/vcm-bash-guard` | whole-file | Conditional long-term | PreToolUse hook guard; denies `run_in_background`, `nohup`, `setsid`, `disown`, and `&` background Bash in VCM role sessions. |
| Generated context directory | `.ai/generated/` | VCM-created directory | Long-term | Derived context artifacts. |
| Generated context | `.ai/generated/module-index.json` | derived artifact | Derived | Regenerated by `generate-module-index`; do not hand-edit as source truth. |
| Generated context | `.ai/generated/public-surface.json` | derived artifact | Derived | Regenerated by `generate-public-surface`; do not hand-edit as source truth. |
| PR template | `.github/pull_request_template.md` | managed-block | Long-term | VCM PR checklist block. |

Runtime roots recorded by the manifest:

```text
.ai/vcm/
.claude/worktrees/
```

These roots are cleanup targets, not managed entries.

## Project-Owned Bootstrap Outputs

The current example includes project-owned durable docs created or initialized
during harness bootstrap. They are important for the workflow, but they are not
VCM-owned harness and should not appear as manifest entries.

| Area | Path | Owner | Lifecycle | Notes |
| --- | --- | --- | --- | --- |
| Project context | `CLAUDE.md` content outside VCM block | Project | Long-term | Rust-layered project facts and constraints. |
| Project architecture | `docs/ARCHITECTURE.md` | Architect | Long-term | Project-level module overview, responsibilities, relationships, dependency direction, and links to module docs. |
| Module architecture | `<module>/ARCHITECTURE.md` | Architect | Long-term | Module-level boundaries, behavior, important public surface explanations, and risks. |
| Testing docs | `docs/TESTING.md` | Reviewer | Long-term | Validation levels, commands, selection rules, final-validation cleanup, integration/E2E case definitions, generated-context freshness checks, and testing gaps. |
| Known issues | `docs/known-issues.md` | Architect | Rolling durable doc | Confirmed unresolved issues and accepted limitations. Remove fixed, rejected, or obsolete entries. |
| Durable plans | `docs/plans/` | Project | Conditional long-term | Durable plans only when a large task needs them. Completed routine plans should be deleted after durable facts are promoted. |

Current `example/rust-layered` does not use these old separate docs:

```text
docs/MODULE_MAP.md
docs/SECURITY.md
docs/DEPENDENCY_RULES.md
docs/AI_WORKFLOW.md
```

## Runtime State

Runtime state is created while VCM manages a task. It is task-local and should be
deleted during task cleanup after useful facts are promoted to code, tests,
durable docs, PR text, or commit history.

| Area | Path | Lifecycle | Notes |
| --- | --- | --- | --- |
| Worktrees | `.claude/worktrees/<task-slug>/` | Runtime cleanup | One task worktree shared by all roles. |
| Handoff root | `.ai/vcm/handoffs/` | Runtime cleanup | Role artifacts and route files for the active task. |
| Route messages | `.ai/vcm/handoffs/messages/<from-role>-<to-role>.md` | Runtime cleanup | Pending route files written by `vcm-route-message`. |
| Handoff logs | `.ai/vcm/handoffs/logs/` | Runtime cleanup | Debug/recovery logs, not durable project truth. |
| Architecture plan | `.ai/vcm/handoffs/architecture-plan.md` | Task-temporary | Architect handoff for one executable task. |
| Review report | `.ai/vcm/handoffs/review-report.md` | Task-temporary | Reviewer handoff for one executable task. |
| Docs sync report | `.ai/vcm/handoffs/docs-sync-report.md` | Task-temporary | Architect docs-sync handoff for one executable task. |
| Final acceptance | `.ai/vcm/handoffs/final-acceptance.md` | Task-temporary | PM final evidence-audit handoff for one executable task. |
| Task known issues | `.ai/vcm/handoffs/known-issues.md` | Task-temporary | Promote unresolved durable findings to `docs/known-issues.md`, then delete. |
| Long-running jobs | `.ai/vcm/jobs/<job-id>/` | Runtime cleanup | Status and logs from `run-long-check` / `watch-job`. |
| Bootstrap session | `.ai/vcm/bootstrap/session.json` | Runtime cleanup | Last harness-bootstrap terminal metadata. |
| Bootstrap log | `.ai/vcm/bootstrap/bootstrap.log` | Runtime cleanup | Terminal log for the harness-bootstrap session. |
| App-local task records | `<vcmDataDir>/projects/<project-id>/tasks/<task-slug>.json` | Runtime cleanup | VCM UI/lifecycle subtask records outside the connected repo. |

Runtime state under `.ai/vcm/**` is excluded from manifest entries. The manifest
records `.ai/vcm/` only as a runtime root.

## Current Skills

The current example installs these skills:

- `vcm-route-message`: route-file write protocol.
- `vcm-final-acceptance`: final PM evidence audit.
- `vcm-long-running-validation`: role-independent long-running command protocol with a worker-enforced 60 minute ceiling, supervision lease, and windowed foreground watching.
- `vcm-harness-bootstrap`: one-time or occasional project-understanding, generated-context refresh, and durable-doc bootstrap procedure.

The current example does not install a separate `vcm-docs-sync` skill. Docs sync
is expressed in the architect role rules and writes
`.ai/vcm/handoffs/docs-sync-report.md`.

## Current Tools

The current example keeps only five `.ai/tools/` files:

```text
.ai/tools/generate-module-index
.ai/tools/generate-public-surface
.ai/tools/run-long-check
.ai/tools/watch-job
.ai/tools/vcm-bash-guard
```

The generated-context tools currently support Rust projects only. The fixed
installer may install them as the default Rust baseline, but non-Rust projects
need project-specific generators before `.ai/generated/*` can be trusted.

The current example intentionally does not install these old validation or
discovery wrappers:

```text
.ai/tools/check-fast
.ai/tools/check-changed
.ai/tools/check-module
.ai/tools/check-boundaries
.ai/tools/check-agent-rules
.ai/tools/check-docs-freshness
.ai/tools/check-generated-artifacts
.ai/tools/find-owner
.ai/tools/find-callers
.ai/tools/find-tests
```

Rust unit tests and integration tests are run with native Cargo commands chosen
by the responsible role. The harness does not need a fixed wrapper for every
validation level.

## Generated Context

The current example has two generated artifacts:

```text
.ai/generated/module-index.json
.ai/generated/public-surface.json
```

Current support is Rust-only:

- `generate-module-index` reads Cargo workspace structure, auto-detects a
  direct child `cargoRoot` when the project root has no `Cargo.toml`, and
  filters workspace member paths that do not contain a crate.
- `generate-public-surface` indexes crate-external Rust `pub fn`,
  `pub struct`, `pub enum`, and `pub trait` items, using `pub use` only to
  resolve re-exported high-value API entries.

There is no `test-map.json`. Test files are discoverable through
`module-index.json` and Rust's normal Cargo test layout.

Generated artifacts are derived context, not durable project truth. They must be
regenerated by their tools after relevant source, manifest, module, or public API
changes.

## Not Part Of The Current Example

The following items are intentionally not part of the current `rust-layered`
baseline:

```text
.claude/commands/
.claude/agents/optional/
.ai/task-specs/
.ai/vcm/tasks/
.ai/vcm/handoffs/role-commands/
docs/plans/active/
docs/plans/completed/
docs/MODULE_MAP.md
docs/SECURITY.md
docs/DEPENDENCY_RULES.md
docs/AI_WORKFLOW.md
.ai/generated/test-map.json
```

Do not reintroduce these into the example baseline unless there is a specific,
current VCM requirement.
