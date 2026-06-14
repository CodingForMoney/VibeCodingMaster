# Codex Review Gates

Last updated: 2026-06-14

This document defines the Codex Review Gates feature for VCM.

The goal is to add an independent cross-model review layer to complex VCM
tasks. VCM keeps the four Claude Code execution roles and adds a fifth role,
`codex-reviewer`, for external review. Claude Code remains the primary role
execution engine, while Codex reviews key artifacts at three gates where
mistakes are expensive if found late:

1. Architecture plan review before coder implementation.
2. Validation adequacy review after reviewer output.
3. Final diff review before final acceptance and PR preparation.

## 1. Product Goal

Complex tasks should not rely on a single model family or a single role chain.
VCM already separates work into project-manager, architect, coder, and reviewer
roles, but those roles can still share blind spots. Codex Review Gates add
`codex-reviewer` as a fifth role that is outside the normal Claude Code role
loop.

Codex is not the task owner. It does not implement code, rewrite plans, replace
the VCM reviewer, assign ownership, or decide whether user intervention is
required. It only reviews the specified gate evidence and reports whether that
gate can pass.

The product outcome is higher task accuracy through earlier detection of:

- misunderstood requirements
- flawed architecture plans
- unverifiable implementation plans
- inadequate tests
- missed edge cases
- hidden regressions in the final diff
- unexplained or high-risk file changes

## 2. Non-Goals

The first version should not:

- require every task to start Codex Reviewer manually
- let Codex edit repository files directly
- automatically accept, reject, route, or replan a task
- replace human approval for high-risk decisions
- require every small task to run all three gates
- halt all workflows when Codex is unavailable
- send repository secrets or unrelated local state to a hosted model

## 3. Gate Summary

```text
project-manager
  -> architect architecture plan
  -> Codex Gate 1: Architecture Plan Review
  -> coder implementation
  -> reviewer independent validation
  -> Codex Gate 2: Validation Adequacy Review
  -> architect docs sync
  -> project-manager final acceptance
  -> Codex Gate 3: Final Diff Review
  -> PR preparation
```

Each gate returns exactly one decision:

```text
approve
request_changes
```

- `approve`: the current evidence is good enough to continue.
- `request_changes`: one or more findings mean the gate should not pass yet.

PM owns routing after `request_changes`. Architecture plan findings go back to
architect. Validation adequacy findings go back to reviewer. Final diff
findings go to architect first for assessment; architect may resolve simple
debug issues directly or route complex issues through Replan.

Gate triggering is PM-driven through the `vcm-codex-review-gate` skill. PM uses
the skill at the three gate trigger points. The skill checks VCM-provided Codex
review state and asks VCM to start a review when the gate is enabled, required,
and not already approved for the current input.

VCM owns execution. When review starts, the VCM flow remains running and enters
a Codex review stage. VCM ensures the long-lived `codex-reviewer` embedded
terminal session is running, sends the gate prompt into that session, records
state, validates the report shape, and calls PM back when review finishes. PM
then reads the report and continues or routes by gate type. The same Codex
Reviewer terminal remains available after the gate so the user or PM can
continue discussing, challenging, or confirming the review result in context.
Codex execution failure is VCM/tool failure, not `request_changes`; VCM offers
retry, skip, or override and records the chosen exception state.

```text
PM reaches gate trigger
  -> PM uses vcm-codex-review-gate
  -> skill checks VCM Codex gate state
  -> skill requests VCM start review
  -> VCM state = codex-review:running
  -> VCM sends gate prompt to Codex Reviewer terminal
  -> Codex Reviewer writes report
  -> VCM records completed / failed / skipped / overridden
  -> VCM emits Codex review callback to PM
  -> PM reads report and continues or routes
```

## 4. Gate 1: Architecture Plan Review

Run after architect produces the architecture plan and before coder begins
implementation.

Primary artifact:

```text
.ai/vcm/handoffs/architecture-plan.md
```

Recommended inputs:

- original user request
- project-manager route message or durable task plan when present
- architecture plan
- relevant durable architecture docs
- `docs/TESTING.md` when the plan depends on validation strategy
- changed file list when architect created scaffolding

Codex should review whether:

- the plan matches the user request
- the architecture boundaries are clear and compatible with the existing repo
- file responsibilities and public contracts are specific enough for coder
- the plan avoids unnecessary scope expansion
- risks, dependencies, migrations, permissions, data, and error paths are named
- acceptance and validation evidence can be produced
- the plan leaves no critical decisions for coder to guess

Output artifact:

```text
.ai/vcm/codex-reviews/architecture-plan-review.md
```

Routing:

