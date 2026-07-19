# VCM Workflow Review Plan

Last updated: 2026-07-19

Status: design draft. Resolve the open decisions in this document before
implementation.

## 1. Goal

VCM must enforce the role-dispatch portions of the fixed task flows and their
explicitly allowed branches. Project Manager proposes the next target role and,
only when starting or switching a flow, the selected flow. VCM decides whether
that PM-to-role dispatch is legal in the current workflow state.

The governing rule is deny by default:

- a transition explicitly allowed from the current state may proceed
- a transition not explicitly allowed from the current state is rejected
- PM does not gain authority to invent, skip, reorder, or reinterpret workflow
  branches
- only an exact user-authorized override may bypass a rejected transition

VCM validates workflow legality. It does not perform technical analysis or
choose the next target for PM.

Workflow Review does not review PM-only activity. Waiting for the user, PM's
own analysis or final response, Final Acceptance completion, task completion,
and PR preparation do not require a Workflow Review request.

## 2. Current Gap

The current task workflow state is advisory PM-declared context. PM can write
arbitrary flow, step, branch, resume-point, and status values. Message delivery
checks only the PM-hub route topology and records the declaration after dispatch
on a best-effort basis.

This records what PM claimed but does not prevent PM from selecting an illegal
next role or bypassing a required flow branch.

## 3. Enforcement Model

Workflow dispatch uses two backend-enforced stages:

1. PM asks VCM to review the proposed target role and any requested flow start
   or switch.
2. VCM allows the next PM route only when it matches the approved target role.

The approval is backend state. PM does not copy an approval identifier,
transition, revision, or other workflow-review metadata into the route message.

The existing route-file format remains focused on role communication.

## 4. Workflow Review Skill And Tool

Add:

```text
.claude/skills/vcm-workflow-review/SKILL.md
.ai/tools/request-workflow-review
```

PM must use the skill before every PM-to-role route.

The command-line interface is:

```text
.ai/tools/request-workflow-review --target-role <role>
.ai/tools/request-workflow-review --flow <flow> --target-role <role>
.ai/tools/request-workflow-review [--flow <flow>] --target-role <role> \
  --user-authorization <exact-user-text>
```

`--target-role` is required. Workflow review approves a complete role
transition, including any Flow start, Flow switch, Branch entry, Branch
replacement, or Branch return required before that role starts.

`--flow` is supplied when starting a flow, switching a top-level flow, entering
or replacing a Code-Change Branch, or requesting return from a Branch:

- no active flow plus `--flow` starts that flow
- omitted `--flow` continues the current flow
- the current top-level flow supplied again without an active Branch is an
  idempotent continuation request
- `--flow code-change` with a target role while a Code-Change Branch is active
  requests Branch exit, parent-flow restoration, and the next role dispatch in
  one approval
- a different flow requests a top-level switch, Branch entry, or Debug-to-
  Diagnosis Branch replacement as determined by current state

The supported flow values are `code-change`, `architect-debug`,
`architecture-diagnosis`, `docs-only`, and `validation-only`.

The request does not contain a destination step, branch, resume point, workflow
revision, evidence references, approval identifier, or separate operation
label. VCM derives the legal destination from authoritative workflow state, the
optional requested flow, and the target role. PM selects the requested legal
path from the role or Gate result it received; VCM does not parse that result or
use a Hook to choose the transition for PM. Architect Debug and Architecture
Diagnosis are interpreted as standalone flows or Code-Change branches from the
current authoritative state.
From a non-Code-Change flow they are top-level flow switches. From Code-Change,
Debug or Diagnosis enters the single Branch slot; Diagnosis requested while
Debug Branch is active replaces Debug and preserves its entry and resume steps.

When requesting an override after a denial, PM also supplies the exact user
authorization text. VCM resolves and verifies its backend-owned source record.

The tool returns one of two normal results:

```text
allowed
denied
```

For `allowed`, VCM stores the approved target role and complete derived
destination state. PM then invokes the normal role dispatch path and ends the
turn. Branch return is not applied separately; it remains part of the pending
transition until the approved target dispatch succeeds.

For `denied`, VCM stores no dispatch approval. The tool returns the current
workflow state, requested target role and flow, the exact rejection reason, and
the target roles or flow changes allowed from the current state. PM remains in
the current turn, checks the flow again, and submits another review request.

