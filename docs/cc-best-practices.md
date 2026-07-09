# Claude Code AI Coding Best Practices

> Archived: this document is kept for historical reference only. As of 2026-06-08, it is no longer maintained or updated. Use the active project-specific practice docs for current implementation details.

Date: 2026-05-22

Core principle:

> AI coding reliability comes from two things: **public contract design** prevents architecture drift, and **public contract tests** prevent behavior drift.

Reliable loop:

```text
task brief
  -> architecture / public contract / test contract
  -> small-step implementation
  -> layered validation
  -> independent review
  -> documentation sync
  -> final acceptance
  -> replan when reality invalidates the plan
```

## 1. Basic Principles

Treat Claude Code as a capable engineer with limited local context. It needs clear boundaries, executable feedback, and durable artifacts.

Good tasks for Claude:

- reproducible, testable bug fixes
- small to medium features with clear boundaries
- implementation that follows existing patterns
- test additions, PR review comment fixes, documentation drafts
- codebase exploration, explanation, onboarding

Do not hand these directly to Claude without a plan:

- "refactor the whole system"
- "figure it out" tasks for performance, auth, permissions, payments, schema, or data deletion
- complex business changes without a spec, tests, or acceptance criteria

High-risk tasks require stronger process:

- auth / permission
- payment / billing
- database schema / migration
- public API / SDK
- protocol / serialization
- data deletion / privacy
- concurrency / distributed consistency
- security-sensitive infrastructure

These tasks need an explicit plan, public contracts, test contracts, validation commands, and independent review.

Behavioral guardrails:

- State important assumptions before coding.
- Ask the user when user intent, real-world authorization, or externally unknowable facts are required.
- Do not ask the user to decide ordinary implementation details that the architecture owner can decide.
- Prefer the simplest solution that satisfies the task.
- Do not add unrequested features, configuration, extension points, or abstractions.
- Touch only files required by the task.
- Do not clean up, format, or refactor adjacent code opportunistically.
- When the current task replaces a mechanism, remove obsolete code, stale paths, dead branches, legacy adapters, and unused compatibility shims.
- Do not preserve backward compatibility with stale code unless the user explicitly asks for it.
- Report unrelated discoveries into task-local findings; promote them to durable docs only when they remain useful across tasks.
- Every diff line should trace to the task goal, public contract, test contract, or required documentation sync.

## 2. Repo Harness Structure

A Claude Code harness should define categories, not force every project into one exact file tree.

Recommended categories:

```text
repo/
  CLAUDE.md                         # project entry map and mandatory rules

  docs/
    ARCHITECTURE.md                 # system architecture source of truth
    TESTING.md                      # validation levels and commands
    modules/<module>/ARCHITECTURE.md
    known-issues.md                 # durable confirmed issues only

  .claude/
    settings.json
    agents/*.md                     # role definitions
    skills/*/SKILL.md               # reusable procedures

  .ai/
    generated/*                     # generated context, never hand-authored truth
    tools/*                         # deterministic harness tools
    <runtime-root>/                 # ignored task/session/job state
```

The exact paths may vary. The important boundary is:

- durable project truth lives in source, tests, commits, PR text, and long-term docs
- generated context is a cache derived from source-of-truth systems
- runtime state is temporary and ignored by Git
- role definitions and skills are reviewable repository files
- deterministic checks live in scripts, tools, CI, hooks, or project commands

Minimum baseline for non-trivial AI coding:

- root project guidance
- role definitions for coordination, architecture, coding, and independent review
- durable architecture and testing docs
- task-local handoff artifacts
- generated context or reliable code search for large repos
- validation commands for fast, changed-area, integration, and E2E checks
- hooks or CI gates for protected files, validation, public contracts, and test quality

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
- vague rules like "write high-quality code"
- frequently changing task state

Root template:

```md
# CLAUDE.md

## Project Map

- `services/`: production services
- `packages/`: shared libraries
- `apps/`: user-facing applications
- `docs/`: architecture, testing, and module docs
- `.ai/tools/`: validation and developer utilities

## Start Here

- Read `docs/ARCHITECTURE.md` for system overview.
- Read affected module architecture docs before editing a module.
- Prefer existing APIs, services, helpers, and patterns before adding abstractions.

## Commands

- Fast validation: <project fast check>
- Changed-area validation: <project changed-area check>
- Integration validation: <project integration check>
- E2E validation: <project E2E smoke check>

## Role Entry Points

Role-specific behavior lives in `.claude/agents/`.

- Project manager: user communication, task clarification, role routing, handoff verification, final acceptance.
- Architect: architecture plan, module boundaries, file responsibilities, public contracts, test contracts, implementation order, architecture drift checks.
- Coder: implementation and direct tests within an approved plan.
- Tester: independent validation, validation adequacy, test gaps, docs gaps, acceptance findings.

Do not use an untagged general session as the implicit owner for non-trivial work.

## Runtime Artifacts

- Use a task-local handoff directory under the project runtime root.
- Do not rely on chat history as the only handoff mechanism.
- Clear or delete temporary task artifacts when they stop being useful.

## Managed Blocks

Harness-managed template sections use markers:

<!-- <HARNESS_NAME>:BEGIN version=1 -->
...
<!-- <HARNESS_NAME>:END -->

Do not edit inside managed blocks manually. Add project-specific rules outside them.
```

