# VCM Claude Code Best Practices

Last updated: 2026-06-21

This is the current VCM-specific Claude Code / AI coding best-practices guide.
It is based on the latest `example/rust-layered` harness baseline.

Do not install this document into target repositories. Target repositories should
receive a concise root `CLAUDE.md` VCM block, role agents, repo-local VCM
skills, harness tools, Translator harness files, and project-owned
durable docs.

`docs/cc-best-practices.md` is archived as the old generic baseline. Current VCM
implementation should use this document and `docs/full-harness-baseline.md`.

## 1. Core Principle

VCM separates three concerns:

- Harness-managed files: VCM owns, upgrades, repairs, audits, and can uninstall
  these through deterministic installer definitions and managed markers.
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
.claude/agents/gate-reviewer.md
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
.github/pull_request_template.md
```

Derived bootstrap artifacts:

```text
.ai/generated/module-index.json
.ai/generated/public-surface.json
```

The generated artifacts are produced by generator tools during bootstrap or
later maintenance work. They are not hand-authored fixed templates.

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
.ai/vcm-harness-manifest.json
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

## 3. Harness Ownership

VCM harness ownership is defined by the installer code and by managed markers.
The current implementation does not use `.ai/vcm-harness-manifest.json`.

VCM-owned managed blocks use markers such as:

```md
<!-- VCM:BEGIN version=1 -->
...
<!-- VCM:END -->
```

For `.gitignore`, VCM uses:

```gitignore
# VCM:BEGIN version=1
...
# VCM:END
```

Whole-file and raw-file harness files are owned by VCM only when their paths are
listed by the fixed installer. VCM uninstall should remove only VCM-owned
managed blocks or unchanged VCM-owned whole files. User-authored project docs
must not be deleted by harness uninstall.

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
.ai/vcm/handoffs/architecture-plan.md
.ai/vcm/handoffs/review-report.md
.ai/vcm/handoffs/docs-sync-report.md
.ai/vcm/handoffs/final-acceptance.md
.ai/vcm/handoffs/known-issues.md
.ai/vcm/gate-reviews/
.ai/vcm/jobs/<job-id>/
.ai/vcm/harness-engineer/session.json
.ai/vcm/bootstrap/session.json
```

App-local VCM task records live outside the connected repository:

```text
<vcmDataDir>/projects/<project-id>/tasks/<task-slug>.json
```

Runtime state is deleted during task cleanup after useful facts are promoted to
code, tests, durable docs, PR text, or commit history.

## 6. Role Model

VCM uses four core roles:

- `project-manager`: user-facing flow manager. It routes work, tracks gates,
  asks the user for product or approval decisions, and performs final evidence
  acceptance. It does not perform technical analysis.
- `architect`: technical planner and docs-sync owner. It defines module/file
  responsibilities, cross-file callable surfaces, public contracts, phase
  boundaries, risks, and durable docs updates. Before coder work starts,
  architect writes the plan with a Scaffold Manifest whose rows have stable
  IDs, and materializes only the minimum necessary code scaffolding with
  durable contract comments and `VCM:CODE <ID>` placeholders.
- `coder`: implementation owner. It changes production code and baseline unit
  tests within the approved plan. It follows the architect-defined scaffold,
  implements and removes `VCM:CODE` placeholders, reports Scaffold Completion
  by ID in handoff, follows general coding standards, and does not change
  architecture or durable docs.
- `reviewer`: independent validation owner. It reads code as needed, writes or
  updates tests, owns `docs/TESTING.md`, and decides validation sufficiency.
  `docs/TESTING.md` must be current validation strategy, not a task log, and
  must include reviewable integration/E2E case lists. Production fixes go back
  to coder; design conflicts go back to architect.

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

## 7.1 Architecture Plan And Code Scaffolding

For code changes, the architect plan is not only a markdown handoff. It is a
plan document plus a Scaffold Manifest and the minimum necessary code
scaffolding.

The plan document defines affected modules, changed or created files, file
responsibilities, why each file is in scope, user-visible behavior changes,
non-private cross-file callable surfaces, docs impact, risks, and Replan
triggers.

The Scaffold Manifest carries task-specific file context for the current handoff:
stable row ID, why a file is in scope, what coder should implement, allowed
implementation freedom, expected `VCM:CODE` placeholders, durable code comment
needs, proof points, and Replan triggers. Task context, phase notes, handoff
instructions, temporary rationale, and coder guidance belong in the Scaffold
Manifest, not in source-code comments.

Code scaffolding materializes that plan in the repository before coder work
starts:

- new modules or files are created when needed
- durable behavior, contracts, invariants, error boundaries, or non-obvious
  logic are documented in code only when they should remain useful after the
  task is complete
- new or changed non-private callable surfaces are defined directly in code with
  signature shape and contract comments
- incomplete implementation bodies are marked with `VCM:CODE <Scaffold Manifest ID>`