## 5. Pending Dispatch Approval

Each task has at most one pending PM dispatch approval.

The backend record contains at least:

```text
task slug
workflow revision
source workflow state
requested flow when supplied
approved target role
derived destination workflow state
normal or user-override decision
created time
user-authorization evidence when applicable
dispatch status
```

The record is internal VCM state. Route messages do not carry these fields.

A new workflow-review request replaces any unused pending approval for the same
task. A workflow state revision change invalidates an unused approval.

An approval is valid for one PM dispatch only. It cannot authorize multiple
messages to the same role.

## 6. Role Dispatch Enforcement

`vcm-route-message` remains the PM-hub channel for normal role messages. Gate
Reviewer dispatch uses the Gate Review controller. Both paths require and
consume the matching pending workflow approval.

The backend remains the enforcement boundary. For a normal PM-to-role route, it
loads the task's pending dispatch approval and compares only backend-owned facts
with the route:

- the route is from Project Manager
- the route target role equals the approved target role
- the approval still belongs to the current workflow revision
- the approval has not already been consumed or invalidated

When these conditions match, VCM permits the normal message dispatch. No
workflow approval fields are required in route-file frontmatter.

When no pending approval exists, the approval was denied, the target role does
not match, or the approval is stale, VCM must not send the message.

When the approved target is Gate Reviewer, `.ai/tools/request-gate-review` must
find a matching pending approval before the Gate controller may start or reuse
the Gate Reviewer. A different gate target, source, or workflow revision is
rejected.

Non-PM reports to PM do not require workflow approval. They provide evidence
for PM's next workflow-review request and cannot directly advance workflow
state.

## 7. Approval Consumption

VCM must prevent both duplicate dispatch and false state advancement.

When a matching normal route is selected for delivery, the pending approval
moves to an internal dispatching state so another Hook cannot reuse it. The
approval is consumed and cleared only when Claude Code confirms the target
prompt through `UserPromptSubmit`.

For Gate Reviewer, the Gate controller consumes the approval and applies the
derived transition only when the matching request returns `started`, `running`,
`disabled`, `not_required`, or `already_approved`. `failed_to_start` does not
apply the transition; the approval and source workflow state remain recoverable.

If terminal submission fails before confirmation, VCM records the failed
attempt and makes the approval recoverable for the same unchanged route, or
returns it to pending. It must not advance workflow state as though the target
role started successfully.

The confirmed dispatch atomically records the complete approved workflow
transition, including Branch return or replacement when present, and clears the
pending approval.

## 8. Rejected Route Handling

An unapproved route must not silently leave the task stalled after PM ends its
turn.

VCM records:

- current workflow state and revision
- attempted source and target roles
- whether approval was missing, denied, stale, consumed, or mismatched
- the last workflow-review result when present
- rejection time

VCM then sends a workflow-rejection callback to PM. The callback states why the
message was rejected and instructs PM to run `vcm-workflow-review` again.

The same unchanged route content must not generate repeated callbacks on every
Hook scan. VCM records the rejected route fingerprint and retries only after PM
changes the route or obtains a new approval.

## 9. User-Authorized Override

An override permits one specific transition that normal workflow review denied.
It does not disable workflow enforcement.

PM retries workflow review with:

- the requested flow when starting or switching a flow
- the target role
- the exact user authorization text

VCM must resolve a VCM-owned source user-message record and verify that the
quoted text matches it. PM text alone is not proof of authorization.

The override record binds:

- task slug
- current workflow revision
- rejected source state
- requested flow when supplied
- exact target role
- exact derived destination state
- user authorization text and source
- the normal rule being bypassed
- approval and consumption times

The resulting pending dispatch approval uses the same route enforcement as a
normal approval. The route message still contains no approval metadata.

An override is one-time and cannot be reused after any workflow state change,
for another role, another flow request, another task, or a broader exception.

Workflow override authority bypasses only the fixed workflow transition rule.
It does not bypass filesystem permissions, role boundaries, PM-hub routing,
task ownership, or other runtime safety controls.

## 10. Authoritative Workflow State

The workflow reviewer cannot rely on the current arbitrary PM declaration.
Otherwise PM could first rewrite the declared state and then request an approval
that appears legal.

Implementation must separate or replace the existing advisory declaration:

- authoritative workflow state is changed only by confirmed approved
  transitions
- PM cannot directly set authoritative flow, step, branch, resume point, or
  revision
- Session, Turn, Round, Gate Review, artifact, and process states remain
  independent and cannot originate an authoritative workflow transition
- runtime events may confirm execution of an already approved dispatch but do
  not select or apply PM's next workflow transition
- frontend code only displays state and user-authorization controls

The existing `update-task-state` endpoint and tool must not be able to mutate
the authoritative workflow state after this change.

The authoritative state uses this fixed model:

```text
revision
flow
step
branch
```

`flow` is one of `code-change`, `architect-debug`,
`architecture-diagnosis`, `docs-only`, or `validation-only`.

Only Code-Change Flow may contain a branch. `branch` is either absent or has
this backend-owned shape:

```text
type: architect-debug | architecture-diagnosis
step
entered from step
resume step
```

The Code-Change `step` remains at its suspended checkpoint while a branch is
active. Architect Debug Branch may be replaced by Architecture Diagnosis
Branch, but branches never contain another branch. Other flows move to
Architect Debug or Architecture Diagnosis through a top-level flow switch and
do not retain an automatic return point.

Authoritative Workflow State records only what is needed to validate the next
PM-to-role dispatch. It does not represent user waiting, PM activity, Final
Acceptance completion, task completion, or PR preparation. Round, Session, and
the existing task runtime continue to own those states.

Each flow has a fixed step set. The Code-Change steps are:

```text
architect-interview
architect-planning
architecture-plan-gate
coder-implementation
code-diff-gate
tester-validation
validation-adequacy-gate
architect-docs-sync
final-acceptance
```

The Architect Debug execution steps are `architect-debug`,
`debug-code-diff-gate`, and `debug-tester-validation`. The Architecture
Diagnosis execution steps are `architect-diagnosis`,
`diagnosis-code-diff-gate`, and `diagnosis-tester-validation`. The remaining
flows receive the same fixed-step treatment from their existing PM flow rules.

## 11. Workflow And Branch Inventory

This inventory is the complete source list for the machine workflow policy.
Every main-path transition and allowed branch listed here must be represented in
the backend policy. Anything not listed is denied unless VCM records an exact
one-time user-authorized override.

### 11.1 Code-Change Flow

The main path is:

```text
architect-interview
-> architect-planning
-> architecture-plan-gate
-> coder-implementation
-> code-diff-gate
-> tester-validation
-> validation-adequacy-gate
-> architect-docs-sync
-> final-acceptance
```

The allowed branches are:

- an `interviewing` architecture brief remains at Architect Interview
- a confirmed architecture brief advances to Architect Planning
- incomplete planning returns to Architect Planning
- planning that requires user clarification returns to Architect Interview
- Architecture Plan Gate `request_changes` returns to Architect Planning and
  repeats the Gate after revision
- incomplete Coder work returns to Coder
- completed Coder work with compile, typecheck, or L0/L1 failure evidence enters
  Architect Debug Branch
- Coder `ready_for_review` advances to Code Diff Gate
- Code Diff Gate `request_changes` enters Architect Debug Branch
- Tester `fail` for the Coder implementation enters Architect Debug Branch
- Tester `pass` advances to Validation Adequacy Gate
- Validation Adequacy Gate `request_changes` returns to Tester and repeats the
  Gate after correction
- Architect Docs Sync `synced` or `unchanged` advances to Final Acceptance
- blocked docs sync remains at docs sync unless its evidence permits Architect
  Debug Branch, Architecture Diagnosis Branch, or a user decision
- Final Acceptance `needs-coder-follow-up` returns to Coder
- Final Acceptance `needs-architect-follow-up` returns to Architect
- Final Acceptance `needs-docs-sync` returns to Architect Docs Sync
- Final Acceptance `blocked-by-user-decision` makes PM wait for the user without
  changing Workflow Review state
- follow-up work resumes from the earliest affected Code-Change step and repeats
  every downstream Gate
- Final Acceptance `accepted` completes the task through the existing task
  lifecycle without a Workflow Review request
- Final Acceptance `accepted-with-known-risks` uses the existing user-approval
  and task-completion path without a Workflow Review request

### 11.2 Architect Debug Flow And Branch

The shared execution path is:

```text
architect-debug -> debug-code-diff-gate -> debug-tester-validation
```

Architect Debug is a standalone Flow when fixing an existing defect is the
accepted task or another non-Code-Change flow switches to Debug. It is a Branch
only when Code-Change Flow is suspended because Coder failed after
implementation, Code Diff Gate requested changes, or Tester failed the Coder
implementation.

The allowed branches are:

- `local fix completed` advances to Debug Code Diff Gate
- `normal architecture plan required` enters Code-Change Flow at Architect
  Planning; when Debug is already a Code-Change Branch, its parent resumes at
  Architect Planning
- `user clarification required` makes PM wait for the user; the next role
  dispatch is reviewed from the unchanged Debug state
- Debug Code Diff Gate `request_changes` returns to Architect Debug
- Debug Tester `fail` in a standalone Flow switches to standalone Architecture
  Diagnosis Flow
- Debug Tester `fail` in a Code-Change Branch replaces Architect Debug Branch
  with Architecture Diagnosis Branch while preserving the original
  Code-Change entry and resume steps
- Debug Tester `pass` in a standalone Flow advances to Validation Adequacy Gate,
  Architect Docs Sync, and Final Acceptance
- Debug Tester `pass` in a Branch returns to its recorded Code-Change resume
  step without branch-level docs sync or Final Acceptance

### 11.3 Architecture Diagnosis Flow And Branch

Architecture Diagnosis is a standalone Flow when diagnosis itself is the
accepted task or another non-Code-Change flow switches to Diagnosis. It is a
Branch only inside Code-Change Flow, either when Architect Debug Branch is
replaced after its completed fix still fails Tester validation, or Architect
must update or replace the architecture plan for the second time.

The allowed paths and branches are:

- `analysis completed` in a standalone Flow completes from the diagnosis result
- `analysis completed` in a Branch returns to its recorded Code-Change resume
  step
- `diagnosis implementation completed` advances to Diagnosis Code Diff Gate
- `user clarification required` makes PM wait for the user; the next role
  dispatch is reviewed from the unchanged Diagnosis state
- Diagnosis Code Diff Gate `request_changes` returns to Architecture Diagnosis
- Diagnosis Tester `fail` pauses the workflow and reports to the user
- Diagnosis Tester `pass` in a standalone code-producing Flow advances to
  Validation Adequacy Gate, Architect Docs Sync, and Final Acceptance
- Diagnosis Tester `pass` in a code-producing Branch returns to its recorded
  Code-Change resume step without branch-level docs sync or Final Acceptance

### 11.4 Docs-Only Flow

The main path is:

```text
architect-documentation-update
```

The allowed branches are:

- incomplete document work or evidence returns to Architect
- required production-code or runtime-behavior work switches to Code-Change
  Flow at Architect Planning
- `docs/TESTING.md` or validation-strategy work switches to Validation-Only Flow
- conflicting durable requirements make PM wait for a user decision without
  changing Workflow Review state
- Architect `synced` or `unchanged` completes through the existing task
  lifecycle without another Workflow Review request

Docs-Only Flow does not run Gate Review, Tester validation, separate docs sync,
or Final Acceptance.

### 11.5 Validation-Only Flow

The main path is:

```text
tester-validation -> validation-adequacy-gate
```

The allowed branches are:

- incomplete validation work or test-report evidence returns to Tester
- Validation Adequacy Gate `request_changes` returns to Tester and repeats the
  Gate after correction
- required production-code, runtime-behavior, public-contract, dependency, or
  system-architecture work switches to Code-Change Flow at Architect Planning
- missing user intent or external authorization makes PM wait for the user
  without changing Workflow Review state
- a complete Tester `pass` or `fail` result completes through the existing task
  lifecycle after the Validation Adequacy Gate permits continuation

Validation-Only Flow does not run Architecture Plan Gate, Code Diff Gate,
Architect Docs Sync, or Final Acceptance.

### 11.6 PM-Only Activity Outside Workflow Review

Communication-only work, waiting for the user, PM final responses, Final
Acceptance completion, task completion, and PR preparation do not dispatch work
to another role and are outside Workflow Review. They do not call
`request-workflow-review`, create a pending dispatch approval, or change
authoritative Workflow Review state.