## 4. Task Briefs and Planning Granularity

A task brief should make implementation bounded and reviewable.

Recommended task brief fields:

```md
# Task Brief

## Goal
## Background
## Scope
## Non-goals
## Risk Level
## Required Role Route
## Runtime / Handoff Directory
## Relevant Files
## File Responsibilities
## Public Surface Contract
## Test Contract
## Architecture Constraints
## Stop Conditions
## Expected Behavior
## Validation Commands
## Definition of Done
## Risks
## Questions
```

For small tasks, this can be short. For complex tasks, it must be precise enough that the next role can work without reconstructing missing context from chat history.

Stop conditions:

- the implementation needs scope changes
- the public contract needs to change
- the test strategy needs to change
- the current plan conflicts with code reality
- validation reveals a design issue rather than a local bug
- continuing would require destructive operations, data migration, production access, or external authorization not already granted

## 5. Workflows

### Small Change

```text
task brief
  -> implement
  -> run fast validation
  -> inspect diff
  -> final response
```

Small changes still need traceable scope and validation.

### Complex Change

```text
project manager
  -> architect writes complete accepted-scope plan
  -> optional independent gate review of plan
  -> coder implements approved scope
  -> tester checks validation adequacy and adds/requests missing tests
  -> architect checks architecture/docs drift when needed
  -> optional independent gate review of code diff
  -> project manager final acceptance
```

Complex work should move through artifacts, not just chat messages.

### Debug

```text
reproduce or inspect evidence
  -> identify failing boundary
  -> architect evaluates design-level fix when needed
  -> implement local fix
  -> run targeted regression
  -> run appropriate broader validation
  -> record root cause and remaining risk
```

Do not turn debugging into unbounded trial-and-error. If repeated local fixes do not converge, replan.

### Managed Execution Mode

Use this only when the user explicitly requests that the project manager drive a complex task to completion.

Rules:

- The project manager advances the task through the normal role route.
- Simple implementation choices are handled by the appropriate role.
- The flow stops for the user only when user intent, authorization, real-world constraints, or externally unknowable facts are required.
- Do not shrink, reinterpret, delay, or partially complete the task without user approval.
- Do not ask the user to choose between "complete the task" and "do less work"; completing the task is the point of the mode.

## 6. Role-Based Sessions

For large projects, the default execution model should be explicit role-based sessions, not one generic conversation that performs every responsibility.

Core roles:

- project manager
- architect
- coder
- tester

Optional quality role:

- gate reviewer, used for independent artifact review at configured gates

Auxiliary sessions:

- harness maintainer
- documentation maintainer
- translation helper
- gateway or communication helper
- read-only exploration or triage helper

Auxiliary sessions may be long-lived and project-scoped, but they are not automatically part of the main task workflow. When they act on a task, their execution directory should be the active task worktree.

Role separation rules:

- One session should not own architecture, implementation, final testing responsibility, and independent review for the same non-trivial task.
- Role outputs should be exchanged through task-local artifacts.
- Role messaging is turn-based: write the handoff, then end the turn.
- Do not poll, loop, or wait inside a role turn for another role's answer.
- Do not use dynamic subagent routing as the primary workflow for architecture -> coding -> review.
- Read-only subagents are useful for exploration, triage, log analysis, and parallel research.

## 7. Artifact-Driven Review Gates

Review gates should be triggered by artifacts, not by vague conversation moments.

Recommended gates:

```text
architecture gate:
  input: architecture plan artifact
  purpose: find missing boundaries, public-interface impacts, dependency impacts, data-flow risks, and plan-level design defects

validation adequacy gate:
  input: test report and validation evidence
  purpose: judge whether tests and validation cover important paths, especially integration and E2E behavior

code diff gate:
  input: git diff, final acceptance evidence, relevant handoff artifacts
  purpose: inspect code quality, coding conventions, boundary cases, scope drift, and unresolved risks
```

Gate rules:

- If the required input artifact is missing or empty, the gate should be considered not ready or not required, not silently passed.
- If the input artifact has not changed since the previous gate decision, avoid duplicate review.
- The gate reviewer should return `approve` or `request_changes` with concise findings.
- The gate reviewer should not decide who owns the fix, whether to replan, or whether the user must intervene. The project workflow owns routing.
- The gate reviewer should not run tests unless the role explicitly owns validation execution. A pure review gate reads code, docs, artifacts, and diffs.

