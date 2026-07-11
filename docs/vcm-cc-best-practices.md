# VCM Claude Code Best Practices

Last updated: 2026-07-10

This is the current VCM-specific Claude Code / AI coding best-practices guide.
It describes how VCM's harness, roles, runtime state, and task workflow should
fit together. It is not installed into target repositories. Target repositories
receive the concise root `CLAUDE.md` block, role agents, repo-local skills,
harness tools, generated-context support, and project-owned durable docs.

`docs/cc-best-practices.md` is archived as the generic Claude Code harness
reference. Use this document for VCM-specific behavior.

## 1. Core Principle

VCM separates three kinds of content:

- **Harness-managed files**: fixed VCM templates, managed blocks, hooks, role
  agents, skills, and runtime tools owned by the installer.
- **Project-owned durable docs**: architecture, testing, module docs, and known
  issues. VCM bootstrap may draft them, but they become project truth.
- **Runtime state**: task/session/message/job/gate/translation state written
  during execution and cleaned or reconciled when the task, app, or project
  changes state.

Temporary coordination files should disappear. Durable facts should be promoted
to source, tests, durable docs, commits, PR text, or known issues.

## 2. Fixed Harness Baseline

The current baseline is represented by `example/rust-layered` and by the fixed
installer definitions.

Fixed installer files:

```text
CLAUDE.md
.gitignore
.ai/vcm-harness-manifest.json
.claude/settings.json
docs/GLOSSARY.md
docs/CODING_STANDARDS.md
.claude/agents/project-manager.md
.claude/agents/architect.md
.claude/agents/coder.md
.claude/agents/tester.md
.claude/agents/gate-reviewer.md
.claude/agents/translator.md
.claude/agents/harness-engineer.md
.claude/agents/vcm-coder-worker.md
.claude/skills/vcm-route-message/SKILL.md
.claude/skills/vcm-final-acceptance/SKILL.md
.claude/skills/vcm-long-running-validation/SKILL.md
.claude/skills/vcm-harness-bootstrap/SKILL.md
.claude/skills/vcm-gate-review/SKILL.md
.claude/skills/vcm-report-harness-issue/SKILL.md
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

Runtime roots:

```text
.ai/vcm/
.claude/worktrees/
```

Not part of the current fixed baseline:

```text
.claude/commands/
.claude/agents/optional/
.ai/task-specs/
.ai/vcm/tasks/
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

VCM harness ownership is defined by fixed installer entries, managed markers,
and `.ai/vcm-harness-manifest.json`.

The manifest records:

- schema and manager
- `harnessVersion`, using the VCM package version
- fixed entries and ownership mode
- runtime roots
- JSON ownership for `.claude/settings.json` hooks/env

VCM may ignore a change where only `harnessVersion` differs. The manifest should
be updated together with real fixed-harness changes, not as standalone version
churn.

Managed blocks use:

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

Rules:

- VCM may replace content inside managed blocks.
- VCM must preserve user-authored content outside managed blocks.
- Whole-file harness files are VCM-owned only when listed by the fixed
  installer.
- Project durable docs are not VCM-owned harness files after creation.
- `.claude/settings.json` is JSON-merged; VCM owns only its hook/env entries.

## 4. Project-Owned Durable Docs

The current project doc baseline is:

```text
docs/GLOSSARY.md
docs/CODING_STANDARDS.md
docs/ARCHITECTURE.md
<module>/ARCHITECTURE.md
docs/TESTING.md
docs/known-issues.md
docs/plans/               # only for durable long-running plans
```

Ownership:

- Architect owns architecture planning, module boundaries, code scaffolding,
  Debug Mode, docs sync, and durable architecture docs.
- Tester owns independent validation and `docs/TESTING.md` as current
  validation strategy, with integration/E2E case lists.
- PM owns routing and final evidence acceptance, not technical analysis.
- Coder owns implementation, baseline unit/contract/regression tests, scaffold
  completion, and ordinary coding standards.

Durable docs must describe current project truth. They must not become task
logs, terminal logs, or archives of intermediate attempts.

## 5. Runtime State

Task runtime state lives under `.ai/vcm/` in the task worktree. Project-scoped
tool state can live under `.ai/vcm/` in the connected base repo.