If PM later dispatches another role, that dispatch is reviewed against the
current authoritative state. Starting or switching to a supported delivery flow
uses `--flow` together with the actual target role.

### 11.8 Global Branch Rules

- incomplete or non-standard role output returns to the same responsible role
- user intent, external authorization, or an exact required exception makes PM
  wait without changing authoritative Workflow Review state
- Gate Review `started` or `running` remains at the Gate until the VCM callback
- Gate Review `disabled`, `not_required`, `already_approved`, or `approve`
  advances according to the active flow
- Gate Review `request_changes` uses only the branch defined for that Gate in
  the active flow
- Gate Review `failed_to_start` or `failed` stops advancement for VCM retry,
  user skip, or user override handling
- a recorded user skip or override applies only to its exact checkpoint
- a direct role-to-PM report does not advance workflow state
- Translator and Harness Engineer are auxiliary roles and never become Round or
  core workflow nodes

Architect Debug Branch and Architecture Diagnosis Branch exist only inside
Code-Change Flow. At most one is active. Ordinary same-role continuation, Gate
waiting, user waiting, and top-level flow switching are state transitions, not
nested branch flows.

### 11.9 Branch Entry, Replacement, And Exit

VCM, not PM, derives the Branch entry and resume steps from the transition
policy. The required Code-Change mappings are:

| Branch reason | Entered from step | Resume step | Required next target role |
| --- | --- | --- | --- |
| Coder compile, typecheck, or L0/L1 failure | `coder-implementation` | `validation-adequacy-gate` | `gate-reviewer` |
| Code Diff Gate `request_changes` | `code-diff-gate` | `validation-adequacy-gate` | `gate-reviewer` |
| Tester `fail` | `tester-validation` | `validation-adequacy-gate` | `gate-reviewer` |
| implementation defect found during docs sync | `architect-docs-sync` | `validation-adequacy-gate` | `gate-reviewer` |
| second architecture-plan update or replacement | `architect-planning` or `architecture-plan-gate` | `architect-planning` | `architect` |

Entering a Branch keeps the Code-Change step at `entered from step` and creates
the Branch with the policy-selected `resume step`.

When PM requests Diagnosis and the approved Architect dispatch succeeds, VCM
atomically replaces Debug Branch `type` and `step` with Architecture Diagnosis
while preserving `entered from step` and `resume step`. Debug is no longer
active and Diagnosis completion never returns to Debug.

A Debug Branch is eligible for successful exit after PM receives Code Diff Gate
continuation and Tester `pass`. A code-producing Diagnosis Branch has the same
exit point. An analysis-only Diagnosis Branch may return only from the second
architecture-plan update or replacement path after Architect reports analysis
completion.

`normal architecture plan required` is not a successful Debug return. VCM
derives Architect Planning as the return step for the combined Branch-exit and
Architect-dispatch approval instead of using the stored success resume step.

After receiving the qualifying role result, PM requests Branch return and the
next role in one review. For a completed code-producing Branch:

```text
.ai/tools/request-workflow-review --flow code-change \
  --target-role gate-reviewer
```

For an analysis-only Diagnosis return or `normal architecture plan required`:

```text
.ai/tools/request-workflow-review --flow code-change \
  --target-role architect
```

VCM recognizes `--flow code-change` as return to the already recorded parent,
not creation of another Code-Change Flow. It checks that the current Branch
step has an allowed return edge and that `--target-role` matches the role owned
by the policy-derived return step. Successful return uses the stored resume
step; the explicit `normal architecture plan required` path uses Architect
Planning. VCM does not read the role report or infer the result independently.

An allowed request creates one pending composite transition containing Branch
exit, the restored Code-Change step, and the target role. The Branch remains
active until the matching dispatch succeeds. Dispatch confirmation applies one
atomic transaction:

1. verify the current Branch, workflow revision, approved return step, and
   approved target role
2. clear `branch`
3. set the Code-Change `step` to the approved return step
4. increment the workflow revision
5. consume the pending approval

PM is the only source of the Branch-exit request. Hooks, Gate controllers, role
reports, and handoff artifacts do not choose Branch exit automatically. A
request from a non-exit-capable Branch step or to a role that does not own the
resume step is denied. A failed target dispatch leaves the Branch and source
Code-Change state unchanged and makes the approval recoverable. Until the
matching dispatch succeeds, all other Code-Change parent-flow dispatches are
denied.

