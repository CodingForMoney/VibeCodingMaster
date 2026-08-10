# VCM Claude Code Best Practices

Last updated: 2026-07-18

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
.claude/agents/reviewer.md
.claude/agents/translator.md
.claude/agents/harness-engineer.md
.claude/agents/vcm-coder-worker.md
.claude/agents/vcm-architect-evidence-worker.md
.claude/agents/vcm-architect-scaffold-worker.md
.claude/agents/vcm-architect-validation-worker.md
.claude/skills/vcm-route-message/SKILL.md
.claude/skills/vcm-ask-user/SKILL.md
.claude/skills/vcm-task-state/SKILL.md
.claude/skills/vcm-workflow-review/SKILL.md
.claude/skills/vcm-final-acceptance/SKILL.md
.claude/skills/vcm-long-running-validation/SKILL.md
.claude/skills/vcm-harness-bootstrap/SKILL.md
.claude/skills/vcm-gate-review/SKILL.md
.claude/skills/vcm-report-harness-issue/SKILL.md
.claude/skills/vcm-propose-memory/SKILL.md
.claude/skills/restart-architect/SKILL.md
.ai/tools/check-durable-docs
.ai/tools/generate-module-index
.ai/tools/generate-public-surface
.ai/tools/request-gate-review
.ai/tools/vcm-ask-user
.ai/tools/update-task-state
.ai/tools/check-scaffold-ledger
.ai/tools/request-architect-restart
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

The fixed installer seeds `.ai/tools/generate-module-index` and
`.ai/tools/generate-public-surface` only when they are missing. After the first
install they are project-owned tools: Bootstrap and Harness Engineer may adapt
them to the project's languages and conventions, and later VCM harness updates
must preserve their content.

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
- Whole-file harness files are VCM-owned only when the manifest marks them as
  `whole-file`.
