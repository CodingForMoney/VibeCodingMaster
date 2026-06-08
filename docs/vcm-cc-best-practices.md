# VCM Claude Code Best Practices

Last updated: 2026-06-08

This is the current VCM-specific Claude Code / AI coding best-practices guide.
It is based on the latest `example/rust-layered` harness baseline.

Do not install this document into target repositories. Target repositories should
receive a concise root `CLAUDE.md` VCM block, four role agents, repo-local VCM
skills, harness tools, and project-owned durable docs.

`docs/cc-best-practices.md` is archived as the old generic baseline. Current VCM
implementation should use this document and `docs/full-harness-baseline.md`.

## 1. Core Principle

VCM separates three concerns:

- Harness-managed files: VCM owns, upgrades, repairs, audits, and can uninstall
  these through `.ai/vcm-harness-manifest.json`.
- Project-owned durable docs: VCM bootstrap may create or initialize these, but
  they become project truth and are not VCM-owned harness.
- Runtime state: VCM writes these during task execution and cleans them up after
  durable facts are promoted.

Temporary documents should be deleted. Durable documents should be updated.
Completed routine plans, task-local handoffs, logs, and job state should not pile
up as permanent repository history.

## 2. Current Repo Harness Baseline

The current baseline is represented by `example/rust-layered`.

Fixed installer files:

```text
CLAUDE.md
.gitignore
.claude/settings.json
.claude/agents/project-manager.md
.claude/agents/architect.md
.claude/agents/coder.md
.claude/agents/reviewer.md
.claude/skills/vcm-route-message.md
.claude/skills/vcm-final-acceptance.md
.claude/skills/vcm-long-running-validation.md
.claude/skills/vcm-harness-bootstrap.md
.ai/vcm-harness-manifest.json
.ai/tools/generate-module-index
.ai/tools/generate-public-surface
.ai/tools/run-long-check
.ai/tools/watch-job
.github/pull_request_template.md
```

Derived bootstrap artifacts:

```text
.ai/generated/module-index.json
.ai/generated/public-surface.json
```

The generated artifacts are tracked in the manifest as derived artifacts so VCM
can clean or refresh them, but they are produced by generator tools during
bootstrap or later maintenance work. They are not hand-authored fixed templates.

Runtime roots:

```text
.ai/vcm/
.claude/worktrees/
```