If Diagnosis Tester fails, PM does not request Branch exit; the Diagnosis Branch
and resume step remain active while PM requests the permitted user-waiting
checkpoint. A user-authorized flow switch may leave the Branch only for the
exact recorded exception.

## 12. Workflow Policy

The backend needs a typed, explicit transition policy for every supported fixed
flow and allowed branch. Natural-language PM rules are not an enforcement
mechanism.

Each transition definition must identify:

- source flow and step
- optional active branch and resume point
- optional requested flow
- permitted target role, if the transition dispatches a role
- destination flow and step
- branch entry, branch exit, or resume behavior

Any transition absent from this policy is illegal.

VCM never asks PM to name or choose a separate operation label. Its decision is:

```text
current authoritative state
+ optional requested flow
+ target role
-> allow or deny, plus the unique destination state
```

PM selects one of the legal outgoing transitions after interpreting the role,
Gate, or user result. VCM validates the requested transition against the closed
policy; it does not independently interpret those results to choose for PM.

If those inputs permit multiple incompatible destination states, the machine
policy is ambiguous and must be corrected. PM must not resolve such ambiguity
by supplying an extra label.

The machine policy and installed PM Harness rules must remain synchronized by
tests. The machine policy is authoritative for dispatch permission; the PM rules
explain the same policy to the model.

## 13. Dispatch-Only Boundary

Workflow Review has no checkpoint operation without a target role. PM calls it
only before dispatching work to another role. There is no synthetic
`--target-role project-manager` and no separate request for user waiting, PM
analysis, Final Acceptance completion, task completion, or PR preparation.

Gate callbacks, Hooks, role reports, handoff artifacts, and user messages may
inform PM, but they do not create an approval or select the next dispatch. When
PM next dispatches a role, it submits the real target role and optional flow to
Workflow Review.

## 14. Persistence And Recovery

Workflow state, pending approval, dispatching approval, rejection fingerprint,
and override evidence are task-scoped backend state in the active worktree.

On VCM restart or task re-entry:

- authoritative workflow state is restored
- an unused approval is restored only when its workflow revision still matches
- a dispatching approval is reconciled against message snapshots,
  `UserPromptSubmit`, route content, and target Session state
- stale approvals are invalidated with a recorded reason
- malformed state must produce an explicit recovery error rather than silently
  granting a transition

Task close clears runtime workflow state after any required workflow evidence
has been surfaced to the user.

## 15. Required Tests

Backend unit and end-to-end coverage must include:

- every main-path transition in Section 11 has a positive policy and backend
  integration test
- every allowed branch in Section 11 has a positive policy and end-to-end test
- every supported role-dispatch flow in Section 11 has an end-to-end scenario
  through its final reviewed dispatch
- every flow has negative tests proving unlisted role targets, flow switches,
  branch entries, branch exits, and skipped checkpoints are denied
- standalone and branch forms of Architect Debug and Architecture Diagnosis are
  tested separately, including Code-Change resume behavior
- entering a Branch preserves the suspended Code-Change step and stores the
  policy-derived resume step
- Debug Branch replacement by Diagnosis preserves the original entry and resume
  steps without creating another Branch layer
- successful Branch return and the next role are approved as one composite
  transition
- the Branch remains active after approval until the matching role or Gate
  dispatch succeeds
- successful dispatch atomically clears the Branch, restores the approved
  Code-Change return step, increments revision, and consumes the approval
- wrong target role, non-exit-capable Branch step, and failed target dispatch do
  not clear the Branch
- Hooks, Gate callbacks, role reports, and handoff changes cannot exit a Branch
  without a PM-approved composite transition
- a non-Code-Change flow moves to Debug or Diagnosis by top-level flow switch,
  never by Branch creation
- starting without an active flow requires `--flow`
- starting a flow with a legal target derives the initial destination state
- omitting `--flow` continues the current flow
- repeating the current `--flow` without an active Branch is an idempotent
  continuation request
- `--flow code-change --target-role <role>` from an exit-capable Code-Change
  Branch approves Branch return and the matching next role together
- requesting another flow is validated as a top-level switch, Branch entry, or
  Debug-to-Diagnosis Branch replacement
- Architect Debug and Architecture Diagnosis resolve to a standalone flow or
  branch from authoritative state