Current runtime paths include:

```text
<taskRepoRoot>/.ai/vcm/handoffs/
<taskRepoRoot>/.ai/vcm/handoffs/messages/
<taskRepoRoot>/.ai/vcm/handoffs/role-commands/
<taskRepoRoot>/.ai/vcm/handoffs/architecture-plan.md
<taskRepoRoot>/.ai/vcm/handoffs/architecture-diagnosis.md
<taskRepoRoot>/.ai/vcm/handoffs/coder-completion.md
<taskRepoRoot>/.ai/vcm/handoffs/test-report.md
<taskRepoRoot>/.ai/vcm/handoffs/docs-sync-report.md
<taskRepoRoot>/.ai/vcm/handoffs/final-acceptance.md
<taskRepoRoot>/.ai/vcm/handoffs/known-issues.md
<taskRepoRoot>/.ai/vcm/gate-reviews/
<taskRepoRoot>/.ai/vcm/jobs/<job-id>/
<baseRepoRoot>/.ai/vcm/translations/
<baseRepoRoot>/.ai/vcm/harness-engineer/
<baseRepoRoot>/.ai/vcm/bootstrap/
<baseRepoRoot>/.ai/vcm/harness-feedback/
```

App-local records live under `<vcmDataDir>/projects/` and app settings live in
`<vcmDataDir>/settings.json`.

Runtime recovery on project connect should clear or reconcile stale running
state, recover project tool sessions, recover task rounds, clear impossible
activity, and remove temporary translation runtime leftovers. Runtime process
ids are in-memory checks, not durable project data.

## 6. Task and Worktree Model

VCM is worktree-only:

```text
one task
  -> one branch
  -> one task worktree
  -> one handoff root
  -> one VCM role-session set
```

Tasks do not run directly in the connected base repo. Roles for the same task
share the same task worktree and hand off sequentially.

Harness changes that affect the task should be made in the active task
worktree. Fixed-harness updates should be committed immediately so users review
commit diff, not scattered unstaged changes. Harness Engineer owns AI bootstrap
and harness-maintenance commits made during its turn.

## 7. Role Model

VCM roles:

- `project-manager`: user-facing orchestration hub, PM Managed Mode owner,
  routing owner, gate tracker, final evidence acceptance owner, and PR
  preparation owner.
- `architect`: architecture plan, Scaffold Manifest, code scaffolding, Debug
  Mode, complete task planning, module docs, and docs sync.
- `coder`: implementation inside the approved plan, scaffold completion,
  baseline tests, and cleanup of task-only code markers/comments.
- `tester`: independent validation, test adequacy, missing test additions,
  integration/E2E case assessment, test report, and `docs/TESTING.md`.
- `gate-reviewer`: optional VCM flow role. It is visible when any Gate Review
  gate is enabled or a gate-reviewer session already exists. It is task-scoped
  in the active worktree, uses normal Claude hook/Round/translation handling,
  and does not participate in route-file dispatch.

Tool roles:

- `translator`: project-scoped translation tool role. It is not part of VCM
  workflow round completion and does not appear in the top role tab bar.
- `harness-engineer`: project-scoped harness maintenance tool role. It is not
  part of task workflow round completion.

Project-scoped tool roles persist project state under the base repo, but when
they perform task work their execution cwd must be the active task worktree.
When task context changes, VCM should move/resume them safely instead of letting
old worktree cwd state leak into the next task.

## 8. Launch Template and Permissions

Launch template settings live in app preferences, not in the target repository.
The template stores permission mode, model, and effort for every VCM role.

Permission options:

```text
bypassPermissions
plan
default
```

`bypassPermissions` is the default because VCM expects users to run in a
controlled local boundary such as a Dev Container, VM, or trusted task
worktree. The template also stores task auto-orchestration preference.

One-click start starts or resumes the four core VCM roles. If any Gate Review
gate is enabled, it also starts or resumes Gate Reviewer with the saved template
entry. Translator and Harness Engineer are controlled from their own tool-role
panels, not from the main task launch template.

## 9. PM Flow and Managed Mode

Default code-change route:

```text
project-manager
  -> architect
  -> coder
  -> tester
  -> architect docs sync
  -> project-manager final acceptance
```

Additional routes:

- A task that begins with Debug or Architecture Diagnosis and produces code
  changes uses a complete code-delivery flow:
  `project-manager -> architect mode -> code-diff Gate Review -> tester -> architect docs sync -> project-manager final acceptance`
- Debug or Architecture Diagnosis entered from an active main flow is a branch:
  suspend the main flow, record its resume point, run the mode through code-diff
  Gate Review and tester, then return to that resume point without branch-level
  final acceptance.
- An analysis-only primary Architecture Diagnosis completes from its diagnosis
  result without final acceptance.
- Docs-only work: `project-manager -> architect -> project-manager completion`
- Test-only or validation-only work:
  `project-manager -> tester -> project-manager completion`

If a docs/test/validation-only task reveals required code, architecture, public
contract, dependency, durable-doc, or validation-strategy changes, route back
through the full code-change flow.

PM Managed Mode applies only when the user explicitly requests it. PM must drive
the task to completion, route ordinary technical decisions to the responsible
role, and ask the user only when user intent, authorization, real-world
constraints, external accounts/secrets/data access, cost, production permission,
sensitive data access, durable-doc conflict, or a proven requested-outcome change
requires explicit user direction.

## 10. Architecture Plan and Scaffold

For code changes, architect writes `.ai/vcm/handoffs/architecture-plan.md`.

The plan must cover:

- accepted scope
- current code reality
- architecture decision
- module/file plan
- public surface impact
- Scaffold Manifest
- Tester Coverage Hints
- docs impact
- known risks
- coder handoff notes

The Scaffold Manifest carries task-specific context for coder. Task context,
temporary rationale, implementation-order notes, and coder guidance belong in
the manifest, not in permanent source comments.

Code scaffolding may create files and define non-private callable surfaces, but
incomplete implementation must use `VCM:CODE <Scaffold Manifest ID>` markers.
Coder removes/completes those markers and reports Scaffold Completion by ID.

The active architecture plan should describe the full accepted task scope. It
may include implementation order, but that order must not defer requested scope.
The plan is the current executable plan, not a changelog; revisions should
replace superseded decisions and stale scaffold rows instead of appending
history.

## 11. Route Messages

Use `vcm-route-message` for every VCM role dispatch, question, result, blocker,
or finding.

Route path:

```text
.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
```

The filename is authoritative for source and target. Do not duplicate `from` or
`to` in frontmatter.

After writing or updating a route file, the role must end the current Claude
Code turn. Roles must not poll route files, loop, wait for another role, paste
directly into another role terminal, or use Claude Code Task/Subagent to replace
VCM role routing.

PM may use a lightweight relay message when forwarding a user's clarification,
confirmation, rejection, preference, or small constraint to an active role.

## 12. Gate Review

Gate Review gates are globally configured in VCM app settings and default off:

```text
architecture-plan
validation-adequacy
code-diff
```

PM must run `vcm-gate-review` at each trigger point. The tool is the source of
truth for whether a gate is disabled, not required, already approved, running,
started, or failed.

Input policy:

- `architecture-plan` uses `.ai/vcm/handoffs/architecture-plan.md` as its core
  input. Missing or empty core input is `not_required`.
- `validation-adequacy` uses `.ai/vcm/handoffs/test-report.md` as its core
  input. Missing or empty core input is `not_required`.
- `code-diff` is triggered by PM after Coder `Decision: ready_for_review` or an
  Architect Debug completed code fix. PM does not inspect commits; the tool
  reviews committed inputs, returns `not_required` when there are no new
  commits, and fails to start when the worktree has uncommitted changes.
- Gates avoid duplicate review by comparing input hashes.

Gate Reviewer writes reports under:

```text
.ai/vcm/gate-reviews/
```

Gate Reviewer returns only `approve` or `request_changes`, does not run tests,
does not edit files, and does not choose fix owners, Replan, or user-intervention
needs. PM routes `architecture-plan` and `code-diff` findings to architect, and
`validation-adequacy` findings to tester.

## 13. Validation

Validation is role-owned, not wrapper-owned.

VCM validation levels:

- L0: fast format/lint/typecheck/boundary/dependency/project checks
- L1: coder unit checks for changed behavior and direct regressions
- L2: module or integration checks
- L3: smoke E2E checks
- L4: release/full regression checks

