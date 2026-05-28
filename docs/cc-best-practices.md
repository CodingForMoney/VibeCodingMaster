# Claude Code AI Coding Best Practices 

Date: 2026-05-22


Core principle:

> AI coding reliability comes from two things: **public contract design** prevents architecture drift, and **public contract tests** prevent behavior drift.

Reliable loop:

```text
task spec
  -> file responsibilities / public function contracts
  -> small-step implementation
  -> layered testing
  -> architecture and acceptance checks
  -> documentation sync
  -> Replan when needed
```

## 1. Basic Principles

Treat Claude Code as a smart engineer with limited context. It needs clear boundaries, executable feedback, and an acceptance checklist.

Good tasks for Claude:

- reproducible, testable bug fixes
- small to medium features with clear boundaries
- implementation that follows existing patterns
- test additions, PR review comment fixes, documentation drafts
- codebase exploration, explanation, onboarding

Do not hand these directly to Claude:

- “refactor the whole system”
- “figure it out” tasks for performance, auth, permissions, payments, schema, or data deletion
- complex business changes without a spec, tests, or acceptance criteria

High-risk tasks must reduce Claude’s autonomy:

- auth / permission
- payment / billing
- database schema / migration
- public API / SDK
- protocol / serialization
- data deletion / privacy
- concurrency / distributed consistency
- security-sensitive infrastructure

These tasks require a plan, public contracts, test contracts, validation commands, and human review.

Behavioral guardrails:

- State key assumptions before coding; call out unclear requirements, boundaries, or acceptance criteria.
- When multiple interpretations are reasonable, do not choose silently; explain the difference and tradeoff, and ask for confirmation when needed.
- Prefer the simplest solution that satisfies the task; do not add unrequested features, configuration, extension points, or abstractions.
- Touch only files required by the task; do not clean up, format, or refactor adjacent code opportunistically.
- Clean up only unused imports, variables, functions, or test leftovers created by the current change.
- Report-but-don't-act: when noticing an issue outside the current task scope (unrelated dead code, doc drift, adjacent bug, architecture concern, security smell), record it in `.ai/state/known-issues.md` and continue; do not act on it without an explicit task.
- Every diff line must trace to the task goal, public contract, test contract, or required documentation sync.
- For multi-step tasks, define the validation check for each step.

## 2. Repo Harness Structure

Recommended structure:

```text
repo/
  CLAUDE.md

  docs/
    ARCHITECTURE.md
    MODULE_MAP.md
    TESTING.md
    SECURITY.md
    DEPENDENCY_RULES.md
    exec-plans/
      active/
      completed/

  .claude/
    settings.json
    skills/
    agents/
      architect.md
      coder.md
      reviewer.md
      optional/
        security-specialist.md
        migration-specialist.md
        performance-specialist.md
        frontend-qa.md
    commands/

  .ai/
    task-specs/
    handoffs/
      <task-slug>/
        architecture-plan.md
        implementation-log.md
        validation-log.md
        review-report.md
    state/
      progress.md
      decisions.md
      validation-log.md
      known-issues.md
      scratch.md
    generated/
      module-index.json
      test-map.json
      public-surface.json

  tools/
    check-fast
    check-changed
    check-module
    check-e2e-smoke
    check-boundaries
    check-public-surface
    check-contract-tests
    check-generated-artifacts
    check-docs-freshness
    check-agent-rules
```

Required large-project baseline:

For a large project, the harness is not a maturity ladder. Treat the structure above as the baseline before letting Claude Code make non-trivial changes.

Missing pieces are not an accepted intermediate design. If a legacy project is missing part of the harness, record the gap in `.ai/state/known-issues.md` or an execution plan with owner, risk, and target date. High-risk work must wait until the relevant rules, role agents, docs, and validation commands exist.

Minimum baseline for non-trivial AI coding:

- root `CLAUDE.md`
- module-local `CLAUDE.md` for edited modules
- architecture, module map, testing, security, and dependency docs
- role agents for architecture/planning, coding, and independent review/testing
- task specs, handoff artifacts, progress state, decisions, validation logs, known issues, and generated context artifacts
- fast, changed-file, module, boundary, public-surface, contract-test, generated-artifact, docs-freshness, and agent-rule checks
- hooks or CI gates for protected files, validation, docs sync, public contracts, and test quality

## 3. `CLAUDE.md`

`CLAUDE.md` is an entry map, not a project encyclopedia.

Include:

- one-sentence project description
- repository map
- common build / test / lint / typecheck commands
- documents Claude should read before starting
- module boundaries and forbidden actions
- high-risk areas
- files not to touch
- Definition of Done
- what to do when unsure

Do not include:

- long architecture essays
- full descriptions of every file
- complete business rule manuals
- all API docs
- long style guides
- vague rules like “write high-quality code”
- frequently changing task state

Root template:

```md
# CLAUDE.md

## Project Map

- `services/`: production services
- `packages/`: shared libraries
- `apps/`: user-facing applications
- `docs/`: architecture, testing, security, module docs
- `tools/`: validation and developer utilities

## Start Here

- Read `docs/ARCHITECTURE.md` for system overview.
- Read `docs/MODULE_MAP.md` before choosing files.
- Read module-local `CLAUDE.md` before editing a subdirectory.
- Prefer existing APIs, services, helpers, and patterns before adding abstractions.

## Commands

- Fast validation: `tools/check-fast`
- Changed files validation: `tools/check-changed`
- Module validation: `tools/check-module <module>`

## Default Role: Project Orchestrator

When no explicit `--agent` is used, act as the project orchestrator.

Responsibilities:

- Clarify the task with the user.
- Classify task severity.
- Select the required role route.
- Ensure required handoff artifacts exist.
- Ask the user to start the correct `claude --agent <role>` session when needed.
- Track progress, blockers, validation, docs sync, and Replan.
- Verify that architect, coder, reviewer, and specialist outputs satisfy the required process.
- Summarize final status, validation evidence, plan deviations, and remaining risks.

Do not:

- Own architecture, coding, and independent review in the same non-trivial task.
- Let coding start before the required architecture-plan.md exists.
- Approve coder output without reviewer evidence for complex or high-risk work.
- Bypass the required role route for high-risk work.
- Convert process coordination into a do-everything coding session.

## Role Sessions

- For complex features, cross-module changes, refactors, public API changes, schema changes, auth, payment, permission, or security-sensitive work, start Claude Code with an explicit role: `claude --agent <role>`.
- Default core roles are `architect`, `coder`, and `reviewer`.
- Do not let one coding session own architecture/plan decisions, implementation, final testing responsibility, and review.
- Role outputs are exchanged through `.ai/handoffs/<task-slug>/`, not through chat history.
- When the required role route includes `architect`, coding must not start until the architecture and plan artifact exists.
- If the current session was not started with the required role, stop and ask the user to restart with `claude --agent <role>`; do not pretend to be that role inside the wrong session.
- Critical global rules may be repeated in role agent files for defense in depth, but repeated rules must use stable rule IDs and be checked by `tools/check-agent-rules`. Do not maintain untracked manual copies.

## Default Behavior

- State assumptions before coding; ask when requirements, boundaries, or acceptance criteria are unclear.
- When multiple interpretations are reasonable, do not choose silently; explain the difference and tradeoff, and ask for confirmation when needed.
- Prefer the simplest solution that satisfies the task; do not add speculative features, abstractions, configuration, or flexibility.
- Touch only files required by the task; do not clean up or refactor unrelated code.
- Clean up only unused code created by the current change.
- Report-but-don't-act: record out-of-scope issues in `.ai/state/known-issues.md`; do not act on them.
- Every changed line must trace to the task goal, public contract, test contract, or required documentation sync.
- For multi-step tasks, define the validation check for each step before implementing it.

## Forbidden

- Do not edit generated, vendor, third-party, lock, or secret files unless explicitly requested.
- Do not introduce dependencies without approval.
- Do not bypass tests, lint, typecheck, auth, permissions, or security checks.
- Public API, schema, auth, payment, and permission changes require explicit plan and approval.
- Do not cross module boundaries through internal imports.

## Definition of Done

- Diff is scoped to the task.
- Required validation passes.
- New or modified public functions have contract tests.
- Behavior changes have regression tests unless impractical.
- Plan, architecture, public contract, test strategy, and module responsibility changes are reflected in docs.
- Follow-ups are recorded in `.ai/state/known-issues.md` or the execution plan.
```