## 8. Architecture Plans and Scaffold Manifests

The architecture plan is the executable plan for the full accepted task scope.

For complex work:

- The architect may describe implementation order.
- The active plan should contain the complete accepted scope.
- Implementation order must not defer requested scope.
- Durable decisions discovered during implementation should be promoted to durable docs when needed.
- Do not keep completed temporary instructions as stale task detail.

Use a scaffold manifest when the coder needs task-specific context.

Good scaffold manifest content:

- task context the coder needs
- planned temporary markers or helper boundaries
- files expected to be touched
- constraints that should not become permanent code comments
- completion checklist for scaffold cleanup

Code comments should explain durable logic, invariants, non-obvious behavior, or public contracts. They should not preserve task instructions, temporary rationale, or "AI did this" breadcrumbs.

Architecture docs must not be a chronological work log. They should describe:

- module responsibilities
- dependency direction
- public interfaces
- data flow
- state ownership
- cross-module constraints
- validation expectations
- known limits that future maintainers need

When a task changes a module's durable behavior, the corresponding architecture doc should be updated before final acceptance.

## 9. Testing and Validation

Validation should be layered:

```text
L0 fast check:
  formatting, typecheck, focused unit tests, cheap static checks

L1 changed-area check:
  tests and checks for affected modules, changed public surfaces, and nearby integration points

L2 integration check:
  service integration, database boundaries, adapters, cross-module flows

L3 E2E / smoke:
  critical user paths, release-level confidence, browser or system-level paths
```

Tester responsibility is not just confirming that tests ran. Tester must judge whether the tests prove the behavior that matters.

Test quality rules:

- Important features need integration or E2E coverage when unit tests cannot prove the user-visible path.
- Public behavior changes need regression tests.
- Boundary cases, invalid input, state transitions, permissions, and error paths need explicit coverage.
- Do not weaken assertions to make tests pass.
- Do not test only mock calls when real behavior can be observed.
- Do not fake implementations, hardcode test-only behavior, or add placeholders that satisfy tests without satisfying the feature.
- Skipped checks must include a reason and the planned validation point.

Long-running validation:

- Use a bounded job wrapper for long builds, full test suites, browser runs, or E2E checks.
- The wrapper should write status and logs under the runtime root.
- The current turn should wait through a bounded watcher, then summarize success, failure, timeout, and log tail.
- Do not ask Claude to keep an unbounded shell loop open.

## 10. Generated Context and Large Codebases

Large codebases need generated or tool-backed context.

Good sources of truth:

- source code
- package manifests
- CODEOWNERS / ownership metadata
- build graph
- import graph
- test config
- coverage / CI metadata
- LSP / code search

Generated artifacts:

- module index
- public surface index
- test ownership / affected-test map
- route / API inventory

Rules:

- generated artifacts are caches, not truth
- manual edits to generated artifacts are forbidden
- freshness checks should exist when generated context is committed
- if generated context conflicts with live code, live code wins
- if generated context is missing or stale, regenerate it or fall back to live code search

## 11. Git, Worktrees, and Commit Discipline

Default rule:

```text
one task
  -> one branch
  -> one task worktree
  -> one runtime handoff root
  -> one PR or merge path
```

Do not split worktrees by role. Architect, coder, tester, and optional gate reviewer should normally work in the same task worktree sequentially.

Role isolation is enforced by role definitions, permissions, hooks, handoff artifacts, and review. Worktree isolation is enforced at the task boundary.

Branch and worktree rules:

- Do not do AI implementation directly on the main branch.
- One task branch should map to one task worktree.
- A task should not switch to a different branch or worktree after creation; create a new task instead.
- Large work should use reviewable commits on the same task branch.
- Do not leave a large unreviewed diff until the end.

Harness and bootstrap changes:

- Harness changes should be made in the active task worktree when they affect the task.
- Harness changes should produce a commit before review.
- Review the commit diff, not a scattered unstaged working tree.
- If review rejects the change, revert the commit, amend it, or ask the harness maintainer to revise it.

## 12. Runtime State and Session Recovery

Runtime state should be treated as disposable coordination state.

Examples:

- session records
- round / turn state
- route messages
- queued translation or gateway tasks
- long-running validation jobs
- temporary logs
- progress files

Rules:

- Runtime state should live under an ignored runtime root.
- On application restart or project reconnect, stale running state should be reconciled or cleared.
- A session id should be persisted only after the first real user prompt is submitted and the tool is expected to have saved a resumable conversation.
- Restart should clear the old stored session id until the next prompt establishes a new one.
- Resume failure must have a fallback; do not keep reporting a missing session as running forever.
- Process or terminal state may be monitored in memory, but runtime process ids should not be durable project data.
- User interruption should move active turn/session state back to idle when no work is continuing.