- ambiguous destination states are denied instead of delegated to PM
- allowed flow-and-target review creates one pending target-role approval
- denied flow-and-target review creates no approval and returns allowed
  alternatives
- PM route without approval is rejected
- PM route to the approved role is dispatched
- PM route to another role is rejected
- one approval cannot dispatch two messages
- a new review invalidates the prior unused approval
- workflow revision change invalidates approval
- non-PM report to PM remains deliverable without approval
- user waiting, PM final responses, Final Acceptance completion, task
  completion, and PR preparation never require Workflow Review
- Workflow Review cannot create a PM-target or targetless approval
- state changes only after target `UserPromptSubmit`
- failed terminal submission does not advance state
- restart reconciles pending and dispatching approvals
- unchanged rejected routes do not generate repeated callbacks
- exact user override is accepted and recorded
- missing, mismatched, stale, or reused user authorization is rejected
- user override cannot bypass non-workflow safety controls

## 16. Open Decisions Before Implementation

The authoritative state model, workflow-review command-line interface, and
deny-by-default transition-policy shape are decided above. Resolve the following
items in order before coding. Discuss one item at a time: state the problem,
present a recommendation, and record the user's decision before changing the
design.

The targetless-checkpoint question is resolved: Workflow Review reviews only
PM-to-role dispatches. PM-only activity is outside its state and approval
mechanism.

1. **Ambiguous transitions with the same Flow and target role.** Architect
   Planning continuation versus return to Architect Interview both target
   Architect in Code-Change. Final Acceptance architect follow-up and docs-sync
   follow-up also both target Architect. Redesign these edges so current state,
   optional requested Flow, and target role always derive one destination.
2. **Complete fixed step sets.** Define every step for standalone Architect
   Debug, standalone Architecture Diagnosis, Docs-Only, and Validation-Only.
   The current document fully enumerates only Code-Change and the execution
   portions of Debug and Diagnosis.
3. **Complete typed transition table.** Convert every reviewed role-dispatch
   edge, allowed branch, retry, and return into a machine rule containing source
   state, active Branch, requested Flow, target role, destination state, and
   transition behavior. Every valid input must have one destination; every
   absent edge is denied.
4. **Non-Code-Change switches to Debug or Diagnosis.** Enumerate which flows and
   steps may switch to standalone Architect Debug or Architecture Diagnosis,
   the required target role, and whether the replaced flow is simply closed or
   retained only as audit history.
5. **Final Acceptance follow-up mapping.** Replace "earliest affected step" with
   fixed destinations and required downstream Gates for
   `needs-coder-follow-up`, `needs-architect-follow-up`, and
   `needs-docs-sync`.
6. **Approval-to-dispatch correlation.** Target-role equality alone cannot
   distinguish the newly approved message from an older pending route to the
   same role. Define how VCM recognizes the first eligible dispatch created
   after approval without adding approval metadata to route files.
7. **Gate Reviewer approval consumption.** Define exact matching for gate type
   and code source, existing running Gate behavior, consumption for
   `started`/`running`/`disabled`/`not_required`/`already_approved`, recovery for
   `failed_to_start`, and tests that distinguish Gate consumption from normal
   `UserPromptSubmit` confirmation.
8. **Restart reconciliation.** Define how a restored `dispatching` approval is
   classified as unsent, submitted, started, completed, or failed so VCM neither
   duplicates a dispatch nor advances a transition that never started.
9. **Workflow lifecycle boundaries.** Define the no-Flow initial state,
    top-level Flow replacement history, and guaranteed task close that cannot be
    blocked by malformed or unfinished workflow runtime state. User waiting,
    Final Acceptance completion, and PR preparation are outside Workflow Review.
10. **User-authorization source capture.** Define how VCM captures and identifies
   exact direct user messages from Embedded Terminal, Gateway, and other input
   paths so PM cannot fabricate, broaden, or reuse override authorization.
11. **Override evidence retention.** Decide whether override evidence survives
   task close or remains task-runtime evidence only, while preserving audit and
   one-time-use guarantees for the lifetime selected.
12. **Machine-policy and Harness synchronization.** Decide whether one source
   generates both the backend transition policy and PM Harness description, or
   independent definitions are compared by synchronization tests. Manual drift
   must fail validation before release.