Large projects must have module-local `CLAUDE.md` files:

```text
services/billing/CLAUDE.md
services/auth/CLAUDE.md
apps/web/CLAUDE.md
packages/ui/CLAUDE.md
```

Module files should define:

- module responsibility
- important files
- public entry points
- forbidden dependencies
- test commands
- historical pitfalls
- high-risk behavior

## 4. Task Specs and Planning Granularity

Every task must define at least **file-level responsibilities**.

Ordinary PRs, features, and bug fixes must define **public function contracts**.

Public functions include:

- exported functions
- public methods
- module APIs
- service / controller / repository public entry points
- route handlers / command handlers
- hooks
- externally used component props

Planning granularity:

```text
exploration / research             module level + candidate files
large rewrite / greenfield         module level + file responsibilities, refine by phase
ordinary feature                   file responsibilities + public function contracts
bug fix                            touched files + affected public behavior
public API / SDK / permissions     contract level, interface-level design when needed
small internal change              file responsibilities + existing function behavior constraints
```

Principles:

```text
module boundaries: must be explicit
file responsibilities: must be explicit
public function contracts: required for ordinary tasks
private helpers: depends on risk
function internals: usually not fixed in advance
```

Large tasks can start with modules, directories, file responsibilities, data flow, and dependency direction. Before each implementation phase, define the public function contracts involved in that phase.

### 4.1 Task Spec Template

```md
# Task Spec

## Goal

## Background

## Scope

## Non-goals

## Task Severity

## Required Role Route

## Handoff Directory

## Relevant Files

## File Responsibilities

For every file likely to be edited, define its responsibility.

## Public Surface Contract

For ordinary PRs, feature additions, bug fixes, and high-risk changes, define:

- public/exported functions or methods
- module APIs
- inputs and outputs
- side effects
- error behavior
- dependency rules
- signatures that must remain unchanged

For large rewrites or greenfield work, each implementation phase must define public surface before coding.

## Test Contract

For every new or modified public function, define required tests.

Minimum:
- happy path
- boundary or failure path

Business-critical functions also cover:
- invalid input
- permission or state constraints
- side effects
- idempotency
- historical regressions

## Architecture Constraints

## Stop Conditions

## Expected Behavior

## Validation Commands

## Definition of Done

## Risks

## Questions
```

### 4.2 Stop Conditions

Stop and update the plan before editing if:

- current session role does not match the required role route
- public API change seems necessary
- DB schema change seems necessary
- planned contract duplicates an existing API
- module boundaries make the plan inaccurate
- implementation needs to differ from the approved plan
- related architecture, module, testing, or docs would become stale

## 5. Workflows

### 5.1 Small Change

Use for single-file bugs, simple tests, copy, config, or known-pattern changes.

```text
prompt
  -> edit
  -> focused validation
  -> review diff
  -> commit
```

Prompt:

```text
Fix the edge case in `src/foo.ts`.
Keep the diff minimal.
Run `pnpm test src/foo.test.ts`.
Report the validation result.
```

### 5.2 Complex Change

Use for multi-file changes, new features, business rules, or uncertain implementation paths.

```text
Explore
  -> Plan
  -> approval
  -> implement phase 1
  -> validate
  -> review
  -> commit
  -> implement next phase
```

Exploration must not edit files:

```text
Explore the codebase and create an implementation plan.
Do not edit files yet.

Include:
- relevant files
- proposed changes
- public surface contract
- tests to add/update
- validation commands
- risks
- questions
```

### 5.3 Debug

```text
reproduction
  -> hypotheses
  -> instrumentation
  -> reproduce
  -> inspect logs
  -> targeted fix
  -> regression test
```

Prompt:

```text
Debug this issue. Do not guess a fix yet.

First:
1. List plausible hypotheses.
2. Identify where to inspect.
3. Propose the smallest validation command.

Then make a targeted fix and add regression test.
```

### 5.4 TDD

Use for bugs, parsers, serializers, validators, calculators, state machines, public API behavior, and functionality with clear input/output.

```text
write failing contract test
  -> confirm it fails
  -> freeze test expectations
  -> implement
  -> do not weaken test
  -> pass focused test
  -> run module validation
```

### 5.5 Review

Review should prioritize:

- correctness
- security / permission risk
- regressions
- missing tests
- architecture boundary violations
- public contract mismatch

Use a `reviewer` role session for complex or high-risk tasks. A fresh review session or reviewer subagent is acceptable for smaller scoped changes. Do not let the same session that implemented the change be the only reviewer.

## 6. Context Management

One session should correspond to one coherent task.

Continue the same session when:

- still working on the same bug / feature / review comment
- prior exploration context is needed
- fixing a problem Claude just introduced

Start a new session when:

- switching tasks
- moving from implementation to independent review
- the current session has read too many unrelated files
- Claude repeats the same mistake
- a phase is completed and committed
- fresh eyes are needed

Rule of thumb:

> Continue when the next action depends on previous reasoning. Start fresh when the next action needs independent judgment. Start fresh when Claude gets confused.

For large-codebase exploration, use read-only subagents. Keep only findings, file paths, and the plan in the main session.

Context should include:

- files to edit
- related tests
- module rules
- failure logs
- architecture boundaries
- concrete examples
- acceptance criteria

