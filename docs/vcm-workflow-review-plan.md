# VCM Workflow Review Plan

Last updated: 2026-07-19

Status: design draft. Resolve the open decisions in this document before
implementation.

## 1. Goal

VCM must enforce the fixed task flows and their explicitly allowed branches.
Project Manager proposes the next target role and, only when starting or
switching a flow, the selected flow. VCM decides whether that request is legal
in the current workflow state.

The governing rule is deny by default:

- a transition explicitly allowed from the current state may proceed
- a transition not explicitly allowed from the current state is rejected
- PM does not gain authority to invent, skip, reorder, or reinterpret workflow
  branches
- only an exact user-authorized override may bypass a rejected transition

VCM validates workflow legality. It does not perform technical analysis or
choose the next target for PM.

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

`--target-role` is required for every PM-to-role dispatch. `--flow` is supplied
only when starting a flow or switching to another flow:

- no active flow plus `--flow` starts that flow
- omitted `--flow` continues the current flow
- the current flow supplied again is an idempotent continuation request
- a different flow requests a flow switch or branch entry

The supported flow values are `code-change`, `architect-debug`,
`architecture-diagnosis`, `docs-only`, `validation-only`,
`communication-only`, and `pr-preparation`.

The request does not contain a destination step, branch, resume point, workflow
revision, evidence references, approval identifier, or separate operation
label. VCM derives the legal destination from authoritative workflow state,
observed artifacts, Gate Review state, the optional requested flow, and the
target role. Architect Debug and Architecture Diagnosis are interpreted as
standalone flows or branches from the current authoritative state.

When requesting an override after a denial, PM also supplies the exact user
authorization text. VCM resolves and verifies its backend-owned source record.

The tool returns one of two normal results:

```text
allowed
denied
```