- Generated-context tools seeded by the installer are project-owned after
  creation.
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
docs/plans/               # active or planned work only
```

Ownership:

- Architect owns architecture planning, module boundaries, code scaffolding,
  Debug Mode, docs sync, and durable architecture docs.
- Tester owns independent validation and `docs/TESTING.md` as current
  validation strategy, with integration/E2E case lists.
- PM owns routing and final evidence acceptance, not technical analysis.
- Coder owns implementation, baseline unit/contract/regression tests, scaffold
  completion, and ordinary coding standards.

Durable docs describe current project truth. Updating them replaces superseded
content; it does not append task chronology, investigation history, role
verdicts, commit history, or completed-work reports. Git, PRs, and task handoffs
preserve execution history.

- Project and module architecture docs explain current responsibilities,
  boundaries, data flow, lifecycle, invariants, collaboration contracts, and
  public-surface meaning. They do not duplicate source inventories or complete
  API listings.
- `docs/TESTING.md` keeps current strategy, runnable commands, stable
  behavior-level integration/E2E cases, selection rules, cleanup, and current
  gaps. It does not inventory every test function or retain past verdicts.
- `docs/known-issues.md` contains only current unresolved durable issues and
  accepted limitations. Resolved entries are removed; partially resolved
  entries are rewritten around the remaining gap.
- `docs/plans/**` contains only active or planned work. Completed or superseded
  plans leave that collection; Git and PR history retain their previous form.
- Architect Docs Sync reconciles changed facts across architecture docs, active
  plans, testing docs, known issues, code, and generated context. The owning
  role fixes contradictions before the task can be accepted.
- `.ai/tools/check-durable-docs` mechanically checks high-confidence violations
  after bootstrap and durable-doc updates. It supplements semantic Docs Sync;
  it does not attempt to infer architecture correctness.

## 5. Runtime State

Task runtime state lives under `.ai/vcm/` in the task worktree. Durable tool
state can live under `.ai/vcm/` in the connected base repo.

Role handoffs are replaceable current-state artifacts, not append-only logs.
Every rewrite must be a complete, self-contained snapshot of the current
result: it carries forward all still-relevant decisions and evidence, removes
superseded content, and never depends on a prior round, overwritten report,
consumed route message, Session, or transcript.

Current runtime paths include:

```text
<taskRepoRoot>/.ai/vcm/handoffs/
<taskRepoRoot>/.ai/vcm/handoffs/messages/
<taskRepoRoot>/.ai/vcm/handoffs/role-commands/
<taskRepoRoot>/.ai/vcm/handoffs/architecture-brief.md
<taskRepoRoot>/.ai/vcm/handoffs/architecture-evidence.md
<taskRepoRoot>/.ai/vcm/handoffs/architecture-plan.md
<taskRepoRoot>/.ai/vcm/handoffs/architecture-diagnosis.md
<taskRepoRoot>/.ai/vcm/handoffs/coder-completion.md
<taskRepoRoot>/.ai/vcm/handoffs/test-report.md
<taskRepoRoot>/.ai/vcm/handoffs/docs-update-report.md
<taskRepoRoot>/.ai/vcm/handoffs/docs-sync-report.md
<taskRepoRoot>/.ai/vcm/handoffs/workflow-progress.md
<taskRepoRoot>/.ai/vcm/handoffs/final-acceptance.md
<taskRepoRoot>/.ai/vcm/handoffs/known-issues.md
<taskRepoRoot>/.ai/vcm/gate-reviews/
<taskRepoRoot>/.ai/vcm/workflow/state.json
<taskRepoRoot>/.ai/vcm/jobs/<job-id>/
<taskRepoRoot>/.ai/vcm/memory-review/
<baseRepoRoot>/.ai/vcm/translations/
<baseRepoRoot>/.ai/vcm/harness-engineer/  # retained legacy project-session state
<baseRepoRoot>/.ai/vcm/bootstrap/
<baseRepoRoot>/.ai/vcm/harness-feedback/
```

App-local records live under `<vcmDataDir>/projects/` and app settings live in
`<vcmDataDir>/settings.json`.

Runtime recovery on project connect should clear or reconcile stale running
state, recover tool sessions, recover task rounds, clear impossible
activity, and remove temporary translation runtime leftovers. Runtime process
ids are in-memory checks, not durable project data.

Task workflow state is PM-declared recovery context. PM may use
`vcm-task-state` at checkpoints, but that declaration cannot authorize a role
dispatch. Workflow permission comes from the append-only
`workflow-progress.md` record and one backend-owned pending approval. Round,
Turn, Session, and Gate Review state remain separate observed runtime facts.
User-question waiting is a hard workflow-control state: `vcm-ask-user` records
the exact question and cancels the pending approval before PM asks it. Only a
new direct user prompt clears that wait.

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
- `reviewer`: optional VCM flow role. It is visible when any Gate Review
  gate is enabled or a reviewer session already exists. It is task-scoped
  in the active worktree, uses normal Claude hook/Round/translation handling,
  and does not participate in route-file dispatch.

Tool roles:

- `translator`: task-scoped translation tool role. It is not part of VCM
  workflow round completion and does not appear in the top role tab bar.
- `harness-engineer`: task-scoped harness maintenance tool role. It is not
  part of task workflow round completion.

Tool roles run in the active task worktree. Durable tool state such as
translation memory or harness feedback may still live under the base repo.
The backend runtime coordinator creates or resumes Harness Engineer for the
active task and does the same for Translator when translation is enabled and
Harness initialization is complete.

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
gate is enabled, it also starts or resumes Reviewer with the saved template
entry. Translator and Harness Engineer are controlled from their own tool-role
panels, not from the main task launch template.

## 9. PM Flow and Managed Mode

Default code-change route:

```text
project-manager
  -> architect interview
  -> architect planning
  -> architecture-plan Gate Review
  -> coder
  -> tester
  -> validation-adequacy Gate Review
  -> code-diff Gate Review
  -> architect docs sync
  -> project-manager final acceptance
```

Additional routes:

- Architect Debug Flow or a code-producing Architecture Diagnosis Flow uses a
  complete code-delivery flow:
  `project-manager -> architect mode -> tester -> validation-adequacy Gate Review -> code-diff Gate Review -> architect docs sync -> project-manager final acceptance`
- Architect Debug Branch or Architecture Diagnosis Branch suspends the parent
  flow, records its resume point, runs the mode through tester,
  validation-adequacy Gate Review, and code-diff Gate Review, then returns to
  that resume point without branch-level final acceptance.
- An analysis-only Architecture Diagnosis Flow completes from its diagnosis
  result without final acceptance.
- Docs-Only Flow:
  `project-manager -> assigned Architect/Coder/Tester documentation role or roles -> project-manager completion`
- Validation-Only Flow:
  `project-manager -> tester -> validation-adequacy Gate Review -> project-manager completion`
- Communication-Only Flow: `project-manager response or relay -> completion`
- PR-Preparation Flow starts only after the active delivery flow completes.

Inside any Tester validation step, a confirmed defect confined to tests,
fixtures, test-only helpers, or `docs/TESTING.md` returns to Tester for a
PM-routed repair, commit, bounded defect-class sweep, and repeated validation.
If the repair requires production, runtime, public-contract, dependency,
generated-context, architecture, or shared-production changes, the active
flow's Architect failure branch applies instead.

Docs-Only roles submit a fresh `docs-update-report.md` after each assignment;
the latest `synced` or `unchanged` report permits completion. If Docs-Only Flow
reveals implementation or validation work, switch to the matching full flow.
If Validation-Only Flow reveals that the accepted outcome requires
production-code, runtime-behavior, public-contract, dependency, or
system-architecture changes, route through the full Code-Change Flow.

PM Managed Mode applies only when the user explicitly requests it. PM must drive
the task to completion, route ordinary technical decisions to the responsible
role, and ask the user only when user intent, authorization, real-world
constraints, external accounts/secrets/data access, cost, production permission,
sensitive data access, durable-doc conflict, or a proven requested-outcome change
requires explicit user direction.

When PM reports a blocker, failed validation, Gate Review finding, Architecture
Diagnosis result, unresolved risk, or workflow pause, it reads the complete
source artifact and preserves the problem, expected behavior, cause or remaining
uncertainty, evidence, impact, unresolved state, and next action. Plain language
translates technical facts instead of deleting them.

### User Communication

A message without a VCM marker is user communication. When the user asks a
question, the role answers only. Any file change, test, artifact update, message,
PM report, or workflow action requires an explicit user instruction.

## 10. Architecture Interview, Plan, and Scaffold

Before architecture planning, Architect uses \`vcm-architecture-interview\` to
resolve user-owned behavior and contract decisions one question at a time and
to capture current-worktree code evidence. Facts available from the worktree
are investigated rather than asked. User decisions live in
\`.ai/vcm/handoffs/architecture-brief.md\`; the bounded code paths, lifecycle,
callers, consumers, external boundaries, and code/doc conflicts live in
\`.ai/vcm/handoffs/architecture-evidence.md\`. Architect does not plan,
scaffold, or implement during the interview.

After PM routes planning from the confirmed brief, Architect writes
`.ai/vcm/handoffs/architecture-plan.md`.

Architect artifacts, not Session memory, are continuation state. Verified code
facts and confirmed decisions are written to their owning artifact as soon as
later work depends on them. A planning step is complete only after its current
architecture conclusions, affected surfaces, ledger items, risks, and evidence
references are present in `architecture-plan.md`; `planning-progress.md` cannot
mark the step complete first.

The plan must cover:

- accepted scope
- current code reality
- existing assumptions and class coverage
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
the manifest, not in permanent source comments. Its table uses full-token IDs
matching `[A-Z]{2,6}-[0-9]{1,4}`. A plan with no scaffold items uses the exact
line `No scaffold items.` instead of an empty table.

When a proposed file-local override, normalization, or bypass of a shared
default, constant, or documented contract already exists in two other files,
Architect treats the third occurrence as an upstream ownership or contract
signal. The architecture decision must fix the owner, confirm intentional local
handling and correct the owning docs, or record the unresolved issue and
affected call sites. Moving the repeated behavior into a helper is not enough.

For every existing code site the plan or scaffold changes, Architect verifies
the site's current assumptions against implementation and configuration, then
records whether the plan preserves, updates, or invalidates them. When the plan
newly handles one member of an existing persisted structure, gate, invariant,
or semantic class, it records the complete directly related member set and a
disposition for each member.

Code scaffolding may create files and define non-private callable surfaces, but
incomplete implementation must use `VCM:CODE <Scaffold Manifest ID>` markers.
Coder removes/completes those markers and reports Scaffold Completion by ID.
`check-scaffold-ledger --mode scaffold` validates the pre-implementation
Manifest-to-Marker bijection. Before final handoff,
`check-scaffold-ledger --mode completion --completion <candidate>` validates
each reported `done/removed` or `failed/present` disposition against the final
tree. Marker count alone never determines the lifecycle.

Architect may use foreground evidence workers for bounded supporting reads that
would otherwise add substantial raw context. The worker writes a factual report;
Architect personally reads and LSP-verifies decision-bearing code, reviews the
report, and consolidates accepted facts into architecture evidence.

After the plan and Scaffold Manifest are complete, Architect invokes the
foreground scaffold worker for the exact scaffold and plan-fixed mechanical
text or configuration changes. Exact non-interactive validation commands may be
delegated to the validation worker. Architect selects the commands, interprets
their raw results, reviews every worker output, and owns any correction. Native
Architect evidence, scaffold, and validation workers use Opus with xhigh effort;
Bridge sessions make them inherit the selected GPT model. Every worker returns
before the Architect turn continues and cannot invoke another subagent.

After completed planning and scaffold commits, Architect runs the
`restart-architect` skill before writing its first completed route to PM. The
request is task-level and idempotent: architecture-plan Gate revisions reuse
the same pending restart. VCM waits for normal Architect Stop and PM's actual
acceptance of the latest route, then starts a fresh Architect session with the
same launch settings and a short restoration system prompt. No restart occurs
for incomplete planning, Debug/Diagnosis/docs work, StopFailure, or task close.

When Auto Memory is enabled, the restart request assigns an exact
task-level planning-session memory candidate path. Architect writes one
provisional proposal there before routing. VCM never deletes or recreates that
candidate during restart scheduling or Gate revision. It keeps the old Session
if the candidate is missing or malformed, reports the blocked restart, and
snapshots a valid candidate into the later Auto Memory run. The replacement
Architect validates it against final task evidence; Harness Engineer makes the
final keep, revise, or discard decision. Close Task removes the candidate with
the task worktree.

The active architecture plan should describe the full accepted task scope. It
may include implementation order, but that order must not defer requested scope.
The plan is the current executable plan, not a changelog; revisions should
replace superseded decisions and stale scaffold rows instead of appending
history.

During Debug Mode, Architect maintains `architect-debug.md` from the initial
failure evidence through confirmed root cause, implementation, and validation.
During Architecture Diagnosis, Architect maintains Code Reading Closure, writes
the current architecture, failure trace, assessment, and required direction
before implementation, then records implementation and validation as they
complete. Before any Architect turn ends, every fact or conclusion required to
continue must be present in the current artifacts rather than only in Session
context.

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

Before every PM dispatch to Architect, Coder, or Tester, PM uses
`vcm-workflow-review` to submit the next `workflow-progress.md` revision. VCM
validates the append-only history, requested flow, target role, and current
artifacts, then grants one matching route. Route frontmatter contains no
workflow approval metadata. The approval is consumed only when the target
role's matching `UserPromptSubmit` confirms delivery.

If VCM rejects a transition, PM remains in the current turn. A direct user may
authorize that exact rejected transition. PM first uses `vcm-ask-user`, waits
for the reply, and then copies the user's exact authorization into the next
Workflow Progress submission. The authorization is bound to one revision,
flow, target, evidence, and violated rule and can be consumed only once.

Workflow-role Markdown must be submitted through `.ai/tools/vcm-artifact`.
Workflow roles write candidates outside `.ai/vcm`; VCM checks
the artifact owner, required structure, strict values, lifecycle state, and
assigned path before atomically replacing the authoritative file. Draft mode is
for valid in-progress state, while final mode requires a terminal artifact.
Validation failure preserves the previous accepted file and returns the exact
errors to the role. The PreToolUse guard blocks direct Bash, Write, or Edit
updates to managed workflow Markdown.

Docs-Only Flow uses the shared `docs-update-report.md`, which Architect, Coder,
or Tester may submit. The code-producing-flow `docs-sync-report.md` remains
Architect-owned and is not reused for Docs-Only completion.

Harness Engineer is not a workflow role. It writes the assigned Task Harness
Retrospective Result Path directly; its Stop Hook reads the report and checks
the assigned feedback dispositions without routing the report through
`vcm-artifact`.

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

- `architecture-plan` requires a complete, confirmed
  `.ai/vcm/handoffs/architecture-brief.md`, a complete
  `.ai/vcm/handoffs/architecture-evidence.md`, and uses
  `.ai/vcm/handoffs/architecture-plan.md` as its core plan input. A missing,
  incomplete, or unconfirmed brief/evidence artifact fails the gate request; a
  missing or empty plan is `not_required`.
- `validation-adequacy` uses `.ai/vcm/handoffs/test-report.md` as its core
  input. Missing or empty core input is `not_required`.
- `code-diff` is triggered only after Tester completes and the current
  validation-adequacy Gate finishes successfully for a Coder implementation,
  Architect Debug fix, or Architecture Diagnosis fix. PM supplies the matching
  `coder`, `architect-debug`, or `architect-diagnosis` production-code source.
  PM does not inspect commits; the tool reviews committed implementation and
  test inputs, excludes `[VCM Harness]` commits, returns `not_required` when
  there are no reviewable commits, and fails to start when the worktree has
  uncommitted changes. Test failures caused by Harness changes still follow the
  normal Tester failure flow.
- `code-diff` fails to start when `test-report.md` is incomplete or when a
  required validation-adequacy decision is missing or stale. When
  validation-adequacy is disabled, completed Tester evidence is still required.
- When rejected code receives corrective commits from another source, code-diff
  retains the original base and source evidence and appends the corrective
  source. The next review covers the complete non-Harness source chain.
- Architect Debug writes `.ai/vcm/handoffs/architect-debug.md` before code-diff
  so the review receives the confirmed root cause and completed-fix evidence,
  not only the original Architect route command.
- Code-diff searches for repeated file-local overrides when a changed hunk adds
  one. A third occurrence without the Architect-owned upstream disposition is
  `request_changes`; a documented post-validation docs-sync commitment is valid
  when the disposition itself is already explicit.
- Architecture-plan review independently runs a backward-impact pass over every
  plan-cited or scaffold-touched existing site. It rejects invalidated
  assumptions without architecture correction and incomplete disposition of a
  directly related existing semantic class.
- Gates avoid duplicate review by comparing input hashes. Architecture review
  binds the confirmed brief, code evidence, and plan to current scaffold/code evidence; validation review binds the
  test report to current non-document code/test evidence and `docs/TESTING.md`;
  code-diff review binds the selected non-Harness commits and their patches, current test
  report, and validation-adequacy report.
- Each Gate request snapshots its referenced `.ai/vcm` handoffs and prior-Gate
  evidence under the request record. Reviewer uses those immutable snapshots
  for role-produced evidence, so a later handoff rewrite cannot change what the
  request reviewed.

Reviewer writes reports under:

```text
.ai/vcm/gate-reviews/
```

Reviewer returns only `approve` or `request_changes`, writes only its
assigned gate report, does not run tests, and does not choose fix owners,
Replan, or user-intervention needs. PM routes `architecture-plan` findings to
Architect and `validation-adequacy` findings to Tester. Every code-diff finding
classifies its affected scope. When every finding is `test-only`, PM routes the
correction to Tester; any `implementation` finding uses the active flow's
Architect correction branch.
Each gate report must include its gate-specific structured analysis. Code-diff
analysis accounts for every changed file and affected behavior; its findings
must identify a concrete file, line or symbol, and finding scope.

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

Tester owns validation adequacy. `test-report.md` maps each accepted changed
behavior or relevant risk to its validation level, actual test case or external
evidence, exercised entry path, assertions, result, and remaining gap.
It also records strict test-infrastructure status, affected files, boundary
evidence, defect-class sweep, and repair commit. A report with
`repair-required` or `production-change-required` cannot enter
validation-adequacy Gate Review.
`Test Result: incomplete` records a validation turn that ended with no blocking
issue while concrete required checks remain. The report records completed and
remaining validation, PM routes Tester continuation, and the report cannot
enter Validation Adequacy Gate or Final Acceptance.
L2 covers behavior that can be completely proved from a stable integration
entry point. L3 is mandatory when a task adds or changes externally observable
end-to-end behavior, affects a documented L3 production path, changes that
flow's lifecycle or external contract, changes a cross-component critical
invariant that requires the complete production path, or fixes a defect that
escaped L1/L2. Required L3 cannot be replaced by L2. Tester must map each
affected flow to an existing, updated, or new L3 case and record its command and
result. Unavailable required coverage is blocking. Tests must assert real
behavior, not mock-call rituals or fixture-specific shortcuts.

Tester cannot create `Coverage Gaps` or add durable `Known Testing Gaps`
without the user's exact approval. Required coverage that cannot be completed
by another Tester continuation remains `Test Result: fail` and follows
Architect Debug, then Architecture Diagnosis. Only after Diagnosis still cannot
resolve the gap may PM ask the user to accept it. Approval allows the exact risk
to remain and the workflow to continue; it does not convert the failed
validation result to `pass`.

The Validation Adequacy Gate reads the actual implementation entry points and
test files behind that mapping. Its report must contain structured Validation
Analysis, including an independent L3 trigger assessment and separate L2 and L3
coverage findings; `Test Result: pass` and green commands alone are not approval
evidence. Reviewer rejects required L3 that is missing, replaced by L2,
unexecuted, mapped to an old case without relevant assertions, or bypasses the
project-owned production path. For an approved gap, Reviewer verifies the Debug
and Diagnosis evidence, the exact user authorization, the retained risk, and
any durable testing-gap entry. Gate approval confirms evidence adequacy, not
test success. Reviewer inspects evidence but does not run validation.

Long-running validation uses `vcm-long-running-validation` backed by:

```text
.ai/tools/run-long-check
.ai/tools/watch-job
```

VCM roles must not run background Bash. `vcm-bash-guard` denies
`run_in_background`, `nohup`, `setsid`, `disown`, and trailing `&`.
`run-long-check` accepts the validation executable and arguments directly and
rejects shell command-string wrappers whose pipeline or trailing command could
mask the validation exit code. `run-long-check` and `watch-job` must each be the
only top-level command in their Bash call so their exit status cannot be
replaced by a pipeline, command list, conditional chain, or subshell. While a
watcher is active it renews a short supervision lease. A normal watch-window
exit records a bounded handoff for the next model-generated watcher call;
watcher disappearance without that handoff still causes short-lease orphan cleanup.

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

Generated context is the source of truth for module inventories, manifests,
workspace dependencies, source/test file inventories, and complete public
surface listings. Durable prose explains design intent and contract meaning
instead of independently maintaining those machine facts.

Current support covers Rust/Cargo projects and npm workspace TypeScript /
JavaScript projects. Other repository shapes need project-specific generators
before `.ai/generated/*` is considered reliable.

Generated artifacts are derived context. Regenerate them after relevant source,
manifest, module, or public API changes. Do not hand-edit them as durable truth.

For Architect code reading, generated context locates the boundary; it does not
replace semantic navigation or source inspection. VCM loads its bundled LSP
bridge only for Architect, and the project runtime must provide the matching
language-server executable. The Architect definition preloads
`vcm-code-navigation`. The skill uses definitions, implementations, references,
and call hierarchy when those semantic relationships are required, then requires
every resolved callable unit to be read in full. LSP references are
symbol-specific: query accessors, backing fields, trait declarations,
implementation methods, wrappers, and aliases separately rather than treating
one reference result as a complete semantic class. It does not run an
unconditional file-symbol warm-up. A successful executable probe alone is not
workspace readiness. Startup or indexing time does not permit replacing a
required semantic query with text matching. When the correct symbol query is
demonstrably partial for a relationship LSP cannot model or expose, exact source
search may locate candidates only inside the already identified owning file or
module; record the LSP gap, read every candidate, and verify its semantics.
Otherwise use generated context, architecture documents, and runtime evidence
for boundaries LSP does not model. If the relationship still cannot be resolved,
keep it unresolved. Expand one dependency hop at a time instead of injecting an
unrestricted repository graph. Coder and Reviewer use generated context, Glob,
Grep, and full source reads without loading separate language servers.

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

Before its commit, bootstrap runs `.ai/tools/check-durable-docs` and corrects
bootstrap-owned findings so the first durable-doc baseline is already a
current-state snapshot.

VCM runs bootstrap through task-scoped `harness-engineer`:

- run deterministic fixed installer first
- start/resume Harness Engineer in the active task worktree
- ask it to use `vcm-harness-bootstrap`
- let Harness Engineer create its own `[VCM Harness]` bootstrap commit
- mark bootstrap complete from the Harness Engineer `Stop` hook

Reusable harness issues are reported through `vcm-report-harness-issue`.
These reports are stored as pending feedback in Harness Studio. The user may
send one report to the active task's Harness Engineer for review. Reports do not
automatically dispatch Harness Engineer or create a separate approval workflow.

Auto Memory controls the entire automated memory workflow. When enabled, Review
Task Harness after a normal stopped Round with valid Final Acceptance asks
workflow roles to submit evidence-backed proposals sequentially through
`vcm-propose-memory`; the following Task Harness Retrospective asks Harness
Engineer to consolidate them into shared and role-specific memory while
reviewing the task. Every proposal item identifies its shared or current-role
target and supporting evidence. Adds and updates also state why the memory is
necessary, the impact of omitting it, and whether the knowledge belongs in
memory or a durable document. Harness Engineer reviews every existing memory
entry before evaluating proposals and records why it should remain, what
removing it would affect, and whether a durable document is the correct source.
It then reviews every proposal item separately. For each Add or Update candidate,
the report must independently explain why it is necessary, the impact if absent,
whether it belongs in memory or a durable document, the evidence checked, and
the exact final memory content when retained. The required report block contains
only the memory commit, review-result path, and durable-document assignment
count. Harness Engineer writes the complete decision set to the assigned
`review-result.json`, owns the semantic judgment, directly edits shared memory in the root
`CLAUDE.md` `<VCM-memory>` block and role memory in the matching
`.claude/agents/*.md` block, and commits only the changed memory host files. VCM
requires one structurally valid decision for every existing entry and proposal,
requires one assignment for every move-to-durable-doc decision, and verifies
that moved content is already absent. It does not replace Harness Engineer's
semantic judgment, apply an intermediate reviewed-memory set, or create that
commit. On Stop it also verifies the commit and memory-block boundaries, then
records the committed after snapshot, diff, and review history under
`.ai/vcm/memory-review/`. Active memory is read-only to other role turns.
Proposal prompts sent to workflow roles use their normal task sessions and
participate in Round/Turn tracking. Their hooks start or continue the
post-acceptance Round, which settles to stopped after the last workflow-role
proposal. Harness Engineer review remains tool-role activity and is excluded
from that Round.

If planning used the post-planning Architect restart, the old planning Session
first records a provisional candidate at the VCM-assigned path. The Auto Memory
run snapshots that candidate, presents it to the replacement Architect with the
final task evidence, and includes it in Harness Engineer review. It is review
input only and never active memory by itself. VCM keeps the deferred restart and
replacement restoration intent in the task worktree until the new Architect's
first prompt records a durable Claude Session ID, so a backend restart cannot
discard that planning handoff.

Task Harness Retrospective runs after optional memory proposal collection. The backend
uses the current accepted `final-acceptance.md` hash as the ordering key. When
Auto Memory is disabled, Harness Engineer does not request proposals or update
memory. When enabled, pending, collecting, and failed memory work delay the
retrospective; `reviewing` means proposals are ready. The single retrospective
turn reviews reusable harness problems, pending Harness Feedback, memory
proposals, the current memory snapshot, and the final task evidence. Harness
Engineer applies and commits reviewed memory in that turn; VCM records the result
only after the retrospective report and `review-result.json` exist and the
committed changes stay within the assigned memory blocks. A
move-to-durable-doc decision removes memory immediately, then enters a
backend-owned sequence of durable-document assignments. Architect owns
architecture and known-issues documents; Tester owns testing documentation; PM
chooses Architect, Coder, or Tester for an unknown path and asks the user only
when ownership remains uncertain. Each role commits the documentation and
submits the exact Assignment ID in `docs-update-report.md`. This work is not a
Docs-Only Flow. The retrospective remains open until every assignment succeeds;
failed assignments remain available for retry and are resumed after backend
restart.

## 16. Final Acceptance

`vcm-final-acceptance` is PM's final evidence audit for a complete code-delivery
flow, including Architect Debug Flow or an Architecture Diagnosis Flow that
produced code changes. Architect Debug Branch or Architecture Diagnosis Branch
returns to the recorded parent-flow resume point and does not run its own final acceptance.
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
unresolved, docs sync is missing for durable changes, the durable-doc audit is
missing or failed after durable-doc changes, known-issues disposition is
missing, or unexplained high-risk files remain.

## 17. Translation

Translation is a task-scoped tool feature powered by the Claude Code
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
- Gateway never sends directly to architect, coder, tester, or Reviewer.
- Gateway pushes only the last PM reply from a normally completed Round, along
  with the Round completion notice.
- Gateway state, credentials, and audit logs live in app-local state, not
  connected repositories.
- Lark uses the most recent active reachable chat as the PM reply target.
- Browser flow-pause UI remains blocking while Gateway is on. Gateway enablement
  turns pause-alert sound off once, and Gateway input successfully submitted to
  PM dismisses the active browser alert.
- Gateway translation should reuse the existing translation result when
  available and avoid duplicate translation work.
- Starting Gateway enables conversation translation, auto-send, and the
  `round-final` output mode.
- Outbound delivery sends the PM original first, then the existing translation
  panel result. `/retry` is the explicit path that may create a replacement
  translation after failure or a missing result.

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
- `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
  `SubagentStart`, `SubagentStop`, and `PreCompact`: provide
  runtime progress evidence for suspected-stall warnings only. They do not
  update Turn, Round, routing, or Auto Memory state.

When an expected progress hook does not arrive before the phase deadline, VCM
shows a warning through the existing task workspace state. Detection does not
stop or resume Claude Code. Ignore suppresses the current warning; Recover is an
explicit user action that revalidates the active Session and Round, then resumes
the same Claude Session with a continuation prompt.

Role retry is enabled by default. Retryable StopFailure events retry up to 20
times: first after 1 minute, then +1 minute per attempt. Non-retryable errors
include authentication, billing, invalid request, model-not-found, and
max-output-token failures. Context-length and request-too-large failures are
also non-retryable because resending the unchanged context cannot recover them.

Round state is backend-owned. Stop starts a 10 second settle window; a new
`UserPromptSubmit` inside the window continues the same Round. If no new prompt
arrives, the Round stops. The blocking flow-pause modal is independent of the
sound preference; when enabled, its sound repeats until the modal is dismissed.
Round tracking includes the five workflow roles only; Translator and Harness
Engineer sessions do not affect Round completion.

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
6.  Reviewer is an optional VCM flow role, task-scoped when used.
7.  Translator and Harness Engineer are task-scoped tool roles, not flow
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
20. Review Task Harness runs Auto Memory first when enabled, then Task Harness
    Retrospective.
21. Temporary documents are deleted; durable documents are updated.