Do not include:

- many unrelated files
- full old chat histories
- long external docs
- stale design docs
- unrelated CI logs

## 7. Role-Based Agent Sessions

For large projects, the default execution model should be role-based sessions, not dynamic role routing inside one main Claude conversation.

The main session should be the project orchestrator: it owns communication, severity classification, role routing, progress tracking, and process verification. It does not own architecture, coding, and independent review for the same non-trivial task.

Do not make one generic Claude session own architecture, planning, coding, final testing, and review for non-trivial work. That blurs responsibility and makes acceptance weak.

### 7.1 Main Session: Project Orchestrator

When Claude Code is started without an explicit role agent, the main session acts as the project orchestrator.

Project orchestrator responsibilities:

```text
clarify task
  -> classify severity
  -> choose required role route
  -> ensure handoff directory exists when needed
  -> ask user to start architect/coder/reviewer/specialist sessions when needed
  -> track progress, blockers, validation, docs sync, and Replan
  -> verify role outputs and handoff artifacts
  -> summarize final status and risks to the user
```

The orchestrator is a process owner, not an execution owner.

It may handle T0/T1 work directly when the task is small, scoped, and low risk. For non-trivial work, it coordinates role sessions and verifies the process.

Do not let the orchestrator:

- implement complex changes directly
- skip required `architect`, `coder`, or `reviewer` sessions
- approve coder output without independent reviewer evidence
- bypass the required role route for high-risk work
- turn coordination into a do-everything session

### 7.2 Session-Wide Role Agents

Instead, start each major phase with an explicit session-wide role:

```bash
claude --agent architect
claude --agent coder
claude --agent reviewer
```

For background work:

```bash
claude --agent reviewer --bg "Review PR 123 for architecture drift, test gaps, and scope creep"
```

The role is selected at session startup. The agent file defines that session's system prompt, tool restrictions, model, stop conditions, and output format. `CLAUDE.md` still provides project rules, but critical safety, architecture, permission, and output constraints must be repeated inside the role agent file.

If the current session was not started with the required role, stop and ask the user to restart with the correct `claude --agent <role>` command. Do not simulate a different role through a normal prompt.

### 7.3 Task Severity Routing

This is not progressive adoption. The full harness exists by default; the role chain depends on task risk.

| Task class | Examples | Required role route |
| --- | --- | --- |
| T0 trivial | copy, comments, docs typo, tiny config with no behavior change | `coder`; optional reviewer checklist |
| T1 small scoped change | single-file bug, focused test addition, known-pattern fix | `coder` -> fresh review context or `reviewer` |
| T2 ordinary feature | bounded behavior, normal multi-file feature, ordinary PR | `architect` -> `coder` -> `reviewer` |
| T3 cross-module / architectural | cross-module change, module boundary change, refactor, new public surface | `architect` -> `coder` -> `reviewer` |
| T4 high-risk | auth, permission, payment, billing, schema, data deletion, public API/SDK, security-sensitive infrastructure | `architect` -> relevant specialist if needed -> `coder` -> `reviewer` -> human approval |
| T5 large rewrite / greenfield | new subsystem, major rewrite, migration across many modules | `architect`; then repeat `coder` -> `reviewer` per phase, with architect review at phase boundaries |

If classification is unclear, use the stricter route.

### 7.4 Required Roles

Large projects should define these project-level agents:

```text
.claude/agents/
  architect.md
  coder.md
  reviewer.md
  optional/
    security-specialist.md
    migration-specialist.md
    performance-specialist.md
    frontend-qa.md
```

Role responsibilities:

```text
architect
  owns architecture and plan
  defines module boundaries, file responsibilities, public contracts, dependency direction, risk, and phases
  outputs .ai/handoffs/<task-slug>/architecture-plan.md
  must not implement production code

coder
  owns code changes and baseline tests required to complete the approved task
  follows approved architecture-plan.md and task spec
  outputs touched files, implementation notes, validation results, and follow-ups
  must write/update direct unit, contract, or regression tests needed for the changed behavior
  must not change module responsibilities, public contracts, architecture direction, or test strategy without Replan

reviewer
  owns independent acceptance and final test responsibility
  checks scope, role compliance, architecture compliance, public contract compliance, docs sync, validation evidence, and risk
  checks, designs, and adds missing tests when needed
  may directly apply small, local, low-risk review fixes
  owns complex tests, E2E coverage, regression matrix, and release-level validation recommendations
  outputs .ai/handoffs/<task-slug>/review-report.md
  must escalate larger implementation issues to coder
  must escalate architecture, public contract, or design issues to architect
```

### 7.5 Role Permission Matrix

Prompt rules are not enough. Role separation must be backed by tool scope, permission mode, hooks, and review.

| Role | Suggested tools | Write scope | Must not |
| --- | --- | --- | --- |
| `architect` | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write` | architecture plan, task spec, architecture docs only with approval | edit production code, rewrite tests, expand task scope |
| `coder` | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write` | approved source files, baseline tests, validation log, implementation log | change scope, public contracts, module boundaries, or test strategy without Replan |
| `reviewer` | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write` | review report, missing tests/fixtures, validation log, small review-scoped fixes | take over implementation, change architecture/public contracts, approve own implementation, weaken tests |
| `security-specialist` | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write` | security review report and approved security tests | bypass approvals, edit production code without explicit scope |
| `migration-specialist` | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write` | migration plan, migration tests, validation notes | run destructive migrations, change schema without approval |
| `performance-specialist` | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write` | performance report, benchmarks, approved perf tests | change product behavior, hide regressions |

Recommended permission modes:

```text
architect:  default with write hooks limited to architecture-plan.md, task specs, and approved docs
coder:      default or acceptEdits, but only inside approved scope
reviewer:   default with production-code writes blocked except explicitly review-scoped small fixes; test writes allowed
specialist: default with write hooks limited to specialist reports, tests, and approved files
```

Tool lists alone cannot enforce path-level ownership. Add hooks or CI checks that reject writes outside each role's allowed scope. If path-scoped enforcement is unavailable, the final review must explicitly inspect role ownership violations.

### 7.6 Handoff Contract

Role sessions communicate through files, not memory from previous chats.

Required handoff directory:

```text
.ai/handoffs/<task-slug>/
  architecture-plan.md
  implementation-log.md
  validation-log.md
  review-report.md
```

Each role session must start by reading the artifacts it depends on:

```text
architect
  reads: task request, task spec, ARCHITECTURE.md, MODULE_MAP.md, module-local CLAUDE.md, relevant source/tests
  writes: architecture-plan.md

coder
  reads: task spec, architecture-plan.md, relevant module docs
  writes: code, baseline tests, implementation-log.md, validation-log.md

reviewer
  reads: task spec, architecture-plan.md, implementation-log.md, validation-log.md, git diff
  writes: review-report.md

optional specialist
  reads: task spec, architecture-plan.md, relevant source/tests
  writes: specialist report, approved tests, validation-log.md
```

