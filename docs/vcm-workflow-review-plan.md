# VCM Workflow Review Plan

Last updated: 2026-07-19

Status: design draft. Resolve the open decisions in this document before
implementation.

## 1. Goal

VCM must enforce the fixed task flows and their explicitly allowed branches.
Project Manager proposes the next workflow action, but VCM decides whether that
action is legal in the current workflow state.

The governing rule is deny by default:

- a transition explicitly allowed from the current state may proceed
- a transition not explicitly allowed from the current state is rejected
- PM does not gain authority to invent, skip, reorder, or reinterpret workflow
  branches
- only an exact user-authorized override may bypass a rejected transition

VCM validates workflow legality. It does not perform technical analysis or
choose the next action for PM.

## 2. Current Gap

The current task workflow state is advisory PM-declared context. PM can write
arbitrary flow, step, branch, resume-point, and status values. Message delivery
checks only the PM-hub route topology and records the declaration after dispatch
on a best-effort basis.

This records what PM claimed but does not prevent PM from selecting an illegal
next role or bypassing a required flow branch.

## 3. Enforcement Model

Workflow dispatch uses two backend-enforced stages:

1. PM asks VCM to review the proposed next workflow action.
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

The review request identifies:

- the proposed workflow action or destination step
- the target role
- evidence references required by that action
- user-authorization evidence only when requesting an override

The proposed workflow action is required because the same target role can serve
different steps. An Architect dispatch may mean interview, planning, revision,
Debug, Architecture Diagnosis, or docs sync. This information belongs to the
workflow-review request and backend state, not to the later route message.

The tool returns one of two normal results:

```text
allowed
denied
```

For `allowed`, VCM stores the approved next dispatch. PM then writes the normal
route message and ends the turn.

For `denied`, VCM stores no dispatch approval. The tool returns the current
workflow state, the rejected action, the exact rejection reason, and the actions
allowed from the current state. PM remains in the current turn, checks the flow
again, and proposes another action.

## 5. Pending Dispatch Approval

Each task has at most one pending PM dispatch approval.

The backend record contains at least:

```text
task slug
workflow revision
source workflow state
approved action
approved target role
normal or user-override decision
evidence references
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

PM submits the same workflow-review request with:

- the rejected proposed action
- the target role
- the exact user authorization text
- a VCM-owned reference to the source user message

VCM must verify that the quoted text matches the recorded source message. PM
text alone is not proof of authorization.

The override record binds:

- task slug
- current workflow revision
- rejected source state
- exact approved action
- exact target role
- user authorization text and source
- the normal rule being bypassed
- approval and consumption times

The resulting pending dispatch approval uses the same route enforcement as a
normal approval. The route message still contains no approval metadata.

An override is one-time and cannot be reused after any workflow state change,
for another role, another action, another task, or a broader exception.

Workflow override authority bypasses only the fixed workflow transition rule.
It does not bypass filesystem permissions, role boundaries, PM-hub routing,
task ownership, or other runtime safety controls.

## 10. Authoritative Workflow State

The workflow reviewer cannot rely on the current arbitrary PM declaration.
Otherwise PM could first rewrite the declared state and then request an approval
that appears legal.

Implementation must separate or replace the existing advisory declaration:

- authoritative workflow state is changed only by confirmed approved actions
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

## 11. Workflow Policy

The backend needs a typed, explicit transition policy for every supported fixed
flow and allowed branch. Natural-language PM rules are not an enforcement
mechanism.

Each transition definition must identify:

- source flow and step
- optional active branch and resume point
- proposed action
- permitted target role, if the action dispatches a role
- required artifact, Gate Review, or runtime guards
- destination flow and step
- branch entry, branch exit, or resume behavior

Any transition absent from this policy is illegal.

The workflow-review request identifies an action as well as its target role.
The action distinguishes different legal uses of the same role, while the
pending dispatch approval exposes only the resulting target role to route
enforcement.

The machine policy and installed PM Harness rules must remain synchronized by
tests. The machine policy is authoritative for dispatch permission; the PM rules
explain the same policy to the model.

## 12. Operations Without A Role Route

Not every workflow action sends a PM route message. Waiting for the user,
starting Gate Review, receiving a Gate callback, Final Acceptance, task
completion, and PR preparation also change workflow checkpoints.

The same workflow-review service must eventually validate those actions at
their backend controller. Route-message enforcement covers PM role dispatch but
cannot by itself prevent every illegal workflow advance.

Before implementation, the policy must enumerate which no-route operations:

- require PM to call the workflow-review tool first
- are backend events applied automatically after an already approved action
- are user actions
- are observations that do not change workflow state

## 13. Persistence And Recovery

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

## 14. Required Tests

Backend unit and end-to-end coverage must include:

- allowed review creates one pending target-role approval
- denied review creates no approval and returns allowed alternatives
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

## 15. Open Decisions Before Implementation

The authoritative state model and deny-by-default transition-policy shape are
decided above. The following must still be resolved before coding:

1. The exact workflow-review request fields and command-line interface.
2. How VCM captures and identifies direct user messages from embedded terminal,
   Gateway, and other supported input paths for override evidence.
3. The exact reconciliation rule for a dispatching approval after process or
   application restart.
4. The list and enforcement point of every no-route workflow operation.
5. Whether workflow override evidence must survive task close or is task-runtime
   evidence only.