## 13. Harness Bootstrap and Evolution

Bootstrap exists to make the project understandable before non-trivial AI work.

Bootstrap should:

- inspect project docs, source layout, manifests, tests, and validation commands
- generate context artifacts when supported
- create or improve durable architecture and testing docs
- avoid editing product source, product tests, lockfiles, deployment config, secrets, or managed blocks unless explicitly scoped
- provide a concise summary of verified facts, inferred facts, unknowns, and suggested validation commands
- commit harness/doc changes when the project workflow expects review by commit diff

Harness evolution:

- Roles should be allowed to report reusable harness problems with evidence.
- The harness maintainer should verify the issue before proposing changes.
- Harness changes should require user review or approval before they become the new baseline.
- Harness retrospective is most useful after a task completes, because the task produced handoffs, commits, validation evidence, docs updates, and final acceptance evidence.
- Retrospective should ask whether the task process worked, not merely whether harness files look tidy.

Scaffolding must earn its keep:

- add constraints when they prevent observed failures
- remove constraints when they no longer pay for their maintenance cost
- replace manual docs or indexes with generated artifacts when possible
- delete stale workarounds created for older model limitations

## 14. Documentation Lifecycle

Information lifetime determines where it belongs:

```text
within one turn:
  -> current response or task-local scratch

across one task:
  -> handoff artifacts, active plan, validation evidence, route messages

across tasks:
  -> durable docs, source, tests, commits, PR text, known-issues

exceptional history:
  -> ADRs, completed plans, incident notes
```

Temporary task artifacts should be removed, cleared, or archived when they stop being useful. Durable docs should describe current truth, not every intermediate attempt.

Promotion rules:

- durable architecture facts go to architecture docs
- durable testing policy goes to testing docs
- durable public behavior belongs in code, tests, public contract docs, and PR text
- deferred out-of-scope work goes to known issues only if it has future value
- stale known issues should be removed or marked resolved

## 15. MCP and Permissions

MCP and external tools are useful for repo-external, frequently changing, tool-accessible context:

- issue / PR
- docs/wiki
- logs/metrics/traces
- browser / Playwright
- database inspection
- feature flags
- CI logs
- code search

Do not connect every MCP server at the start. Prioritize what the task needs.

Permission principles:

- prefer read-only access by default
- write actions need explicit scope
- production data is not available by default
- destructive actions require hard gates
- third-party tool integrations need source review, version pinning, and a clear owner
- if the project runs inside a trusted sandbox, broad local edit permissions may be acceptable, but the scope should still be visible and intentional

## 16. AI Code Acceptance

AI code must satisfy:

```text
behavior is correct
+ architecture is compliant
+ public contract is accurate
+ tests are sufficient
+ docs are synced
+ plan deviations are traceable
```

Acceptance checklist:

- changed files and meaningful hunks have traceable reasons
- unrelated refactor, rename, formatting churn, or cleanup is absent or explained
- no forbidden files changed
- no unapproved destructive operation occurred
- required role route was followed or an exception was approved
- required handoff artifacts exist and match their purpose
- implementation did not change scope, module boundaries, public contracts, or test strategy without replan
- independent review checked scope, architecture, public contract, tests, validation, and docs
- important features have integration or E2E coverage where needed
- code diff was inspected for coding standards and boundary cases
- durable docs are current
- temporary task artifacts are cleaned up or intentionally kept

Acceptance result:

```text
Accepted:
  meets task, architecture, public contract, tests, validation, and docs requirements

Needs Changes:
  clear issue, but no redesign needed

Replan Required:
  scope, architecture, public contract, test contract, or design assumptions changed
```

## 17. Common Anti-Patterns

```text
Huge CLAUDE.md
  -> short entry file + docs + module-local rules

Natural-language-only constraints
  -> hooks / lint / tests / CI / permissions

Hand-maintained indexes
  -> generated artifacts + freshness checks

No validation command
  -> project-native validation levels

Too much at once
  -> complete accepted scope + reviewable commits

One do-everything session
  -> explicit role sessions + file handoffs

Project manager becomes coder/tester
  -> project manager coordinates and verifies; role sessions execute

Role-based worktree fragmentation
  -> one task worktree; roles hand off sequentially inside it

Dynamic subagent routing for the main workflow
  -> role sessions own the workflow; subagents handle bounded side work

Permanent scaffolding for old model limits
  -> harness retrospective + remove stale constraints

Coder session self-reviews
  -> tester role session or fresh independent review

Unbounded multi-agent parallelism
  -> split tasks, ownership, or read/write separation

Task instructions embedded as permanent code comments
  -> scaffold manifest and durable docs

Tests written to satisfy mocks instead of behavior
  -> contract, integration, and E2E validation
```