Reviewer test responsibility:

```text
coder:
  writes direct tests required by the code change
  runs focused validation

reviewer:
  owns final test adequacy
  identifies and adds missing unit/contract/integration tests when needed
  owns complex test strategy, E2E smoke/release coverage, and regression matrix
  may directly apply small, local, low-risk review fixes
  must request coder fixes for larger implementation issues
  must request architect review for architecture, public contract, dependency, schema, auth, permission, payment, or design issues
  must not weaken tests to pass validation
```

Reviewer direct fixes must be review-scoped:

```text
allowed:
  strengthen test assertions
  add missing small boundary/regression tests
  fix test names, fixtures, or validation documentation
  fix obvious typo, import, lint, formatting, or local compile error
  fix a small local bug discovered during review

required conditions:
  small and local
  low-risk
  no public contract change
  no architecture change
  no new dependency
  no schema/migration change
  no auth, permission, payment, or data deletion behavior change
  no broad production rewrite

escalate to coder:
  business logic needs a medium or large change
  multiple production files need coordinated edits
  implementation structure needs rework
  validation fails because core behavior is wrong
  the fix would exceed a small review patch

escalate to architect:
  module boundary is wrong
  file responsibilities are wrong
  public contract is wrong
  dependency direction is wrong
  schema, auth, permission, payment, public API, or security design is wrong
  the implementation reveals that the architecture plan is invalid
```

For a task with a handoff directory, `.ai/handoffs/<task-slug>/validation-log.md` is the authoritative validation record for that task. `.ai/state/validation-log.md` is only a rolling index of recent validation results across tasks.

For complex or high-risk work, the next role must not start until the required previous artifact exists and is coherent.

Handoff artifact schemas:

```md
# architecture-plan.md

## Architecture Summary
## Task Classification
## Required Role Route
## Modules / Files
## File Responsibilities
## Public Surface Contract
## Dependency Direction
## Data Flow
## Phases
## Files Per Phase
## Validation Per Phase
## Rollback / Replan Triggers
## Risks
## Stop Conditions
## Docs To Update
## Approval

# implementation-log.md

## Summary
## Files Changed
## Public Surface Changed
## Tests Added / Updated
## Validation Run
## Deviations From Architecture Plan
## Follow-ups

# validation-log.md

## <timestamp> <command>

- role:
- commit / diff:
- scope:
- result:
- failures:
- fixes:
- rerun:

# review-report.md

## Summary
## Role / Handoff Compliance
## Scope Review
## Architecture Review
## Public Contract Review
## Test Review
## Missing Tests Added
## Review Fixes Applied
## Escalations To Coder / Architect
## E2E / Regression Recommendation
## Validation Evidence
## Docs Sync
## Findings
## Decision
```

### 7.7 Role Session vs Subagent

Use a role session when:

- the phase is the main work, not a side task
- the role needs sustained interaction with the user
- the role owns decisions or artifacts
- the role may run for a long time
- the role needs clear accountability

Use a subagent when:

- the work is a bounded side task
- the task produces verbose output that should not pollute the main context
- the task can return a concise summary
- the task is read-only exploration, review, triage, or log analysis
- the task can safely run in parallel

Do not use dynamic subagent routing as the primary workflow for architecture/plan -> coding -> independent review/testing. Use explicit role sessions and file handoffs for that.

### 7.8 Agent File Contract

Every role agent file should define:

```md
---
name: architect
description: Use as a session-wide role for architecture design, task planning, module boundaries, file responsibilities, public contracts, dependency direction, and risk assessment.
tools: Read, Grep, Glob, Bash, Edit, Write
disallowedTools: Agent
permissionMode: default
model: sonnet
---

# Role

You are the architecture and planning role for this project.

# Global Rules To Repeat

- Follow root `CLAUDE.md`, module-local `CLAUDE.md`, and the relevant handoff artifacts.
- Do not exceed this role's write scope.
- Stop when scope, architecture, public contract, test strategy, or risk changes.

# Responsibilities

- Define module boundaries.
- Define file-level responsibilities.
- Define public function and public API contracts.
- Identify dependency direction and forbidden imports.
- Split work into phases.
- Define validation per phase.
- Identify architecture risks and stop conditions.

# Required Inputs

- task spec or user request
- `docs/ARCHITECTURE.md`
- `docs/MODULE_MAP.md`
- relevant module-local `CLAUDE.md`

# Outputs

- `.ai/handoffs/<task-slug>/architecture-plan.md`

# Do Not

- Do not implement production code.
- Do not rewrite tests.
- Do not invent product requirements.
- Do not bypass module ownership rules.

# Stop Conditions

- Requested behavior is ambiguous.
- The design requires public API, schema, auth, payment, permission, or security boundary changes without approval.
- The existing architecture cannot support the requested behavior without Replan.
```

Use frontmatter fields such as `tools`, `disallowedTools`, `permissionMode`, `hooks`, `mcpServers`, and `skills` when the role needs stricter tool, permission, or integration boundaries.

Minimum role templates:

```text
architect.md
  frontmatter:
    tools: Read, Grep, Glob, Bash, Edit, Write
    permissionMode: default
  required inputs:
    task spec, ARCHITECTURE.md, MODULE_MAP.md, module-local CLAUDE.md
  outputs:
    architecture-plan.md
  do not:
    implement code, rewrite tests, expand task scope
  stop when:
    public API, schema, auth, permission, payment, or security boundaries need approval

coder.md
  frontmatter:
    tools: Read, Grep, Glob, Bash, Edit, Write
    permissionMode: default
  required inputs:
    task spec, architecture-plan.md
  outputs:
    code, baseline tests, implementation-log.md, validation-log.md
  do not:
    change architecture, public contracts, scope, test strategy, or module responsibilities without Replan
  stop when:
    implementation requires design, contract, dependency, schema, permission, or test-strategy changes

reviewer.md
  frontmatter:
    tools: Read, Grep, Glob, Bash, Edit, Write
    permissionMode: default
  required inputs:
    task spec, architecture-plan.md, implementation-log.md, validation-log.md, git diff
  outputs:
    review-report.md, missing tests/fixtures when needed, review-scoped small fixes, validation-log.md
  do not:
    take over implementation, change architecture/public contracts, weaken tests, lower assertions, delete failing tests, approve own implementation
  stop when:
    handoffs are missing, validation evidence is missing, architecture/test/doc compliance cannot be verified, or the fix is no longer small/local/low-risk
```

### 7.9 Default Workflow

For large features:

```text
orchestrator main session
  -> classify task + route roles + track process

architect session
  -> architecture-plan.md

coder session
  -> code + baseline tests + implementation-log.md + validation-log.md

reviewer session
  -> review-report.md + missing tests/fixtures if needed + validation-log.md

human approval
```

