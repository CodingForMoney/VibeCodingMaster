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
    commands/

  .ai/
    task-specs/
    state/
      progress.md
      decisions.md
      validation-log.md
      known-issues.md
    module-index.json

  tools/
    check-fast
    check-changed
    check-module
    check-e2e-smoke
    check-boundaries
    check-docs-freshness
    check-agent-rules
```

Progressive adoption path:

A large project rarely adopts the full harness at once. New modules and new subsystems can ramp up in phases:

```text
Phase 1 — new module bootstrap:
  CLAUDE.md
  docs/ARCHITECTURE.md
  docs/TESTING.md
  tools/check-fast
  tools/check-changed

Phase 2 — normal development:
  + docs/MODULE_MAP.md
  + module-local CLAUDE.md
  + .ai/state/
  + tools/check-module
  + tools/check-boundaries

Phase 3 — high-risk areas (auth, payment, schema, public API):
  + docs/SECURITY.md
  + docs/DEPENDENCY_RULES.md
  + .claude/ hooks, skills, agents
  + tools/check-public-surface
  + tools/check-contract-tests
  + tools/check-docs-freshness
  + MCP integrations
```

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

## Hard Rules

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

Use a fresh session or reviewer subagent for complex tasks. Do not let the same session that implemented the change be the only reviewer.

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

## 7. Testing and Validation

Core principle:

> Test assets should be rich, and execution should be smart. Run fast, relevant tests during development; run broad, expensive suites before release.

### 7.1 Layers

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

### 7.2 Commands

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

### 7.3 Change-Aware Test Selection

Maintain a test map:

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

### 7.4 E2E Tiers

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

### 7.5 Public Function Test Contract

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

### 7.6 Test Quality Red Lines

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

## 8. Hooks / Skills / Subagents / Commands

Do not rely on `CLAUDE.md` for constraints that can be automated.

Recommended hooks:

```text
PreToolUse:
  block protected files
  block destructive commands
  block unapproved deploy/migration/data deletion
  block production secrets

PostToolUse:
  format touched files
  collect touched files
  run cheap lint

Stop:
  check required validation
  check progress updated
  check docs synced after plan/contract/test changes
  check no TODO(agent), placeholder, mocked implementation
  check public functions have contract tests
  check tests were not weakened

SessionStart:
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
security-reviewer
performance-reviewer
frontend-qa
api-contract-reviewer
migration-planner
```

Review and explorer subagents should default to read-only.

## 9. Git / Worktrees / Review

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

## 10. Large Codebase Rules

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

Maintain `.ai/module-index.json`:

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

Architecture boundaries must be mechanically checked:

```text
tools/check-boundaries
```

and enforced in CI.

## 11. Long Tasks, Documentation Sync, and Replan

Long tasks cannot rely on chat context.

State files:

```text
.ai/state/
  progress.md
  decisions.md
  validation-log.md
  known-issues.md
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

### 11.1 Documentation Sync Contract

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

### 11.2 Replan Protocol

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

### 11.3 Design Change Control

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

## 12. AI Code Acceptance

AI code must satisfy:

```text
behavior is correct
+ architecture is compliant
+ public contract is accurate
+ tests are sufficient
+ docs are synced
+ plan deviations are traceable
```

### 12.1 Acceptance Checklist

```md
# AI Code Acceptance Checklist

## Scope

- [ ] Diff is scoped to the task.
- [ ] No unrelated refactor, rename, formatting churn, or cleanup.
- [ ] No forbidden files changed.
- [ ] No unapproved dependency added.
- [ ] No scope expansion without Replan.

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

### 12.2 Acceptance Flow

```text
1. Inspect diff scope
2. Compare diff against task spec and architecture contract
3. Compare public surface against Public Surface Contract
4. Review tests for contract and regression coverage
5. Run or inspect validation evidence
6. Run architecture boundary checks
7. Check docs consistency
8. Run independent review for complex/high-risk changes
9. Approve, request changes, or trigger Replan
```

Claude’s final report must include:

```text
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
tools/check-agent-rules
tools/check-changed
tools/check-e2e-smoke
```

## 13. MCP and Permissions

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

## 14. Team Governance

The team needs a Claude Code Harness owner, usually DevEx, platform, staff engineer, or architecture group.

Responsibilities:

- maintain `CLAUDE.md`
- maintain hooks
- maintain skills/subagents
- maintain validation commands
- maintain docs freshness and documentation sync rules
- review MCP permissions
- clean stale rules and stale docs
- collect agent failure modes

Rule updates:

- frequent mistakes go into `CLAUDE.md`
- high-risk boundaries go into `CLAUDE.md`
- information used by every task goes into `CLAUDE.md`
- everything else goes into module-local `CLAUDE.md`, docs, skill, command, hook, or CI check

Monthly review:

- What mistakes does Claude make most often?
- Which task types succeed most often?
- Which tasks should be forbidden for automation?
- Which rules or docs are stale?
- Which prompts should become skills?
- Which validation commands are too slow?
- Which checks should move into hooks?

## 15. Minimum Team Rules

If you can only enforce 10 rules, enforce these:

1. Complex tasks plan first; do not edit directly.
2. One session handles one coherent task.
3. Tasks must define scope, non-goals, and validation.
4. Every task must define file-level responsibilities.
5. Ordinary tasks must define public function contracts.
6. New or modified public functions must have contract tests.
7. Code changes must run relevant validation.
8. Architecture, public contract, or test strategy changes must sync docs.
9. AI review uses fresh context.
10. High-risk actions require human approval.

## 16. Common Anti-Patterns

```text
Huge CLAUDE.md
  -> short entry file + docs + module-local rules

Natural-language-only constraints
  -> hooks / lint / tests / CI / permissions

No validation command
  -> check-fast / check-changed / check-module

Too much at once
  -> phases / incremental commits / draft PR

Implementation session self-reviews
  -> fresh review session / reviewer subagent

Unbounded multi-agent parallelism
  -> worktrees / ownership / read-write separation
```