The fixed harness does not install `check-fast`, `check-changed`, or
`check-module` wrappers. Roles use native project commands documented in
`docs/TESTING.md`.

Tester owns validation adequacy. Important features should have integration
or E2E coverage unless the test report explains why such coverage is
unnecessary or unavailable. Tests must assert real behavior, not mock-call
rituals or fixture-specific shortcuts.

Long-running validation uses `vcm-long-running-validation` backed by:

```text
.ai/tools/run-long-check
.ai/tools/watch-job
```

VCM roles must not run background Bash. `vcm-bash-guard` denies
`run_in_background`, `nohup`, `setsid`, `disown`, and trailing `&`.

## 14. Generated Context

Current generated artifacts:

```text
.ai/generated/module-index.json
.ai/generated/public-surface.json
```

`module-index.json` helps agents find layers, modules, manifests, module docs,
source files, test files, and workspace dependencies.

`public-surface.json` indexes public APIs, routes, and externally consumed
surfaces. It is a machine index, not an architecture document.

Current support covers Rust/Cargo projects and npm workspace TypeScript /
JavaScript projects. Other repository shapes need project-specific generators
before `.ai/generated/*` is considered reliable.

Generated artifacts are derived context. Regenerate them after relevant source,
manifest, module, or public API changes. Do not hand-edit them as durable truth.

## 15. Harness Bootstrap and Feedback

`vcm-harness-bootstrap` is the AI-assisted project understanding and refresh
procedure. It is not the deterministic fixed installer.

Bootstrap may create or refresh:

- project context outside VCM managed blocks in `CLAUDE.md`
- `docs/GLOSSARY.md`
- `docs/CODING_STANDARDS.md`
- `docs/ARCHITECTURE.md`
- module-level `ARCHITECTURE.md`
- `docs/TESTING.md`
- `docs/known-issues.md`
- `.ai/generated/module-index.json`
- `.ai/generated/public-surface.json`

Bootstrap must not edit product source, product tests, package manifests,
lockfiles, deployment config, secrets, or VCM managed blocks.

VCM runs bootstrap through project-scoped `harness-engineer`:

- run deterministic fixed installer first
- start/resume Harness Engineer with execution cwd set to the active task
  worktree
- ask it to use `vcm-harness-bootstrap`
- let Harness Engineer create its own bootstrap commit
- mark bootstrap complete from the Harness Engineer `Stop` hook

Reusable harness issues are reported through `vcm-report-harness-issue`.
Harness Engineer verifies them when idle, proposes diffs or VCM issue drafts,
and waits for user approval before applying normal harness changes.

Task Harness Retrospective can be triggered manually or automatically after a
normal Round end when final acceptance evidence exists. It should inspect the
completed task workflow and deliverables for reusable harness problems, not
re-review the business feature itself.

## 16. Final Acceptance

`vcm-final-acceptance` is PM's final evidence audit for a complete code-delivery
flow, including a primary Debug or Architecture Diagnosis flow that produced
code changes. A Debug or Diagnosis branch inside another active flow returns to
that flow's recorded resume point and does not run its own final acceptance.
PM must not use final acceptance for analysis-only or unfinished branch flows, or for
technical design review, implementation review, source-code analysis, or test
adequacy analysis.

It checks whether required evidence exists and has clear decisions:

- architecture plan or docs-sync decision when needed
- tester test result and validation evidence when needed
- required Gate Review decisions when enabled
- known-issues disposition
- cleanup status
- explicit user approval for high-risk exceptions
- changed-file scope explanation

Do not accept when required role evidence is missing, tester findings are
unresolved, docs sync is missing for durable changes, known-issues disposition is
missing, or unexplained high-risk files remain.

## 17. Translation

Translation is a project-scoped tool feature powered by the Claude Code
`translator` role.

Rules:

- Translator is not a VCM flow role and must not affect Round completion.
- Conversation translation reads semantic Claude transcript JSONL files, not
  raw PTY output.
- Translation output is delivered through backend-managed feed/cache state; the
  frontend displays data and explicit user actions only.
- Conversation and file translation share `<baseRepoRoot>/.ai/vcm/translations/`.
- Conversation result files are temporary runtime artifacts.
- File translation output is stored under the translations directory; runtime
  progress/helper files are cleaned when no longer useful.