For small bug fixes or ordinary PRs, one coder session is acceptable if the task spec is clear, file responsibilities are explicit, public contracts are defined when needed, and validation is cheap.

For complex features, cross-module changes, public API changes, schema changes, auth, payment, permissions, data deletion, or security-sensitive work, role sessions are required.

## 8. Testing and Validation

Core principle:

> Test assets should be rich, and execution should be smart. Run fast, relevant tests during development; run broad, expensive suites before release.

### 8.1 Layers

```text
L0 Fast Checks
  format, lint, typecheck, architecture boundary, dependency rules

L1 Focused Unit / Contract Tests
  changed-file related tests, public function contract tests, regression tests

L2 Module / Integration Tests
  module service tests, DB integration, API contract, service/controller integration

L3 Smoke E2E
  core user journeys, minimal browser/API smoke flows

L4 Full Regression / Release Suite
  complex business combinations, multi-browser, historical replay, visual/accessibility/perf
```

Time budgets:

```text
L0 check-fast:        <= 60s
L1 check-changed:     <= 3min
L2 check-module:      <= 10min
L3 smoke-e2e:         <= 15min
L4 full-regression:   nightly / release only
```

### 8.2 Commands

```text
tools/check-fast
tools/check-changed
tools/check-module <module>
tools/check-e2e-smoke [scope]
tools/check-e2e-release
tools/check-full
```

What Claude should run:

```text
docs / comments / small config:
  L0

ordinary bug fix:
  L0 + L1 + regression test

new or modified public function:
  L0 + L1 public contract tests

ordinary feature:
  L0 + L1 + relevant L2

module behavior change:
  L0 + L1 + L2

user-visible critical path:
  L0 + L1 + L2 + relevant L3 smoke E2E

auth / payment / permission / schema / public API:
  L0 + L1 + L2 + relevant L3
  L4 before release

release / major version / high-risk migration:
  L0 + L1 + L2 + L3 + L4
```

### 8.3 Change-Aware Test Selection

Do not maintain a manual test map. Generate or verify a test map from source code, test naming conventions, coverage data, build metadata, and CI history.

```json
{
  "services/billing/invoice/calculator.ts": {
    "module": "billing",
    "unit": ["tests/billing/invoice-calculator.test.ts"],
    "integration": ["tests/billing/refund-service.test.ts"],
    "e2eSmoke": ["e2e/smoke/billing-checkout.spec.ts"]
  }
}
```

The generated artifact should live at:

```text
.ai/generated/test-map.json
```

Rules:

- `.ai/generated/test-map.json` is a derived artifact, not a hand-edited source of truth.
- Manual edits to generated test maps are forbidden.
- `tools/check-generated-artifacts` fails in CI if the generated map is stale.
- If the map cannot be generated reliably, `tools/check-changed` must fall back to code search, LSP, ownership metadata, and conservative module-level tests.

`tools/check-changed` should:

```text
git diff
  -> touched files
  -> map to modules
  -> find related unit/contract/regression tests
  -> run L0 + focused L1
  -> if public surface changed, suggest L2
  -> if critical user path changed, suggest L3
```

### 8.4 E2E Tiers

```text
e2e/
  smoke/
    login.spec.ts
    checkout-happy-path.spec.ts
    core-dashboard-load.spec.ts

  regression/
    coupon-partial-refund.spec.ts
    permission-edge-cases.spec.ts
    multi-user-collaboration.spec.ts

  release/
    cross-browser.spec.ts
    mobile-responsive.spec.ts
    upgrade-migration.spec.ts
```

Smoke E2E: small, stable, core paths, runnable on every PR or high-risk change.  
Release E2E: complex combinations, historical incidents, cross-browser, slower but non-flaky, run before release or nightly.

Test tags:

```text
@smoke @regression @release @slow @flaky
@billing @auth @risk-high @public-api @contract
```

### 8.5 Public Function Test Contract

Every new or modified public function must have tests covering its contract.

Minimum:

```text
ordinary public function:
  happy path + boundary/failure path

business-critical public function:
  happy path + boundary + invalid input + state/permission + side effect + regression

high-risk public function:
  table-driven tests where practical
  contract/integration tests at module boundary
  replay/golden tests when behavior is complex

cross-module contract:
  if a public function is consumed by another module,
  add a contract test owned by the consumer module
  to lock in the behavior the consumer actually depends on
```

Tests should verify:

```text
input -> output -> side effects -> error behavior -> state changes
```

Do not only verify:

```text
mock call order
internal helper call counts
local implementation steps
```

### 8.6 Test Quality Red Lines

Forbidden:

- weakening tests to make implementation pass
- deleting failing tests without explanation
- testing only mock call order
- copying implementation logic into tests
- testing only the happy path
- large snapshots without clear assertion intent
- fragile private-helper tests while missing public contract coverage
- marking work complete without running declared validation

Encouraged:

- table-driven tests
- regression test names that include historical scenarios
- comments explaining why complex cases matter
- golden / replay tests
- integration / contract tests

Maintenance:

- flaky tests must have an owner, issue, and isolation strategy
- slow tests are tagged `@slow` or moved to the release suite
- skipped tests require issue, owner, and expiration
- fast and slow tests are maintained separately

## 9. Hooks / Skills / Subagents / Commands

Do not rely on `CLAUDE.md` for constraints that can be automated.

Recommended hooks:

```text
PreToolUse:
  block protected files
  block destructive commands
  block unapproved deploy/migration/data deletion
  block production secrets
  block writes outside the current role's allowed scope
  block implementation edits that change architecture/public contracts without Replan

PostToolUse:
  format touched files
  collect touched files
  run cheap lint

Stop:
  check orchestrator did not bypass required role route
  check task severity and required role route
  check required handoff artifacts exist
  check required validation
  check task-level validation-log.md updated when handoffs exist
  check progress updated
  check docs synced after plan/contract/test changes
  check no TODO(agent), placeholder, mocked implementation
  check public functions have contract tests
  check tests were not weakened

SessionStart:
  show that untagged main sessions act as project orchestrator
  show current role and expected role for the task
  show required handoff artifacts for the task severity
  inject current task state
  show recent failing checks
  show module owner and validation commands
```

Protected files:

```text
.env
.env.*
secrets/
vendor/
third_party/
generated/
.ai/generated/
package-lock.json
pnpm-lock.yaml
db/migrations/
```

Lockfiles and migrations are not permanently forbidden, but they require explicit approval.

If you type the same long prompt for the third time, turn it into a skill or command.

Recommended subagents:

```text
codebase-explorer
test-failure-triager
security-specialist
performance-specialist
frontend-qa
api-contract-reviewer
migration-specialist
```

Review and explorer subagents should default to read-only.