Not part of the current baseline:

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
.ai/tools/check-fast
.ai/tools/check-changed
.ai/tools/check-module
.ai/tools/check-boundaries
.ai/tools/check-agent-rules
.ai/tools/check-docs-freshness
.ai/tools/find-owner
.ai/tools/find-callers
.ai/tools/find-tests
```

Do not reintroduce these unless there is a current VCM requirement.

## 3. Harness Manifest

`.ai/vcm-harness-manifest.json` is a VCM harness ownership and lifecycle record.
It is not a project-document index.

It should record:

- VCM-managed files and directories
- managed-block marker type and boundaries
- JSON merge ownership, especially `.claude/settings.json` hooks
- VCM agent and skill files
- harness tools under `.ai/tools/`
- generated context artifacts under `.ai/generated/`
- PR template managed blocks
- lifecycle labels
- runtime roots
- uninstall actions

It should not record:

- project-owned durable docs such as `docs/ARCHITECTURE.md`,
  `docs/TESTING.md`, `docs/known-issues.md`, `docs/plans/`, or module-level
  `ARCHITECTURE.md`
- `.ai/vcm/**` runtime files
- `.claude/worktrees/**` task worktrees
- placeholder `.gitkeep` files

VCM uninstall should remove only VCM-owned managed blocks or unchanged VCM-owned
whole files. User-authored project docs must not be deleted by harness uninstall.

## 4. Project-Owned Durable Docs

The current Rust layered example uses:

```text
docs/ARCHITECTURE.md
<module>/ARCHITECTURE.md
docs/TESTING.md
docs/known-issues.md
docs/plans/
```

Ownership:

- Architect owns `docs/ARCHITECTURE.md`, module-level `ARCHITECTURE.md`, and
  promotion of unresolved durable issues to `docs/known-issues.md`.
- Reviewer owns `docs/TESTING.md`, validation strategy, test adequacy, and final
  validation confidence.
- `docs/plans/` is for durable plans only when a large task needs one.
  Completed routine plans should be deleted after durable facts are promoted.

Project-owned durable docs are not VCM harness entries. VCM bootstrap may draft
or initialize them, but after creation they belong to the project.

## 5. Runtime State

Task runtime state lives under `.ai/vcm/` in the task worktree or connected repo.
It is task-local and temporary.

Current runtime files and directories:

```text
.ai/vcm/handoffs/
.ai/vcm/handoffs/messages/
.ai/vcm/handoffs/logs/
.ai/vcm/handoffs/architecture-plan.md
.ai/vcm/handoffs/review-report.md
.ai/vcm/handoffs/docs-sync-report.md
.ai/vcm/handoffs/final-acceptance.md
.ai/vcm/handoffs/known-issues.md
.ai/vcm/jobs/<job-id>/
.ai/vcm/bootstrap/session.json
.ai/vcm/bootstrap/bootstrap.log
```

App-local VCM task records live outside the connected repository:

```text
~/.vcm/projects/<project-id>/tasks/<task-slug>.json
```

Runtime state is deleted during task cleanup after useful facts are promoted to
code, tests, durable docs, PR text, or commit history.

## 6. Role Model

VCM uses four core roles:

- `project-manager`: user-facing flow manager. It routes work, tracks gates,
  asks the user for product or approval decisions, and performs final evidence
  acceptance. It does not perform technical analysis.
- `architect`: technical planner and docs-sync owner. It defines module/file
  responsibilities, public contracts, phase boundaries, risks, and durable docs
  updates.
- `coder`: implementation owner. It changes production code and baseline unit
  tests within the approved plan. It does not change architecture or durable
  docs.
- `reviewer`: independent validation owner. It reads code as needed, writes or
  updates tests, owns `docs/TESTING.md`, and decides validation sufficiency.
  Production fixes go back to coder; design conflicts go back to architect.

Roles work sequentially in one task worktree. If `git status` shows uncommitted
changes, commit them before handing off to another role.

## 7. Task Flow

Default code-change route:

```text
project-manager
  -> architect
  -> coder
  -> reviewer
  -> architect docs sync
  -> project-manager final acceptance
```

Shorter routes:

- Docs-only work: `project-manager -> architect -> project-manager final acceptance`
- Test-only or validation-only work:
  `project-manager -> reviewer -> project-manager final acceptance`

If a docs/test/validation-only task reveals required code, architecture, public
contract, dependency, durable-doc, or validation-strategy changes, route back
through the full code-change flow.

Complex tasks may be split by architect into phases. PM dispatches one
architect-defined phase at a time and must not split, merge, reorder, or redefine
phases. A role may return partial completed work and ask PM for continuation, but
workload or context size is not a valid reason to change the architect plan.

## 8. Route Messages

Use the `vcm-route-message` skill whenever a VCM role hands off work, asks a
question, reports a result, reports a blocker, or raises a finding.

Current route file path:

```text
.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
```

The skill is a route-file writing protocol. It should not encode the full role
policy; role permissions belong in root and role `CLAUDE.md` files.

The route file name is authoritative for source and target. Do not duplicate
`from` or `to` in frontmatter.

After writing or updating a route file, end the current Claude Code turn. Do not
poll route files, loop, wait for another role, paste directly into another role
terminal, or use Claude Code Task/Subagent to replace VCM role routing.

## 9. Validation

Validation is role-owned, not wrapper-owned.

VCM defines validation levels in root `CLAUDE.md`:

- L0: fast format/lint/typecheck/boundary/dependency/project checks
- L1: coder unit checks for changed behavior and direct regressions
- L2: module or integration checks
- L3: smoke E2E checks
- L4: release/full regression checks

The current Rust example does not use fixed `check-fast`, `check-changed`, or
`check-module` wrappers. Coder and reviewer use native Rust commands such as
`cargo test`, `cargo test -p <crate>`, `cargo check`, or project-specific
commands documented in `docs/TESTING.md`.

Long-running commands use `vcm-long-running-validation`, backed by:

```text
.ai/tools/run-long-check
.ai/tools/watch-job
```

This skill is role-independent. It only handles long-running command execution,
bounded waiting, file-backed status, timeout, and log summaries. The caller
decides where to record command evidence.

## 10. Generated Context

The current example has two generated artifacts:

```text
.ai/generated/module-index.json
.ai/generated/public-surface.json
```

`module-index.json` helps agents find layers, modules, manifests, module docs,
source files, test files, and workspace dependencies.

`public-surface.json` indexes crate-external Rust public APIs. It is a machine
index, not an architecture document.

Current generated-context support is Rust-only. The fixed installer provides
Rust generator tools as the default baseline, but it does not generate trusted
context by itself. Non-Rust projects must use project-specific generators before
`.ai/generated/*` is considered reliable.

There is no `test-map.json`. Rust unit tests live with source where appropriate;
integration tests use Cargo's normal test layout. Test files are discoverable
through `module-index.json`.

Generated artifacts are derived context. They must be regenerated by tools after
relevant source, manifest, module, or public API changes. They should not be
hand-edited as durable truth.

## 11. Harness Bootstrap

`vcm-harness-bootstrap` is the AI-assisted project understanding and refresh
procedure. It is not the deterministic installer.

It may read the repository and create or refresh project-specific content such
as:

- `CLAUDE.md` project context outside the VCM managed block
- `docs/ARCHITECTURE.md`
- module-level `ARCHITECTURE.md`
- `docs/TESTING.md`
- `docs/known-issues.md`
- `.ai/generated/module-index.json`
- `.ai/generated/public-surface.json`

It must not edit product source, product tests, package manifests, lockfiles,
deployment config, or secrets. It must not create new validation wrapper tools
during bootstrap.

Important claims should be marked as verified, inferred, unknown, or needing
human confirmation.

VCM should launch bootstrap as a visible temporary Claude Code terminal, not as
an invisible background task:

- run the deterministic fixed installer first
- start Claude Code in the connected repository root without a role agent
- set `VCM_TASK_REPO_ROOT`, `VCM_HARNESS_BOOTSTRAP=1`, `VCM_SESSION_ID`, and
  `VCM_API_URL`
- send a prompt that explicitly requires using `vcm-harness-bootstrap`
- log terminal output under `.ai/vcm/bootstrap/bootstrap.log`
- persist session metadata under `.ai/vcm/bootstrap/session.json`
- mark bootstrap complete only when project context, generated context,
  project architecture docs, module architecture docs, and testing docs are
  present and non-empty

The UI should expose both stages: fixed install status and bootstrap completion
status. A failed or disconnected bootstrap terminal should be restartable
without treating project-owned durable docs as VCM-owned manifest entries.

## 12. Final Acceptance

`vcm-final-acceptance` is PM's final evidence audit. PM must not use it for
technical design review, implementation review, source-code analysis, or test
adequacy analysis.

It checks whether required evidence exists and has clear decisions:

- architect plan or docs-sync decision when needed
- reviewer decision and validation evidence when needed
- known-issues disposition
- explicit user approval for high-risk exceptions
- file-scope explanation at changed-file-list level

Do not accept when required role evidence is missing, reviewer findings are
unresolved, docs sync is missing for durable changes, known-issues disposition is
missing, or unexplained high-risk files remain.

## 13. Documentation Lifecycle

Temporary files should be deleted after the task:

- route messages
- handoff artifacts
- job logs and status files
- raw terminal logs
- app-local task records
- routine completed plans

Durable facts should be moved into:

- code
- tests
- `docs/ARCHITECTURE.md`
- module-level `ARCHITECTURE.md`
- `docs/TESTING.md`
- `docs/known-issues.md`
- PR text
- commit history

Do not keep completed task notes as a permanent docs archive unless they remain
valuable durable planning knowledge.

## 14. Embedded Terminal

The embedded terminal should run through backend-managed PTY/session services,
not as front-end-only command execution. Frontend code displays and controls
session streams; process ownership, logs, task routing, and terminal safety belong
to backend services.

High-risk terminal work includes process lifecycle, cross-device control,
gateway-submitted prompts, and command authorization.

## 15. Mobile Gateway

VCM 0.2 gateway should expose a conservative mobile command surface through
Tencent iLink Bot API / Weixin DM.

Gateway settings and secrets live in app-local state:

```text
~/.vcm/settings.json
```

Gateway audit logs live outside connected repositories:

```text
~/.vcm/gateway/audit.jsonl
```

Rules:

- do not expose the full embedded terminal over Weixin
- do not store gateway credentials in connected repositories
- authenticate and authorize allowed Weixin users
- confirmation-gate state-changing or destructive commands
- audit state-changing commands
- treat gateway authorization and command parsing as high-risk code

## 16. Minimum VCM Rules

1.  Manifest records harness ownership only.
2.  Project durable docs are project-owned.
3.  Runtime state under `.ai/vcm/**` is temporary.
4.  No `.claude/commands/` by default.
5.  No optional agents by default.
6.  No role-command files.
7.  No `.ai/vcm/tasks/` in connected repos.
8.  No `docs/plans/active` or `docs/plans/completed`.
9.  No `test-map.json` by default.
10. No fixed `check-*` wrappers by default.
11. Use native project commands for validation.
12. Use generated context only when it has a real generator.
13. Coder owns implementation and baseline unit checks.
14. Reviewer owns independent validation and `docs/TESTING.md`.
15. Architect owns architecture planning and durable architecture docs.
16. PM owns routing and final evidence acceptance, not technical analysis.
17. Temporary documents are deleted; durable documents are updated.