- Translation memory is explicit project memory:
  `glossary.md`, `style-guide.md`, `project-context.md`, and `decisions.md`.
- Translation source text is treated as untrusted content to translate, not
  instructions to obey.

Supported output modes:

```text
round-final       # final reply when the Round ends normally
pm-final-only     # PM final reply
final-only        # each role final reply
all               # all translatable replies
```

Default target language is Chinese (`zh-CN`). Supported targets are Chinese,
Japanese, Korean, French, German, and Spanish.

## 18. Gateway

Gateway is a mobile control surface for one local VCM instance, not a remote
terminal.

Supported channels:

- Weixin iLink DM
- Lark DM or group messages where the bot is mentioned

Rules:

- Gateway sends ordinary mobile text only to the current task's
  `project-manager`.
- Gateway never sends directly to architect, coder, tester, or Gate Reviewer.
- Gateway can push PM replies to the active mobile chat while enabled.
- Gateway state, credentials, and audit logs live in app-local state, not
  connected repositories.
- Lark uses the most recent active reachable chat as the PM reply target.
- When Gateway is on, browser pause-alert UI/sound should not block the flow;
  Gateway becomes the notification path.
- Gateway translation should reuse the existing translation result when
  available and avoid duplicate translation work.
- `/retry` retries the latest failed Gateway output translation when possible.

Gateway must stay conservative: no full terminal exposure, no arbitrary shell
commands, and no direct role routing from mobile chat.

## 19. Runtime, Hooks, and Recovery

VCM owns process/session runtime in backend services. Frontend code displays
state, sends explicit user actions to backend APIs, and must not run hidden
timers that dispatch messages to Claude Code.

Claude hooks:

- `UserPromptSubmit`: confirms Claude accepted a prompt, records session data,
  starts/continues the Round, confirms routed messages, and records conversation
  boundaries.
- `Stop`: ends the active Turn, starts the stop window, and triggers pending
  route delivery.
- `StopFailure`: schedules recovery for retryable failures, handles manual
  interruption, and eventually records recovery failure.
- `PostCompact`: refreshes session metadata without changing running/idle flow
  state.
- `PermissionRequest`: returns the configured local permission decision.

Role retry is enabled by default. Retryable StopFailure events retry up to 20
times: first after 1 minute, then +1 minute per attempt. Non-retryable errors
include authentication, billing, invalid request, model-not-found, and
max-output-token failures.

Round state is backend-owned. Stop starts a 10 second settle window; a new
`UserPromptSubmit` inside the window continues the same Round. If no new prompt
arrives, the Round stops. Flow pause alert sound is a preference; the stopped
Round itself remains visible even when sound is off.

Session IDs are persisted only after the first real `UserPromptSubmit`.
Restart clears the stored Claude session id until the next accepted prompt.
Resume failure must fall back or surface a clear error; VCM must not keep
polling a missing terminal session forever.

## 20. Minimum VCM Rules

1.  Fixed harness ownership is defined by installer entries, managed markers,
    and `.ai/vcm-harness-manifest.json`.
2.  Project durable docs are project-owned.
3.  Runtime state under `.ai/vcm/**` is temporary or recoverable.
4.  All tasks use task worktrees.
5.  Roles for one task share one task worktree and hand off sequentially.
6.  Gate Reviewer is an optional VCM flow role, task-scoped when used.
7.  Translator and Harness Engineer are project-scoped tool roles, not flow
    roles.
8.  No `.claude/commands/` by default.
9.  No optional agents by default.
10. Role-command files are task runtime dispatch inputs, not fixed harness
    files or inter-role route messages.
11. No `.ai/vcm/tasks/` in connected repos.
12. No `test-map.json` by default.
13. No fixed `check-*` wrappers by default.
14. Use native project commands for validation.
15. Use generated context only when it has a real generator.
16. Coder owns implementation and scaffold completion.
17. Tester owns independent validation and current testing strategy.
18. Architect owns architecture planning, code scaffolding, Debug Mode, and
    durable architecture docs.
19. PM owns routing and final evidence acceptance, not technical analysis.
20. Temporary documents are deleted; durable documents are updated.