Role agent sessions are different from subagents. Role sessions own a project phase and should be started with `claude --agent <role>`. Subagents are for bounded side tasks, context isolation, parallel exploration, triage, and independent review.

## 10. Git / Worktrees / Review

Small commits:

- one commit per phase
- commit messages describe behavior changes
- use draft PRs for large changes
- do not leave a 2,000-line diff for final review

Parallel Claude sessions must use worktree isolation.

Good worktree uses:

- one agent fixes CI
- one agent adds tests
- one agent performs read-only review
- one agent implements phase 1

Do not let multiple agents write the same files unless ownership is explicit.

AI review is good at details. Humans remain responsible for:

- architecture direction
- business semantics
- security boundaries
- product experience
- whether the work is worth doing
- whether the solution is over-engineered

## 11. Large Codebase Rules

Do not rely only on grep. In large codebases, grep easily finds the wrong symbol, misses affected files, and causes partial completion or tool thrashing.

Provide:

```text
tools/ai-context <module>
tools/find-owner <path>
tools/find-callers <symbol>
tools/find-tests <path>
tools/check-boundaries
```

If LSP, Sourcegraph, code search, or MCP is available, Claude should prefer them.

Do not maintain hand-written large-codebase indexes as authoritative context. Indexes drift, and stale indexes mislead agents.

Generate context artifacts from source-of-truth systems:

```text
source of truth:
  codebase
  package manifests
  CODEOWNERS / ownership metadata
  build graph
  import graph
  test config
  coverage / CI metadata
  LSP / code search

derived artifacts:
  .ai/generated/module-index.json
  .ai/generated/test-map.json
  .ai/generated/public-surface.json
```

Example generated module index:

```json
{
  "billing": {
    "owner": "billing-platform",
    "docs": ["docs/modules/billing.md"],
    "entrypoints": ["services/billing/invoice/calculator.ts"],
    "tests": ["tests/billing/invoice-calculator.test.ts"],
    "commands": ["tools/check-module billing"],
    "rules": [
      "Use Money object for all amounts",
      "Do not import from payment/adapters/internal"
    ]
  }
}
```

Rules:

- generated artifacts are caches, not truth
- manual edits to `.ai/generated/**` are forbidden
- CI must run `tools/check-generated-artifacts`
- if a generated artifact is stale, Claude must regenerate it or fall back to live code search
- if generated context conflicts with live code, live code wins

Architecture boundaries must be mechanically checked:

```text
tools/check-boundaries
tools/check-generated-artifacts
```

and enforced in CI.

## 12. Long Tasks, Documentation Sync, and Replan

Long tasks cannot rely on chat context.

State files:

```text
.ai/state/
  progress.md       — snapshot of all active tasks' current state
  decisions.md      — architectural / design decisions with rationale (append-only)
  validation-log.md — recent validation runs across tasks (rolling index, ~last 20)
  known-issues.md   — deferred findings awaiting triage
  scratch.md        — current session's working TODOs (cleared at task completion)
```

Validation log authority:

- `.ai/handoffs/<task-slug>/validation-log.md` is authoritative for one task.
- `.ai/state/validation-log.md` is a rolling index across tasks and should point to the task-level log when one exists.
- Final reports and review reports should cite the task-level validation log, not scattered chat output.

Information lifetime determines where it lives:

```text
within one session (phase breakdown, mid-implementation TODOs)
  -> scratch.md

across sessions of one task (progress, decisions)
  -> exec-plan (if task has one) + decisions.md
  -> otherwise progress.md + decisions.md

across tasks (deferred findings, out-of-scope discoveries)
  -> known-issues.md
```

`progress.md` rules:

- Snapshot, not log. Holds current status of every active task in one place.
- One entry per active task; entry is rewritten in place, not appended.
- When a task has an `exec-plan`, its detailed progress lives in the exec-plan's `current state`; `progress.md` keeps only a one-line pointer.
- Completed tasks are removed from `progress.md`; their final state is preserved in the archived exec-plan or commit history.

`scratch.md` rules:

- Session-local working memory for multi-phase tasks: current phase, intermediate TODOs discovered mid-implementation, temporary notes.
- Cleared when the task completes or when a fresh session starts.
- Anything that must survive (decisions, deferred findings, progress) is promoted to `decisions.md`, `known-issues.md`, `progress.md`, or the exec-plan before clearing.
- This file is the legitimate home for the working TODOs that `Stop` hook forbids inside source code.

`known-issues.md` entry format:

```md
## YYYY-MM-DD <one-line summary>

- discovered in: <task / session>
- type: bug | doc-drift | dead-code | architecture | security | other
- impact: low | medium | high
- proposed action: ignore | create task | revisit at next replan
```

Update after each session:

```md
## Session Summary

Date:
Task:
Files changed:
Validation run:
Result:
Decisions:
Open issues:
Next step:
```

For tasks longer than one day, create:

```text
docs/exec-plans/active/<task-name>.md
```

Execution plans include:

- background
- goal
- phased plan
- validation per phase
- risks
- decision log
- current state

When a task has an exec-plan, `current state` in the exec-plan is the authoritative progress record; `progress.md` only points to it.

### 12.1 Documentation Sync Contract

Changes to plan, architecture, public function contracts, test strategy, or module responsibilities must update the related docs.

Rule:

> If implementation differs from the approved plan, the task cannot only change code; it must update the plan and explain why.

Check:

- task spec
- execution plan
- `docs/ARCHITECTURE.md`
- `docs/MODULE_MAP.md`
- module docs
- module-local `CLAUDE.md`
- public surface contract
- test plan / validation section
- `.ai/state/decisions.md`
- `.ai/state/progress.md`
- `.ai/state/known-issues.md`

Final report must list:

```text
Docs checked:
Docs updated:
Known stale docs:
```

Enforcement:

- PR template must include a docs sync checklist covering plan, public contract, architecture, module docs, and test plan.
- Stop hook checks that plan, public contract, or test strategy changes have matching doc updates before the session ends.
- `tools/check-docs-freshness` runs in CI and fails the build when code touching tracked surfaces lands without corresponding doc updates.

### 12.2 Replan Protocol

Triggers:

- planned API, module, or data structure does not exist
- existing architecture invalidates plan assumptions
- public API, schema, auth, permission, or payment must change
- scope must expand
- tests show the plan cannot satisfy real behavior
- repeated fixes do not converge
- a better existing implementation or abstraction is discovered
- continuing would violate architecture constraints

Process:

```text
Stop
  -> Explain blocker
  -> Compare approved plan with code reality
  -> List options
  -> Recommend new plan
  -> Ask approval if scope/risk changed
  -> Update docs
  -> Continue implementation
```

Must pause for approval:

- scope expands
- public API changes
- schema changes
- auth / permission / payment behavior changes
- architecture boundary changes
- test contract changes
- existing abstraction is deleted or replaced
- new dependency is introduced
- phased migration is needed