- `approve`: project-manager may route to coder.
- `request_changes`: project-manager routes back to architect.

## 5. Gate 2: Validation Adequacy Review

Run after reviewer produces the review report and before docs sync or final
acceptance.

Primary artifact:

```text
.ai/vcm/handoffs/review-report.md
```

Recommended inputs:

- original user request
- architecture plan
- changed file list
- implementation diff summary
- reviewer report
- validation commands and results
- tests added or changed
- known issues

Codex should review whether:

- the validation evidence proves the requested behavior
- tests cover important edge cases, failure paths, and regressions
- skipped checks are justified and have a clear final validation point
- reviewer findings are resolved or routed
- tests are not only testing implementation details
- high-risk areas such as permissions, state, persistence, concurrency, data
  deletion, and external integrations are covered when relevant
- the reviewer report is specific enough for final acceptance

Output artifact:

```text
.ai/vcm/codex-reviews/validation-adequacy-review.md
```

Routing:

- `approve`: project-manager may request architect docs sync or proceed toward
  final acceptance.
- `request_changes`: project-manager routes back to reviewer.

## 6. Gate 3: Final Diff Review

Run after normal final acceptance evidence exists and before PR preparation or
task completion.

Recommended inputs:

- original user request
- architecture plan
- review report
- docs-sync report
- final acceptance draft when present
- full git diff against the task base branch
- changed file list
- validation summary
- known issues disposition

Codex should review whether:

- the final diff satisfies the user request
- the implementation contains correctness bugs or behavior regressions
- the code follows existing project conventions
- tests and implementation remain aligned
- durable docs and generated artifacts are consistent with the diff
- files outside the expected scope are explained
- high-risk changes are approved or routed
- PR text can honestly summarize the change, validation, and risks

Output artifact:

```text
.ai/vcm/codex-reviews/final-diff-review.md
```

Routing:

- `approve`: project-manager may complete final acceptance and prepare the PR.
- `request_changes`: project-manager routes to architect for assessment.
  Architect decides whether the issue is simple enough for Debug Mode or needs
  the normal Replan flow.

## 7. Review Report Format

Each Codex review report must start with stable fields so VCM can reject stale
or malformed reports:

```md
Gate: <architecture-plan|validation-adequacy|final-diff>
Request: <request-id>
Decision: approve|request_changes
Summary: <one or two sentences>

## Findings

### <severity>: <title>

- File: <path or none>
- Line: <line or none>
- Evidence: <what Codex observed>
- Expected: <gate requirement that is not satisfied>
- Gap: <what is missing, stale, contradictory, risky, or incorrect>
- Risk: <why it matters>

## Residual Risks

- <risk or "None identified">

## Inputs Reviewed

- <artifact or command output summary>
```

Severity values:

```text
critical
high
medium
low
```

Decision rules:

- Any `critical` or unresolved `high` finding requires `request_changes`.
- `medium` findings require `request_changes` when they affect task
  correctness, validation confidence, or maintainability.
- `low` findings do not prevent approval by themselves unless they reveal a
  pattern that affects the gate.

## 8. State Model

Codex reviewer runtime files live under:

```text
.ai/codex/
```

Codex review outputs live under:

```text
.ai/vcm/codex-reviews/index.json
.ai/vcm/codex-reviews/architecture-plan-review.md
.ai/vcm/codex-reviews/validation-adequacy-review.md
.ai/vcm/codex-reviews/final-diff-review.md
.ai/vcm/codex-reviews/requests/<request-id>.json
```

VCM owns `.ai/vcm/codex-reviews/index.json`. It records the enablement marker,
active gate, gate status, report path, decision, input hash, execution error,
skip / override reason, and timestamps. PM reads this state through VCM turn
context or the `vcm-codex-review-gate` skill; PM must not infer Codex state from
report files alone.

The `.ai/codex/` directory is VCM-managed runtime configuration for the fifth
role. It should contain:

```text
.ai/codex/AGENTS.md
.ai/codex/config.toml
.ai/codex/.codex/config.toml
.ai/codex/.codex/hooks.json
.ai/codex/prompts/architecture-plan-gate.md
.ai/codex/prompts/validation-adequacy-gate.md
.ai/codex/prompts/final-diff-gate.md
.ai/codex/schemas/codex-review-result.schema.json
```

`.ai/codex/AGENTS.md` is the role definition for `codex-reviewer`. It should be
the only durable role instruction source VCM provides to Codex for review
gates. VCM should not require a root-level `AGENTS.md`, and it should not
require `.codex/agents/vcm-codex-reviewer.toml` for the first implementation.
The VCM-owned template portion must be bounded by the standard managed block:

```md
<!-- VCM:BEGIN version=1 -->
...
<!-- VCM:END -->
```

The managed block should include the Codex reviewer role, evidence sources,
three gate-specific review criteria, finding format, and write constraints.
Project-local custom notes may live outside the block.

`.ai/codex/config.toml` is VCM-owned launch configuration. Codex does not
natively discover arbitrary `.ai/codex/config.toml` files the way it discovers
`$CODEX_HOME/config.toml` or layered `$CODEX_HOME/<profile>.config.toml` files,
so the VCM Codex adapter reads this file and maps supported keys to the Codex
CLI invocation.

`.ai/codex/.codex/config.toml` and `.ai/codex/.codex/hooks.json` are the
Codex CLI project-level hook configuration. Because VCM starts Codex with
`.ai/codex` as the current Codex project, this nested `.codex` directory is
discovered by the interactive Codex CLI. The config enables hooks, and the
hooks post `UserPromptSubmit` and `Stop` events to VCM:

```text
POST /api/hooks/codex-reviewer
POST /api/hooks/codex-reviewer/stop
```

The hook payload records Codex's own session id, transcript path, cwd, and hook
event name. VCM stores those events on the `codex-reviewer` role session and in
the shared Round state, so a Codex review keeps the VCM flow running until the
Codex `Stop` event is observed and the normal settle timer completes.

VCM should start Codex from `.ai/codex` so that `.ai/codex/AGENTS.md` is
discovered naturally. Because the current session root is then `.ai/codex`, the
permission profile must add the task repository as a profile-defined workspace
root using a relative path:

```toml
[permissions.vcm_codex_reviewer.workspace_roots]
"../.." = true

[permissions.vcm_codex_reviewer.filesystem]
":minimal" = "read"

[permissions.vcm_codex_reviewer.filesystem.":workspace_roots"]
"." = "read"
".ai/codex" = "read"
".ai/vcm/codex-reviews" = "write"
"**/*.env" = "deny"
```

With `--cd <taskRepoRoot>/.ai/codex`, `../..` points back to
`<taskRepoRoot>`. Codex then applies the `:workspace_roots` rules to both the
runtime root and the profile-defined task repository root, allowing read access
to the repository while granting write access only to
`.ai/vcm/codex-reviews/`.

The task repository must ignore `.ai/vcm/`, because review reports and task
runtime state are transient. It should not ignore the whole `.ai/codex/`
directory if `.ai/codex/AGENTS.md`, `.ai/codex/config.toml`, prompts, or schemas
are intended to be durable project configuration. Ignore only transient Codex
runtime files inside `.ai/codex/`, such as logs or temporary materialized
profiles.

Shared types live in `src/shared/types/codex-review.ts`. Gate status is one of
`disabled`, `not_required`, `pending`, `running`, `completed`, `failed`,
`skipped`, or `overridden`.

## 9. Backend Shape

Implemented files:

```text
src/shared/types/codex-review.ts
src/shared/types/codex-hook.ts
src/backend/services/codex-review-service.ts
src/backend/services/codex-hook-service.ts
src/backend/api/codex-review-routes.ts
src/backend/api/codex-hook-routes.ts
```

Implemented API:

```text
GET  /api/tasks/:taskSlug/codex-review
PUT  /api/tasks/:taskSlug/codex-review/settings
POST /api/tasks/:taskSlug/codex-review/:gate/request
POST /api/tasks/:taskSlug/codex-review/:gate/retry
POST /api/tasks/:taskSlug/codex-review/:gate/skip
POST /api/tasks/:taskSlug/codex-review/:gate/override
GET  /api/tasks/:taskSlug/codex-review/:gate/report
POST /api/hooks/codex-reviewer
POST /api/hooks/codex-reviewer/stop
```

Provider implementations should be swappable:

- Codex CLI review command
- OpenAI API reviewer model
- OpenAI-compatible reviewer model
- manual imported review result

The service should assemble gate-specific inputs, run the provider, parse the
decision and findings, write the Markdown report, and update `index.json`.
`requestReviewGate` is the API used by the PM-facing skill / helper. It returns
one of `disabled`, `not_required`, `already_approved`, `running`, `started`, or
`failed_to_start`.

When a review starts, VCM keeps the task flow running in a Codex review stage.
When the provider finishes, VCM emits a Codex review callback to PM with gate,
status, decision, report path, and any failure or exception metadata.

The Codex CLI provider uses the long-lived embedded terminal session, not
`codex exec`, because VCM needs Codex `UserPromptSubmit` and `Stop` hook events
and the user may continue discussing the review after the report is written.
Current implementation shape for a fresh terminal:

```bash
codex \
  --cd <taskRepoRoot>/.ai/codex \
  --add-dir <taskRepoRoot>/.ai/vcm/codex-reviews \
  --sandbox workspace-write \
  --ask-for-approval never \
  --dangerously-bypass-hook-trust \
  --model <model-from-.ai/codex/config.toml> \
  --config model_reasoning_effort="<effort-from-.ai/codex/config.toml>"
```

Starting from `.ai/codex` causes Codex to load `.ai/codex/AGENTS.md` through
its normal `AGENTS.md` discovery path and `.ai/codex/.codex/hooks.json` through
the Codex project hook path. VCM sends the gate prompt into this terminal,
validates the report path, request id, and decision before marking a gate
completed, then callbacks PM. `--ask-for-approval never` and the VCM-owned hook
trust bypass prevent Codex from pausing at permission or hook trust prompts;
execution failures are recorded as `failed` so the user can retry, skip, or
override.

## 10. UI Shape

Add a `Codex Review Gates` group to the left sidebar. It is visible for the
connected active task and contains three independent toggles:

- Architecture Plan
- Validation Adequacy
- Final Diff

All three toggles default to `off`. Turning on any gate writes it into
`.ai/codex/config.toml` under `[vcm.codex_review].required_gates` and sets
`enabled = true`. Turning all gates off writes `enabled = false` and
`required_gates = []`.

The task workspace must not show a separate Codex Review Gates panel. The UI
does not expose manual `Run`, `Run Again`, `Retry`, `Skip`, or `Override`
buttons for gates; PM triggers reviews through the `vcm-codex-review-gate`
skill, and VCM handles execution failures through its managed retry / skip /
override path.

When at least one gate toggle is on, or when the task already has a saved Codex
Reviewer session, the task workspace role tabs include a fifth role, `Codex
Reviewer`. It uses the same embedded terminal surface as the Claude Code roles,
but starts Codex CLI from `.ai/codex`, uses Codex model and effort selectors,
and is not part of PM message routing, auto orchestration, or translation. The
saved launch template still stores the four Claude Code role settings; when a
Codex gate is enabled and no task sessions exist yet, One-click start launches
those four Claude Code roles plus `codex-reviewer` with the Codex Reviewer
defaults.

## 11. Project-Manager Rules

Project-manager must treat Codex Review Gates as external evidence.

Rules:

- Use `vcm-codex-review-gate` at each Codex gate trigger and on each VCM Codex
  review callback.
- Do not route coder implementation before the architecture plan gate is
  approved, unless the user explicitly skips the gate.
- Do not start final acceptance before the validation adequacy gate is approved,
  unless an explicit exception is recorded.
- Do not prepare a PR before the final diff gate is approved, unless an
  explicit exception is recorded.
- Route `request_changes` by gate type, not by any Codex-provided routing field:
  architecture-plan to architect, validation-adequacy to reviewer, and
  final-diff to architect for assessment.
- Do not call Codex CLI directly from PM; PM requests VCM to start review and
  stops when VCM reports `started`.
- Do not let Codex findings disappear into chat history. Record the report path
  and disposition in final acceptance.
- Manual overrides must include who accepted the risk and why.

## 12. Implemented MVP Scope

The first implementation is intentionally small:

1. Add `.ai/codex/AGENTS.md`, `.ai/codex/config.toml`, and
   `.ai/codex/.codex/*` as VCM-managed Codex reviewer runtime files.
2. Add `vcm-codex-review-gate` as the PM-facing skill / protocol entry.
3. Add backend APIs to configure, request, run, retry, skip, override, list,
   and read gate reports.
4. Add sidebar toggles for the three gate enablement options.
5. Add project-manager and final-acceptance harness rules that require checking
   Codex gate reports for complex tasks.
6. Add Codex hook endpoints so the fifth role participates in VCM session and
   Round state.
7. Keep gate triggering PM-driven at first.
8. Do not automatically route roles from Codex findings in the first version.

Later versions can add automatic PM routing, provider selection, stricter
provider-level read/write policies where supported by Codex CLI, and risk-based
gate selection.

## 13. Open Questions

- Should the first implementation support only Codex CLI, or should the
  provider remain pluggable from the start?
- Should VCM enforce the gates in backend state, or should project-manager rules
  enforce them first?
- What task complexity signal should decide whether all three gates are
  required?
- Should final diff review run against the task branch base, connected base
  repository `HEAD`, or an explicit PR base?
- How should large diffs be chunked without losing cross-file reasoning?
- What information must be redacted before sending inputs to a hosted model?
- Which `.ai/codex/config.toml` keys should VCM support in MVP, and which
  should be rejected to avoid surprising Codex CLI behavior?