For `allowed`, VCM stores the approved target role and derived destination
state. PM then writes the normal route message and ends the turn.

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
evaluated backend guard facts
created time
user-authorization evidence when applicable
dispatch status
```

The record is internal VCM state. Route messages do not carry these fields.

A new workflow-review request replaces any unused pending approval for the same
task. A workflow state revision change invalidates an unused approval.

An approval is valid for one PM dispatch only. It cannot authorize multiple
messages to the same role.

## 6. Route Message Enforcement

`vcm-route-message` remains the only PM-hub role-message channel. The skill tells
PM that a successful workflow review is required before writing a PM route.

The backend remains the enforcement boundary. When it finds a pending
PM-to-role route file, it loads the task's pending dispatch approval and compares
only backend-owned facts with the route:

- the route is from Project Manager
- the route target role equals the approved target role
- the approval still belongs to the current workflow revision
- the approval has not already been consumed or invalidated

When these conditions match, VCM permits the normal message dispatch. No
workflow approval fields are required in route-file frontmatter.

When no pending approval exists, the approval was denied, the target role does
not match, or the approval is stale, VCM must not send the message.

Non-PM reports to PM do not require workflow approval. They provide evidence
for PM's next workflow-review request and cannot directly advance workflow
state.

## 7. Approval Consumption

VCM must prevent both duplicate dispatch and false state advancement.

When a matching route is selected for delivery, the pending approval moves to
an internal dispatching state so another Hook cannot reuse it. The approval is
consumed and cleared only when Claude Code confirms the target prompt through
`UserPromptSubmit`.

If terminal submission fails before confirmation, VCM records the failed
attempt and makes the approval recoverable for the same unchanged route, or
returns it to pending. It must not advance workflow state as though the target
role started successfully.

The confirmed dispatch atomically records the approved workflow transition and
clears the pending approval.

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
  independent sources of observed facts
- workflow policy may use those facts as transition guards without merging
  their state machines
- frontend code only displays state and user-authorization controls

The existing `update-task-state` endpoint and tool must not be able to mutate
the authoritative workflow state after this change.

The authoritative state uses this fixed model:

```text
revision
flow
step
branch
parent flow
resume step
status
```

`flow` is one of `code-change`, `architect-debug`,
`architecture-diagnosis`, `docs-only`, `validation-only`,
`communication-only`, or `pr-preparation`. Architect Debug and Architecture
Diagnosis may also be the active branch of another flow. A branch records its
parent flow and exact resume step.

`status` is limited to `active`, `awaiting-user`, or `completed`. Role process
and activity states do not belong here; Round and Session continue to own them.

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
completed
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
-> completed
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
- Final Acceptance `blocked-by-user-decision` waits for the user
- follow-up work resumes from the earliest affected Code-Change step and repeats
  every downstream Gate
- Final Acceptance `accepted` completes the flow
- Final Acceptance `accepted-with-known-risks` completes only with the exact
  required user approval already recorded

### 11.2 Architect Debug Flow And Branch

The shared execution path is:

```text
architect-debug -> debug-code-diff-gate -> debug-tester-validation
```

Architect Debug is a standalone Flow when fixing an existing defect is the
accepted task. It is a Branch when another flow is suspended because Coder
failed after implementation, Code Diff Gate requested changes, or Tester failed
the Coder implementation.

The allowed branches are:

- `local fix completed` advances to Debug Code Diff Gate
- `normal architecture plan required` enters Code-Change Flow at Architect
  Planning; when Debug is already a Code-Change Branch, its parent resumes at
  Architect Planning
- `user clarification required` waits for the user and then resumes Debug
- Debug Code Diff Gate `request_changes` returns to Architect Debug
- Debug Tester `fail` enters Architecture Diagnosis Branch
- Debug Tester `pass` in a standalone Flow advances to Validation Adequacy Gate,
  Architect Docs Sync, and Final Acceptance
- Debug Tester `pass` in a Branch returns to its recorded parent-flow resume
  step without branch-level docs sync or Final Acceptance

### 11.3 Architecture Diagnosis Flow And Branch

Architecture Diagnosis is a standalone Flow when diagnosis itself is the
accepted task. It is a Branch when another flow is suspended after a completed
Debug fix still fails Tester validation, or Architect must update or replace the
architecture plan for the second time.

The allowed paths and branches are:

- `analysis completed` in a standalone Flow completes from the diagnosis result
- `analysis completed` in a Branch returns to its recorded parent-flow resume
  step
- `diagnosis implementation completed` advances to Diagnosis Code Diff Gate
- `user clarification required` waits for the user and then resumes Diagnosis
- Diagnosis Code Diff Gate `request_changes` returns to Architecture Diagnosis
- Diagnosis Tester `fail` pauses the workflow and reports to the user
- Diagnosis Tester `pass` in a standalone code-producing Flow advances to
  Validation Adequacy Gate, Architect Docs Sync, and Final Acceptance
- Diagnosis Tester `pass` in a code-producing Branch returns to its recorded
  parent-flow resume step without branch-level docs sync or Final Acceptance

### 11.4 Docs-Only Flow

The main path is:

```text
architect-documentation-update -> completed
```

The allowed branches are:

- incomplete document work or evidence returns to Architect
- required production-code or runtime-behavior work switches to Code-Change
  Flow at Architect Planning
- `docs/TESTING.md` or validation-strategy work switches to Validation-Only Flow
- conflicting durable requirements wait for a user decision
- Architect `synced` or `unchanged` completes the flow

Docs-Only Flow does not run Gate Review, Tester validation, separate docs sync,
or Final Acceptance.

### 11.5 Validation-Only Flow

The main path is:

```text
tester-validation -> validation-adequacy-gate -> completed
```

The allowed branches are:

- incomplete validation work or test-report evidence returns to Tester
- Validation Adequacy Gate `request_changes` returns to Tester and repeats the
  Gate after correction
- required production-code, runtime-behavior, public-contract, dependency, or
  system-architecture work switches to Code-Change Flow at Architect Planning
- missing user intent or external authorization waits for the user
- a complete Tester `pass` or `fail` result completes after the Validation
  Adequacy Gate permits continuation

Validation-Only Flow does not run Architecture Plan Gate, Code Diff Gate,
Architect Docs Sync, or Final Acceptance.

### 11.6 Communication-Only Flow

PM answers the user or relays a clarification, then completes the flow. If the
user confirms a delivery request, PM starts the matching delivery flow.
Communication-Only Flow does not run Gate Review, validation, docs sync, Final
Acceptance, or PR Preparation.

### 11.7 PR-Preparation Flow

PR Preparation starts only after the active delivery flow completes. PM prepares
or updates the PR from existing commits and evidence, then completes the flow.
Incomplete required work or evidence returns to the responsible flow before PR
preparation continues. This flow does not perform technical review, validation,
docs sync, Gate Review, or Final Acceptance.

### 11.8 Global Branch Rules

- incomplete or non-standard role output returns to the same responsible role
- user intent, external authorization, or an exact required exception changes
  status to `awaiting-user`; the recorded suspended step resumes after the user
  decides
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

Architect Debug Branch and Architecture Diagnosis Branch are the only branch
flows that suspend a parent flow and require a recorded resume step. Ordinary
same-role continuation, Gate waiting, and user waiting are state transitions,
not nested branch flows.

## 12. Workflow Policy

The backend needs a typed, explicit transition policy for every supported fixed
flow and allowed branch. Natural-language PM rules are not an enforcement
mechanism.

Each transition definition must identify:

- source flow and step
- optional active branch and resume point
- optional requested flow
- permitted target role, if the transition dispatches a role
- required artifact, Gate Review, or runtime guards
- destination flow and step
- branch entry, branch exit, or resume behavior

Any transition absent from this policy is illegal.

VCM never asks PM to name or choose a separate operation label. Its decision is:

```text
current authoritative state
+ observed facts
+ optional requested flow
+ target role
-> allow or deny, plus the unique destination state
```

If those inputs permit multiple incompatible destination states, the machine
policy is ambiguous and must be corrected. PM must not resolve such ambiguity
by supplying an extra label.

The machine policy and installed PM Harness rules must remain synchronized by
tests. The machine policy is authoritative for dispatch permission; the PM rules
explain the same policy to the model.

## 13. Checkpoints Without A Role Route

Not every workflow checkpoint sends a PM route message. Waiting for the user,
starting Gate Review, receiving a Gate callback, Final Acceptance, task
completion, and PR preparation may also change workflow state.

The same workflow-review service must eventually validate those changes at
their backend controller. Route-message enforcement covers PM role dispatch but
cannot by itself prevent every illegal workflow advance.

Before implementation, the policy must enumerate which no-route checkpoints:

- require PM to call the workflow-review tool first
- are backend events applied automatically after an already approved
  transition
- are direct user decisions
- are observations that do not change workflow state

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
- every top-level flow in Section 11 has an end-to-end scenario through its
  valid completion
- every flow has negative tests proving unlisted role targets, flow switches,
  branch entries, branch exits, and skipped checkpoints are denied
- standalone and branch forms of Architect Debug and Architecture Diagnosis are
  tested separately, including parent-flow resume behavior
- starting without an active flow requires `--flow`
- starting a flow with a legal target derives the initial destination state
- omitting `--flow` continues the current flow
- repeating the current `--flow` is an idempotent continuation request
- requesting another flow is validated as a flow switch or branch entry
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
- state changes only after target `UserPromptSubmit`
- failed terminal submission does not advance state
- restart reconciles pending and dispatching approvals
- unchanged rejected routes do not generate repeated callbacks
- exact user override is accepted and recorded
- missing, mismatched, stale, or reused user authorization is rejected
- user override cannot bypass non-workflow safety controls

## 16. Open Decisions Before Implementation

The authoritative state model, workflow-review command-line interface, and
deny-by-default transition-policy shape are decided above. The following must
still be resolved before coding:

1. How VCM captures and identifies direct user messages from embedded terminal,
   Gateway, and other supported input paths for override evidence.
2. The exact reconciliation rule for a dispatching approval after process or
   application restart.
3. The list and enforcement point of every no-route workflow checkpoint.
4. Whether workflow override evidence must survive task close or is task-runtime
   evidence only.
5. Whether Architecture Diagnosis entered from an Architect Debug Branch
   replaces Debug while inheriting its original parent and resume step, or is a
   true nested branch that requires a branch stack. The planned single
   `branch`/`parent flow`/`resume step` state cannot represent recursive nesting.