Low-risk deviations may continue with a note:

- file or test location differs
- existing helper replaces planned helper
- private implementation detail changes
- scope, public surface, architecture boundary, and test contract stay unchanged

### 12.3 Design Change Control

When a large feature is split into subtasks and a design defect is found midstream, do not default to full rollback, and do not continue because of sunk cost.

Process:

```text
Freeze current implementation
  -> Run current validation
  -> Record completed subtasks
  -> Identify design defect
  -> Assess impact radius
  -> Classify severity
  -> Compare options
  -> Preserve reusable assets
  -> Discard wrong boundaries/contracts/abstractions
  -> Update plan and docs
  -> Continue with approved path
```

Severity:

```text
P0 architecture direction is wrong:
  module boundary, public API, data model, security/permission model
  => favor rebuild or major rollback

P1 public contract needs adjustment:
  public functions, file responsibilities, data flow direction
  => partial rollback + migration

P2 internal implementation issue:
  helper, private function split, test organization
  => local refactor

P3 plan detail mismatch:
  file name, call location, helper replacement
  => update plan and continue
```

Compare three options:

```text
A. Patch forward
B. Partial rollback + redesign
C. Full rollback + rebuild
```

Prefer preserving tests, fixtures, docs, clarified requirements, types, UI components, validated pure functions, and low-level tools.  
Prefer discarding wrong public APIs, wrong module boundaries, wrong data models, wrong permission models, wrong abstractions, and glue code built around the wrong design.

Principle:

> Preserve tests, knowledge, and reusable assets; discard wrong boundaries, wrong contracts, and wrong abstractions. Decide based on future maintenance cost, not lines already written.

## 13. AI Code Acceptance

AI code must satisfy:

```text
behavior is correct
+ architecture is compliant
+ public contract is accurate
+ tests are sufficient
+ docs are synced
+ plan deviations are traceable
```

### 13.1 Acceptance Checklist

```md
# AI Code Acceptance Checklist

## Scope

- [ ] Diff is scoped to the task.
- [ ] No unrelated refactor, rename, formatting churn, or cleanup.
- [ ] No forbidden files changed.
- [ ] No unapproved dependency added.
- [ ] No scope expansion without Replan.

## Role / Handoff

- [ ] The main session acted as project orchestrator when no explicit role agent was used.
- [ ] Task severity was classified.
- [ ] Required role route was followed or an exception was approved.
- [ ] The orchestrator verified required handoff artifacts, validation evidence, docs sync, and remaining risks.
- [ ] The orchestrator did not become the architect, coder, and reviewer for the same non-trivial task.
- [ ] The coder session did not own architecture, planning, final testing responsibility, and review by itself.
- [ ] Required handoff artifacts exist and match the handoff schemas.
- [ ] The coder did not change task scope, module boundaries, public contracts, or test strategy without Replan.
- [ ] The reviewer used fresh context, a reviewer role session, or a read-only reviewer subagent.
- [ ] Any reviewer direct fixes were small, local, low-risk, and review-scoped.
- [ ] Larger implementation issues were returned to coder.
- [ ] Architecture, public contract, dependency, schema, auth, permission, payment, or design issues were returned to architect.
- [ ] Task-level validation evidence is recorded in `.ai/handoffs/<task-slug>/validation-log.md` when a handoff directory exists.

## Architecture

- [ ] Module boundaries are preserved.
- [ ] No forbidden internal imports.
- [ ] Business logic stays in the correct layer.
- [ ] Existing service/domain/repository APIs are reused where appropriate.
- [ ] No duplicate parallel abstraction was introduced.
- [ ] `tools/check-boundaries` passes.

## Public Contract

- [ ] Public surface matches the approved plan.
- [ ] No unplanned public API was added.
- [ ] No public signature changed unexpectedly.
- [ ] Inputs, outputs, side effects, and error behavior match the contract.
- [ ] Public contract changes are reflected in docs and tests.

## Tests

- [ ] New or modified public functions have contract tests.
- [ ] Behavior changes have regression tests.
- [ ] Tests cover happy path and boundary/failure path.
- [ ] High-risk functions have expanded behavior-matrix coverage.
- [ ] Tests were not weakened, deleted, or skipped.
- [ ] Tests assert behavior, not just mock call order.

## Validation

- [ ] Required validation commands were run.
- [ ] Validation passed.
- [ ] Failures were fixed and rerun.
- [ ] Relevant L0/L1/L2 checks were run.
- [ ] Relevant L3 smoke E2E was run for user-facing critical paths.

## Docs

- [ ] Task spec remains accurate.
- [ ] Execution plan is updated if implementation changed.
- [ ] Module docs are updated if responsibilities changed.
- [ ] Public surface contract is updated if public functions changed.
- [ ] Test plan / validation section is updated if testing strategy changed.
- [ ] Decisions and known issues are recorded.
- [ ] No known stale docs are left behind.

## Replan / Design Change

- [ ] Any deviation from the plan is documented.
- [ ] Scope, architecture, public contract, or test contract changes were approved.
- [ ] Design defects were handled through Design Change Control.
```

### 13.2 Acceptance Flow

```text
1. Orchestrator classifies task severity and required role route
2. Verify required handoff artifacts exist
3. Inspect diff scope
4. Compare diff against task spec and architecture plan
5. Compare public surface against Public Surface Contract
6. Review tests for contract and regression coverage
7. Run or inspect validation evidence
8. Run architecture boundary checks
9. Check docs consistency
10. Run independent review for complex/high-risk changes
11. Orchestrator verifies process compliance, remaining risks, and next step
12. Approve, request changes, or trigger Replan
```

Claude’s final report must include:

```text
Task severity:
Orchestrator decision:
Role sessions used:
Handoff artifacts:
Files changed:
Public surface changed:
Tests added/updated:
Validation run:
Architecture checks:
Docs updated:
Plan deviations:
Remaining risks:
```

Acceptance result:

```text
Accepted:
  meets task, architecture, public contract, tests, validation, and docs requirements.

Needs Changes:
  clear issue, but no redesign needed.

Replan Required:
  scope, architecture, public contract, test contract, or design assumptions changed.
```

Automation tools:

```text
tools/check-boundaries
tools/check-public-surface
tools/check-contract-tests
tools/check-docs-freshness
tools/check-generated-artifacts
tools/check-agent-rules
tools/check-changed
tools/check-e2e-smoke
```

## 14. MCP and Permissions

MCP is useful for repo-external, frequently changing, tool-accessible context:

- issue / PR
- docs/wiki
- logs/metrics/traces
- browser / Playwright
- database inspection
- feature flags
- CI logs
- code search

Do not connect every MCP server at the start. Prioritize:

```text
1. GitHub / issue / PR
2. browser / Playwright
3. code search
4. CI logs
5. internal docs
```