Coder implements the marked placeholders and may add private helpers, but cannot
change file responsibilities, callable-surface signatures, or contract intent
without architect replan. Coder handoff reports Scaffold Completion by manifest
ID, including completed markers, remaining markers if any, private helpers
added, manifest deviations, and whether Replan is needed.

Architect may also enter Debug Mode when PM routes bugs, failing tests,
build/runtime failures, or unclear defects. Debug Mode allows architect to read
source/tests, edit code, add temporary diagnostics, write focused verification,
and run tests until the root cause is known. Architect may directly finish only
localized fixes that add no new module, add no new public or cross-file callable
surface, and stay under 500 changed production-code lines. Architect-run
validation is diagnostic evidence, not final acceptance; reviewer still performs
independent final validation.

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

Reviewer owns `docs/TESTING.md` as the current validation strategy, not as a
task log or diagnostic history. It must explain what is tested, why it matters,
how to run it, when to run it, and known gaps. Integration and E2E tests should
be documented as reviewable case lists with ID, scenario, entry point, what the
case proves, key assertions, when to run, and current limitations when relevant.
Superseded failures, temporary diagnostics, and per-task validation logs belong
in review reports, PR text, or durable known issues when they must persist.

Long-running commands use `vcm-long-running-validation`, backed by:

```text
.ai/tools/run-long-check
.ai/tools/watch-job
```

This skill is role-independent. It only handles long-running command execution,
bounded waiting, file-backed status, timeout, and log summaries. The caller
decides where to record command evidence.

VCM roles must not run background Bash; a `PreToolUse` hook
(`.ai/tools/vcm-bash-guard`) denies `run_in_background`, `nohup`, `setsid`,
`disown`, and trailing `&`. The only sanctioned long-running mechanism is
`.ai/tools/run-long-check` plus `.ai/tools/watch-job` through
`vcm-long-running-validation`. The job worker enforces a hard 60 minute
ceiling and a supervision lease that kills unwatched jobs; `watch-job` watches
in foreground windows of up to 8 minutes (exit `125` means watch again now),
and the VCM backend blocks turn-end while a validation job is running. Split
larger validation/build work or ask the user before suggesting anything longer
than 60 minutes.

## 10. Generated Context

The current example has two generated artifacts:

```text
.ai/generated/module-index.json
.ai/generated/public-surface.json
```

`module-index.json` helps agents find layers, modules, manifests, module docs,
source files, test files, and workspace dependencies.

`public-surface.json` indexes project public APIs, routes, and externally
consumed surfaces. It is a machine index, not an architecture document.

Current generated-context support covers Rust/Cargo projects and npm workspace
TypeScript/JavaScript projects. Other repository shapes must use
project-specific generators before `.ai/generated/*` is considered reliable.

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

VCM should run bootstrap through the project-scoped `harness-engineer` session,
not through a separate temporary terminal or invisible background task:

- run the deterministic fixed installer first
- start or resume the `harness-engineer` role in the connected repository root
- send a prompt that explicitly requires using `vcm-harness-bootstrap`
- persist the bootstrap run marker under `.ai/vcm/bootstrap/session.json`
- mark the bootstrap run complete when the `harness-engineer` Stop hook arrives

The UI should expose both stages: fixed install status and bootstrap completion
status. A failed or disconnected Harness Engineer session should be restartable
without treating project-owned durable docs as VCM-owned harness files.

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

Gateway product rules:

- support Weixin DM only, not group chat
- bind one mobile Weixin DM identity to one desktop VCM instance
- do not bind gateway to a single project or task
- let the bound phone select among the projects and tasks available to that VCM
  instance
- send ordinary mobile text only to the current task's `project-manager`
- do not send gateway messages directly to architect, coder, or reviewer
- when translation is enabled, send only translated English to PM and translated
  Chinese back to Weixin
- do not include the original Chinese text in PM prompts
- use one bound DM identity; do not maintain a multi-user allowlist

Gateway settings and secrets live in app-local state:

```text
<vcmDataDir>/gateway/settings.json
```

Gateway audit logs live outside connected repositories:

```text
<vcmDataDir>/gateway/audit.jsonl
```

Rules:

- do not expose the full embedded terminal over Weixin
- do not store gateway credentials in connected repositories
- reject or ignore messages outside the bound DM identity
- keep the MVP PM-only and avoid approve/reject/start/stop workflow commands
- audit gateway state changes and message handling with secrets redacted
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
13. Coder owns implementation, baseline unit checks, scaffold completion, and general coding standards.
14. Reviewer owns independent validation and `docs/TESTING.md` as current testing strategy with integration/E2E case lists.
15. Architect owns architecture planning, code scaffolding, Debug Mode, and durable architecture docs.
16. PM owns routing and final evidence acceptance, not technical analysis.
17. Temporary documents are deleted; durable documents are updated.