Permission principles:

- prefer read-only
- write actions require explicit approval
- production data is not available by default
- destructive actions require hard gates
- third-party MCP servers require source review and version pinning, with an owner recorded for each enabled server

## 15. Harness Drift and Evolution

The harness itself can drift. Rules, role agent files, commands, hooks, generated indexes, and validation scripts are also software and must be maintained with the same skepticism as production code.

### 15.1 Generated Context Only

Manual indexes are not reliable sources of truth in a large codebase.

Forbidden:

- hand-maintained module indexes as authoritative context
- hand-maintained test maps as authoritative context
- stale public-surface maps
- generated artifacts edited by hand

Allowed:

- generated artifacts created from source code, build graphs, ownership metadata, test configs, coverage, CI, LSP, and code search
- checked-in generated artifacts only when CI verifies freshness
- fallback to live code search when generated context is missing or stale

Required check:

```text
tools/check-generated-artifacts
```

This check should fail when:

- `.ai/generated/module-index.json` is stale
- `.ai/generated/test-map.json` is stale
- `.ai/generated/public-surface.json` is stale
- a generated artifact was hand-edited
- generated context disagrees with source-of-truth code metadata

If generated context conflicts with live code, live code wins.

### 15.2 Repeated Rules Need Rule IDs

Repeating critical rules in root `CLAUDE.md`, module-local `CLAUDE.md`, and role agent files can be useful defense in depth, but untracked duplication causes drift.

Rules:

- critical repeated rules must have stable IDs, such as `RULE-SCOPE-001`, `RULE-ARCH-001`, `RULE-TEST-001`, `RULE-PERM-001`
- root rule text is canonical unless a different canonical source is explicitly defined
- role agent files should reference rule IDs or include generated rule snippets
- `tools/check-agent-rules` must fail when repeated rule text, rule IDs, or required rule coverage drift
- do not copy long rule blocks manually into many files without a freshness check

### 15.3 Scaffolding Must Earn Its Keep

The right philosophy is not "more constraints means more reliability." The right philosophy is:

> Add constraints when they prevent observed failures. Remove constraints when they no longer pay for their maintenance cost.

Every rule, role, handoff artifact, hook, generated index, validation command, and required checklist item adds cost.

Monthly review must remove as well as add scaffolding:

- remove rules that no longer prevent real failures
- merge roles that create handoff overhead without reducing risk
- replace manual docs or indexes with generated artifacts
- relax constraints that block safe cross-file edits by stronger models
- promote useful repeated behavior into tests, CI, hooks, or generated checks
- delete soft behavioral rules that are not measurable and do not prevent observed failures
- delete stale workarounds created for older model limitations

Do not preserve a rule only because it helped an older model. A rule must justify itself against the current model, current tools, current codebase, and current failure data.

### 15.4 Model Evolution Review

When the model, Claude Code, MCP tooling, code search, test selection, or CI improves, revisit the harness.

Review questions:

- Which constraints were added for a weaker model?
- Which rules now block safe multi-file reasoning or coordinated edits?
- Which role handoffs are producing useful artifacts, and which are ritual?
- Which prompts can be replaced by stronger tests, generated checks, or tools?
- Which checks are redundant because CI or type systems now cover them?
- Which tasks can safely move to a lighter route because failure data improved?

The goal is a harness that stays strong by staying lean.

## 16. Team Governance

The team needs a Claude Code Harness owner, usually DevEx, platform, staff engineer, or architecture group.

Responsibilities:

- maintain `CLAUDE.md`
- maintain the project orchestrator behavior in root `CLAUDE.md`
- maintain hooks
- maintain role agents, skills, subagents, and commands
- maintain validation commands
- maintain generated context artifacts and freshness checks
- maintain docs freshness and documentation sync rules
- review MCP permissions
- clean stale rules, stale docs, stale generated artifacts, and stale scaffolding
- collect agent failure modes

Rule updates:

- frequent mistakes go into `CLAUDE.md`
- high-risk boundaries go into `CLAUDE.md`
- information used by every task goes into `CLAUDE.md`
- everything else goes into module-local `CLAUDE.md`, docs, skill, command, hook, or CI check
- every repeated critical rule needs a stable rule ID and freshness check
- every generated context artifact needs a source-of-truth generator and CI freshness check

Monthly review:

- What mistakes does Claude make most often?
- Which task types succeed most often?
- Which tasks should be forbidden for automation?
- Which rules or docs are stale?
- Which rules should be removed because the current model no longer needs them?
- Which roles or handoff artifacts add overhead without reducing real failures?
- Which manual indexes or docs should become generated artifacts?
- Which prompts should become skills?
- Which validation commands are too slow?
- Which checks should move into hooks?
- Which checks, hooks, or role requirements can be simplified?

`known-issues.md` triage (every monthly review):

- For each unhandled entry, decide: promote to task, fold into a planned change, or dismiss.
- Entries older than 90 days with no action are dismissed with a reason recorded in `decisions.md`.
- `known-issues.md` is only useful if it stays small; an ever-growing file means triage is not happening.

## 17. Minimum Team Rules

If you can only enforce 13 rules, enforce these:

1. Untagged main sessions act as project orchestrator, not do-everything executors.
2. Complex tasks use explicit role sessions, handoff artifacts, and plan first; do not edit directly.
3. One session handles one coherent role and task.
4. Tasks must define scope, non-goals, and validation.
5. Every task must define file-level responsibilities.
6. Ordinary tasks must define public function contracts.
7. New or modified public functions must have contract tests.
8. Code changes must run relevant validation.
9. Architecture, public contract, or test strategy changes must sync docs.
10. Manual indexes are not authoritative; generated context must be freshness-checked.
11. AI review uses fresh context or a reviewer role session.
12. High-risk actions require human approval.
13. Harness rules, roles, checks, and handoffs must be reviewed for removal as well as addition.

## 18. Common Anti-Patterns

```text
Huge CLAUDE.md
  -> short entry file + docs + module-local rules

Natural-language-only constraints
  -> hooks / lint / tests / CI / permissions

Hand-maintained indexes
  -> generated artifacts + CI freshness checks

Copied critical rules in many files
  -> rule IDs + generated snippets + check-agent-rules

No validation command
  -> check-fast / check-changed / check-module

Too much at once
  -> phases / incremental commits / draft PR

One do-everything session
  -> explicit role sessions + file handoffs

Orchestrator becomes coder/reviewer
  -> orchestrator coordinates and verifies; role sessions execute

Dynamic subagent routing for the main workflow
  -> start the session with claude --agent <role>

Permanent scaffolding for old model limits
  -> monthly model evolution review + remove stale constraints

Coder session self-reviews
  -> reviewer role session / fresh review session / reviewer subagent

Unbounded multi-agent parallelism
  -> worktrees / ownership / read-write separation
```
