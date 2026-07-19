# VCM Workflow Review Plan

Last updated: 2026-07-19

Status: design draft. Resolve the open decisions in this document before
implementation.

## 1. Goal

VCM must enforce the role-dispatch portions of the fixed task flows and their
explicitly allowed branches. Project Manager proposes the next target role and,
only when starting or switching a flow, the selected flow. VCM decides whether
that PM-to-role dispatch is legal after the task's confirmed Flow Record.

The governing rule is deny by default:

- a candidate dispatch allowed after the confirmed Flow Record may proceed
- a candidate dispatch not allowed after that record is rejected
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
transition, Flow Record sequence, or other workflow-review metadata into the
route message.

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
- the current top-level flow supplied again when the Flow Record has no active
  Branch is an
  idempotent continuation request
- `--flow code-change` with a target role while a Code-Change Branch is active
  requests Branch exit, parent-flow restoration, and the next role dispatch in
  one approval
- a different flow requests a top-level switch, Branch entry, or Debug-to-
  Diagnosis Branch replacement as determined by the Flow Record

The supported flow values are `code-change`, `architect-debug`,
`architecture-diagnosis`, `docs-only`, and `validation-only`.

The request does not contain a destination step, branch, resume point, Flow
Record sequence, evidence references, approval identifier, or separate
operation label. VCM validates the candidate dispatch from the authoritative
Flow Record, the optional requested flow, and the target role. PM selects the
requested legal path from the role or Gate result it received; VCM does not
parse that result or use a Hook to choose the transition for PM. Architect Debug
and Architecture Diagnosis are interpreted as standalone flows or Code-Change
branches from the confirmed Flow Record.
From a non-Code-Change flow they are top-level flow switches. From Code-Change,
Debug or Diagnosis enters the single Branch slot; Diagnosis requested while
Debug Branch is active replaces Debug while preserving the prior Code-Change
sequence.

When requesting an override after a denial, PM also supplies the exact user
authorization text. VCM resolves and verifies its backend-owned source record.

The tool returns one of two normal results:

```text
allowed
denied
```

For `allowed`, VCM stores the approved target role, requested flow, and Flow
Record sequence against which the request was approved. PM then invokes the
normal role dispatch path and ends the turn. Branch return is not recorded
separately; it becomes part of the Flow Record only when the approved target
dispatch succeeds.

For `denied`, VCM stores no dispatch approval. The tool returns the confirmed
Flow Record, requested target role and flow, the exact rejection reason, and
the target roles or flow changes legal after that record. PM remains in the
current turn, checks the flow again, and submits another review request.

## 5. Pending Dispatch Approval

Each task has at most one pending PM dispatch approval.

The backend record contains at least:

```text
task slug
base Flow Record sequence and hash
requested flow when supplied
effective flow
approved target role
allowed Gate signatures when target role is Gate Reviewer
normal or user-override decision
created time
user-authorization evidence when applicable
dispatch status
```

The record is internal VCM state. Route messages do not carry these fields.

A new workflow-review request replaces any unused pending approval for the same
task. Appending another confirmed dispatch to the Flow Record invalidates an
unused approval based on an older record.

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
- the approval still matches the current Flow Record sequence and hash
- the approval has not already been consumed or invalidated

When these conditions match, VCM permits the normal message dispatch. No
workflow approval fields are required in route-file frontmatter.

When no pending approval exists, the approval was denied, the target role does
not match, or the approval is stale, VCM must not send the message.

When the approved target is Gate Reviewer, `.ai/tools/request-gate-review` must
find a matching pending approval before the Gate controller may start or reuse
the Gate Reviewer. Its Gate type and code source must match one of the approval's
allowed Gate signatures. A different Gate signature or Flow Record base is
rejected.

Non-PM reports to PM do not require workflow approval. They provide evidence
for PM's next workflow-review request and cannot append to the Flow Record.

## 7. Approval Consumption

VCM must prevent both duplicate dispatch and false state advancement.

When a matching normal route is selected for delivery, the pending approval
moves to an internal dispatching state so another Hook cannot reuse it. The
approval is consumed and cleared only when Claude Code confirms the target
prompt through `UserPromptSubmit`.

For Gate Reviewer, the Gate controller consumes the approval and applies the
confirmed dispatch record only when the matching request returns `started`,
`running`, `disabled`, `not_required`, or `already_approved`. `failed_to_start`
does not append a record; the approval remains recoverable against the same
Flow Record base.

If terminal submission fails before confirmation, VCM records the failed
attempt and makes the approval recoverable for the same unchanged route, or
returns it to pending. It must not append a Flow Record event as though the
target role started successfully.

The confirmed dispatch atomically appends the approved flow-and-target event to
the Flow Record and clears the pending approval. Branch entry, replacement, or
return is derived from that complete record rather than stored as mutable state.

## 8. Rejected Route Handling

An unapproved route must not silently leave the task stalled after PM ends its
turn.

VCM records:

- current Flow Record sequence and hash
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
- base Flow Record sequence and hash
- requested flow when supplied
- exact target role
- user authorization text and source
- the normal rule being bypassed
- approval and consumption times

The resulting pending dispatch approval uses the same route enforcement as a
normal approval. The route message still contains no approval metadata.

An override is one-time and cannot be reused after any Flow Record append,
for another role, another flow request, another task, or a broader exception.

Workflow override authority bypasses only the fixed workflow transition rule.
It does not bypass filesystem permissions, role boundaries, PM-hub routing,
task ownership, or other runtime safety controls.

## 10. Authoritative Flow Record

Workflow Review cannot rely on a PM-declared current state. Its only source of
truth is an append-only task-scoped record of confirmed PM-to-role dispatches.

Each confirmed entry contains at least:

```text
sequence
effective flow
target role
dispatch type
gate type when target role is Gate Reviewer
code source when gate type is code-diff
confirmed time
override evidence reference when applicable
```

`effective flow` is one of `code-change`, `architect-debug`,
`architecture-diagnosis`, `docs-only`, or `validation-only`. `dispatch type`
distinguishes the normal role route from the Gate Review controller. `gate type`
is `architecture-plan`, `code-diff`, or `validation-adequacy`; `code source` is
`coder`, `architect-debug`, or `architect-diagnosis`. Gate identity is part of
the dispatched node, not a reason for the dispatch.

The Flow Record does not persist a current step, cursor, status, Branch object,
entry point, or resume point. It also does not store the role's reason, result,
or PM interpretation. VCM matches the complete confirmed dispatch sequence
against the fixed policy to determine which next flow-and-target combinations
are legal.

Only a confirmed approved dispatch appends an entry. Approval, route-file
creation, terminal submission failure, role output, user waiting, PM activity,
Final Acceptance completion, task completion, and PR preparation do not append
entries.

Branch state is derived from the sequence:

- Code-Change followed by an approved `architect-debug` dispatch enters Debug
  Branch
- `architecture-diagnosis` after that Branch replaces Debug with Diagnosis
- an approved `code-change` return dispatch exits the Branch
- Debug or Diagnosis entered from any other flow is a top-level flow switch

The complete record therefore determines whether a Branch is active and which
Code-Change path may resume. No separately persisted cursor can drift from the
dispatch history.

PM cannot append or rewrite this record. Session, Turn, Round, Gate Review,
artifact, and process states remain independent. Runtime events may only confirm
an already approved dispatch. The existing `update-task-state` endpoint and tool
must not mutate the Flow Record. Frontend code only displays the record and
user-authorization controls.

## 11. Workflow And Branch Inventory

This inventory is the complete source list for the machine workflow policy.
Every main-path transition and allowed branch listed here must be represented in
the backend policy. Anything not listed is denied unless VCM records an exact
one-time user-authorized override.

The sequences below contain only confirmed PM-to-role dispatches. A repeated
role is another confirmed dispatch to that role. Gate entries include the Gate
identity stored in the Flow Record. Role results, Gate decisions, user waiting,
PM work, and completion do not appear as record events.

### 11.1 Code-Change Flow

The main confirmed dispatch sequence is:

```text
code-change / architect
-> code-change / architect
-> code-change / gate-reviewer / architecture-plan
-> code-change / coder
-> code-change / gate-reviewer / code-diff / coder
-> code-change / tester
-> code-change / gate-reviewer / validation-adequacy
-> code-change / architect
```

The first Architect dispatch owns the interview. One or more later Architect
dispatches own planning and planning revision. The final Architect dispatch
owns post-validation docs sync. Final Acceptance and completion append nothing.

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

These branches produce the following record extensions:

- interview, planning, planning revision, Coder continuation, Tester revision,
  and docs-sync correction repeat the same responsible role
- Architecture Plan Gate revision appends Architect and later another
  `architecture-plan` Gate dispatch
- Coder completion appends `code-diff` with source `coder`
- Coder failure, Code Diff Gate correction, Tester failure, or a permitted
  implementation correction during docs sync appends `architect-debug` /
  Architect
- Validation Adequacy revision appends Tester and later another
  `validation-adequacy` Gate dispatch
- a Final Acceptance Coder follow-up appends Coder and repeats every downstream
  Code-Change Gate and role dispatch
- a Final Acceptance Architect or docs-sync follow-up appends Architect; any
  later dispatch must independently match a legal Code-Change continuation,
  Debug entry, or Diagnosis entry

### 11.2 Architect Debug Flow And Branch

The shared confirmed dispatch sequence is:

```text
architect-debug / architect
-> architect-debug / gate-reviewer / code-diff / architect-debug
-> architect-debug / tester
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
  dispatch is reviewed from the unchanged Flow Record
- Debug Code Diff Gate `request_changes` returns to Architect Debug
- Debug Tester `fail` in a standalone Flow switches to standalone Architecture
  Diagnosis Flow
- Debug Tester `fail` in a Code-Change Branch replaces Architect Debug Branch
  with Architecture Diagnosis Branch while preserving the original Code-Change
  sequence
- Debug Tester `pass` in a standalone Flow advances to Validation Adequacy Gate,
  Architect Docs Sync, and Final Acceptance
- Debug Tester `pass` in a Branch returns to the legal Code-Change continuation
  path without branch-level docs sync or Final Acceptance

These branches produce the following record extensions:

- Code Diff Gate revision appends Architect in `architect-debug` and later
  another `code-diff` Gate dispatch with source `architect-debug`
- `normal architecture plan required` appends `code-change` / Architect
- Tester failure appends `architecture-diagnosis` / Architect
- standalone Tester pass appends `validation-adequacy` Gate Review and then
  Architect docs sync, both in `architect-debug`
- Branch Tester pass appends the approved `code-change` return dispatch to Gate
  Reviewer for `validation-adequacy`

### 11.3 Architecture Diagnosis Flow And Branch

Architecture Diagnosis is a standalone Flow when diagnosis itself is the
accepted task or another non-Code-Change flow switches to Diagnosis. It is a
Branch only inside Code-Change Flow, either when Architect Debug Branch is
replaced after its completed fix still fails Tester validation, or Architect
must update or replace the architecture plan for the second time.

The code-producing confirmed dispatch sequence is:

```text
architecture-diagnosis / architect
-> architecture-diagnosis / gate-reviewer / code-diff / architect-diagnosis
-> architecture-diagnosis / tester
```

An analysis-only Diagnosis ends its role-dispatch sequence after Architect.

The allowed paths and branches are:

- `analysis completed` in a standalone Flow completes from the diagnosis result
- `analysis completed` in a Branch returns to the legal Code-Change
  continuation path
- `diagnosis implementation completed` advances to Diagnosis Code Diff Gate
- `user clarification required` makes PM wait for the user; the next role
  dispatch is reviewed from the unchanged Flow Record
- Diagnosis Code Diff Gate `request_changes` returns to Architecture Diagnosis
- Diagnosis Tester `fail` pauses the workflow and reports to the user
- Diagnosis Tester `pass` in a standalone code-producing Flow advances to
  Validation Adequacy Gate, Architect Docs Sync, and Final Acceptance
- Diagnosis Tester `pass` in a code-producing Branch returns to the legal
  Code-Change continuation path without branch-level docs sync or Final
  Acceptance

These paths produce the following record extensions:

- Code Diff Gate revision appends Architect in `architecture-diagnosis` and
  later another `code-diff` Gate dispatch with source `architect-diagnosis`
- standalone code-producing Tester pass appends `validation-adequacy` Gate
  Review and then Architect docs sync, both in `architecture-diagnosis`
- code-producing Branch Tester pass appends the approved `code-change` return
  dispatch to Gate Reviewer for `validation-adequacy`
- analysis-only Branch completion appends the approved `code-change` return
  dispatch to Architect
- Tester failure and user waiting append nothing

### 11.4 Docs-Only Flow

The main confirmed dispatch sequence is:

```text
docs-only / architect
```

The allowed branches are:

- incomplete document work or evidence returns to Architect
- required production-code or runtime-behavior work switches to Code-Change
  Flow at Architect Planning
- `docs/TESTING.md` or validation-strategy work switches to Validation-Only Flow
- conflicting durable requirements make PM wait for a user decision without
  appending to the Flow Record
- Architect `synced` or `unchanged` completes through the existing task
  lifecycle without another Workflow Review request

Documentation revision repeats Architect in `docs-only`. Code work appends
`code-change` / Architect. Validation documentation appends `validation-only` /
Tester. Completion and user waiting append nothing.

Docs-Only Flow does not run Gate Review, Tester validation, separate docs sync,
or Final Acceptance.

### 11.5 Validation-Only Flow

The main confirmed dispatch sequence is:

```text
validation-only / tester
-> validation-only / gate-reviewer / validation-adequacy
```

The allowed branches are:

- incomplete validation work or test-report evidence returns to Tester
- Validation Adequacy Gate `request_changes` returns to Tester and repeats the
  Gate after correction
- required production-code, runtime-behavior, public-contract, dependency, or
  system-architecture work switches to Code-Change Flow at Architect Planning
- missing user intent or external authorization makes PM wait for the user
  without appending to the Flow Record
- a complete Tester `pass` or `fail` result completes through the existing task
  lifecycle after the Validation Adequacy Gate permits continuation

Tester continuation and Validation Adequacy revision append Tester and later
another `validation-adequacy` Gate dispatch in `validation-only`. Required code
work appends `code-change` / Architect. After the complete Validation-Only
sequence, PM may instead append `architect-debug` / Architect when the accepted
outcome requires repair of the confirmed implementation defect. Completion and
user waiting append nothing.

Validation-Only Flow does not run Architecture Plan Gate, Code Diff Gate,
Architect Docs Sync, or Final Acceptance.

### 11.6 Top-Level Debug And Diagnosis Switches

A non-Code-Change switch creates a new top-level Flow segment. Earlier events
remain in the Flow Record as audit history, but no parent Flow or automatic
return point is retained.

The only normal switches directly to Debug or Diagnosis are:

```text
validation-only / tester
-> validation-only / gate-reviewer / validation-adequacy
-> architect-debug / architect
```

```text
architect-debug / architect
-> architect-debug / gate-reviewer / code-diff / architect-debug
-> architect-debug / tester
-> architecture-diagnosis / architect
```

Docs-Only does not switch directly to Debug or Diagnosis. It switches to
Code-Change for production work or Validation-Only for validation work.
Standalone Architecture Diagnosis never switches back to Debug. Any other
top-level Debug or Diagnosis switch requires an exact user-authorized override.

Starting Debug or Diagnosis from an empty Flow Record is a Flow start, not a
switch. Code-Change entry into Debug or Diagnosis follows the Branch rules below
instead of this section.

### 11.7 PM-Only Activity Outside Workflow Review

Communication-only work, waiting for the user, PM final responses, Final
Acceptance completion, task completion, and PR preparation do not dispatch work
to another role and are outside Workflow Review. They do not call
`request-workflow-review`, create a pending dispatch approval, or change
the authoritative Flow Record.

If PM later dispatches another role, that dispatch is reviewed against the
complete Flow Record. Starting or switching to a supported delivery flow
uses `--flow` together with the actual target role.

### 11.8 Global Branch Rules

- incomplete or non-standard role output returns to the same responsible role
- user intent, external authorization, or an exact required exception makes PM
  wait without appending to the Flow Record
- Gate Review `started` or `running` remains at the Gate until the VCM callback
- Gate Review `disabled`, `not_required`, `already_approved`, or `approve`
  informs PM which next dispatch to request; the callback itself appends no new
  workflow event
- Gate Review `request_changes` uses only the branch defined for that Gate in
  the active flow
- Gate Review `failed_to_start` or `failed` stops advancement for VCM retry,
  user skip, or user override handling
- a recorded user skip or override applies only to its exact checkpoint
- a direct role-to-PM report does not append to the Flow Record
- Translator and Harness Engineer are auxiliary roles and never become Round or
  core workflow nodes

Architect Debug Branch and Architecture Diagnosis Branch exist only inside
Code-Change Flow. At most one is inferred from the record. Ordinary same-role
continuation, Gate waiting, and user waiting do not create nested branches.
An explicit top-level flow switch is recorded by the next confirmed dispatch.

### 11.9 Branch Entry, Replacement, And Exit

VCM derives Branch entry, replacement, and return from the complete confirmed
Flow Record. It does not persist a Branch object, entry step, or resume step.

An approved `architect-debug` dispatch after a legal Code-Change prefix enters
Debug Branch when that dispatch is confirmed. An approved
`architecture-diagnosis` dispatch after a legal Debug Branch prefix replaces
Debug with Diagnosis. Because only Code-Change may contain a Branch, the prior
record also identifies the suspended parent flow without separate metadata.

The fixed policy defines which complete record prefixes permit a return and
which target role may receive the return dispatch. A code-producing Debug or
Diagnosis sequence returns to `gate-reviewer`. An analysis-only Diagnosis or
`normal architecture plan required` sequence returns to `architect`.

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
not creation of another Code-Change Flow. It checks that the complete Flow
Record matches an allowed Branch-return prefix and that `--target-role` is legal
for that prefix. VCM does not read the role report or infer its reason.

An allowed request creates one pending return approval bound to the current Flow
Record and target role. The record continues to show the Branch as active until
the matching dispatch succeeds. Dispatch confirmation applies one atomic
transaction:

1. verify the Flow Record sequence and hash and the approved target role
2. append the confirmed `code-change` return dispatch
3. consume the pending approval

PM is the only source of the Branch-exit request. Hooks, Gate controllers, role
reports, and handoff artifacts do not choose Branch exit automatically. A
request whose complete record prefix is not return-capable, or whose target role
does not match that return path, is denied. A failed target dispatch appends
nothing, so the record still shows the Branch as active and the approval remains
recoverable. Until the matching dispatch succeeds, other Code-Change return
dispatches are denied.

If Diagnosis Tester fails, PM does not request Branch exit. User waiting appends
nothing, so the Diagnosis sequence remains the latest Branch sequence. A
user-authorized flow switch may leave it only for the exact recorded exception.

## 12. Workflow Policy

The backend needs a typed, explicit transition policy for every supported fixed
flow and allowed branch. Natural-language PM rules are not an enforcement
mechanism.

Each rule identifies a legal confirmed Flow Record pattern plus the optional
requested flow and target role that may be appended next. The policy may use
reusable sequence matchers, but it must not depend on a mutable cursor or PM's
stated reason. Any candidate dispatch not accepted by a rule is illegal.

The backend exposes one pure matcher:

```text
reviewFlowRecord(confirmedRecord, requestedFlow?, targetRole)
-> allowed | denied
```

The matcher performs no persistence or dispatch:

1. validate the complete existing Flow Record against the fixed policy
2. derive the effective Flow from an explicit request or legal continuation
3. enumerate the dispatch events that may be appended after the full record
4. filter them by effective Flow and target role
5. deny when no legal event remains; otherwise return the matching event set

For a normal role, every matching event has the same effective Flow and target
role, so one Pending Approval is sufficient. For Gate Reviewer, matching events
also carry Gate type and code source. The Pending Approval stores all Gate
signatures legal for that exact record, Flow, and target. The Gate controller
must later match one of those signatures before confirmation appends the exact
Gate event.

The matcher does not persist a derived position, cache a PM-provided state, or
read role results. Repetition, Flow switch, Branch entry, Branch replacement,
and Branch return are accepted only when the complete record plus candidate
matches Section 11.

VCM never asks PM to name or choose a separate operation label. Its decision is:

```text
complete confirmed Flow Record
+ optional requested flow
+ target role
-> allow or deny the candidate dispatch
```

PM selects one of the legal outgoing dispatches after interpreting the role,
Gate, or user result. VCM validates only whether appending that flow-and-target
dispatch produces an allowed record. It does not independently interpret those
results or store why PM selected the dispatch.

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

The Flow Record, pending approval, dispatching approval, rejection fingerprint,
and override evidence are task-scoped backend data in the active worktree.

On VCM restart or task re-entry:

- the authoritative Flow Record is restored
- an unused approval is restored only when its base sequence and hash still
  match the Flow Record
- a dispatching approval is reconciled against message snapshots,
  `UserPromptSubmit`, route content, and target Session state
- stale approvals are invalidated with a recorded reason
- a malformed Flow Record must produce an explicit recovery error rather than
  silently granting a transition

Task close clears runtime approval state. Flow Record retention follows the
task-close policy decided before implementation and cannot block task close.

## 15. Required Tests

Backend unit and end-to-end coverage must include:

- every main-path transition in Section 11 has a positive policy and backend
  integration test
- every allowed branch in Section 11 has a positive policy and end-to-end test
- every supported role-dispatch flow in Section 11 has an end-to-end scenario
  through its final reviewed dispatch
- Flow Record entries preserve effective Flow, target role, Gate type, and code
  source exactly for every confirmed dispatch
- all main dispatch sequences, same-role repetitions, Gate revision loops, Flow
  switches, Branch replacements, and Branch returns listed in Section 11 are
  covered
- the pure matcher does not mutate the Flow Record or persist a derived cursor
- the same Flow Record, requested Flow, and target role always return the same
  decision and legal Gate-signature set
- malformed records, reordered events, skipped dispatches, and invalid
  candidates are denied
- Gate Reviewer approval stores only Gate signatures legal for the exact base
  record and rejects every other Gate type or code source
- every flow has negative tests proving unlisted role targets, flow switches,
  branch entries, branch exits, and skipped checkpoints are denied
- standalone and branch forms of Architect Debug and Architecture Diagnosis are
  tested separately, including Code-Change resume behavior
- entering a Branch appends one confirmed Branch-flow dispatch and leaves the
  prior Code-Change sequence intact
- Debug Branch replacement by Diagnosis is inferred from the sequence without
  creating another Branch layer
- successful Branch return and the next role are approved as one composite
  transition
- the Branch remains active after approval until the matching role or Gate
  dispatch succeeds
- successful dispatch atomically appends the approved Code-Change return event
  and consumes the approval
- wrong target role, non-return-capable Flow Record prefix, and failed target
  dispatch append no return event
- Hooks, Gate callbacks, role reports, and handoff changes cannot exit a Branch
  without a PM-approved composite transition
- a non-Code-Change flow moves to Debug or Diagnosis by top-level flow switch,
  never by Branch creation
- Validation-Only may switch to standalone Debug only after its Tester and
  Validation Adequacy Gate sequence
- standalone Debug may switch to standalone Diagnosis only after its Architect,
  Code Diff Gate, and Tester sequence
- Docs-Only cannot switch directly to Debug or Diagnosis, and standalone
  Diagnosis cannot switch back to Debug without an exact user override
- a top-level switch retains earlier Flow events as history but creates no
  parent or automatic return point
- starting without an active flow requires `--flow`
- starting a flow with a legal target appends its first confirmed dispatch
- omitting `--flow` continues the current flow
- repeating the current `--flow` without an active Branch is an idempotent
  continuation request
- `--flow code-change --target-role <role>` from an exit-capable Code-Change
  Branch approves Branch return and the matching next role together
- requesting another flow is validated as a top-level switch, Branch entry, or
  Debug-to-Diagnosis Branch replacement
- Architect Debug and Architecture Diagnosis resolve to a standalone flow or
  Branch from the complete Flow Record
- allowed flow-and-target review creates one pending target-role approval
- denied flow-and-target review creates no approval and returns allowed
  alternatives
- PM route without approval is rejected
- PM route to the approved role is dispatched
- PM route to another role is rejected
- one approval cannot dispatch two messages
- a new review invalidates the prior unused approval
- a Flow Record append invalidates an approval based on an older sequence
- non-PM report to PM remains deliverable without approval
- user waiting, PM final responses, Final Acceptance completion, task
  completion, and PR preparation never require Workflow Review
- Workflow Review cannot create a PM-target or targetless approval
- the Flow Record changes only after target `UserPromptSubmit`
- failed terminal submission does not append to the Flow Record
- restart reconciles pending and dispatching approvals
- unchanged rejected routes do not generate repeated callbacks
- exact user override is accepted and recorded
- missing, mismatched, stale, or reused user authorization is rejected
- user override cannot bypass non-workflow safety controls

## 16. Open Decisions Before Implementation

The authoritative Flow Record, workflow-review command-line interface, and
deny-by-default policy shape are decided above. Resolve the following items in
order before coding. Discuss one item at a time: state the problem, present a
recommendation, and record the user's decision before changing the design.

The targetless-checkpoint question is resolved: Workflow Review reviews only
PM-to-role dispatches. PM-only activity is outside its record and approval
mechanism.

The mutable-cursor and same-target ambiguity questions are resolved: the
complete confirmed Flow Record is the source of truth. Workflow Review does not
store a step or reason. The same record plus the same requested flow and target
role is the same candidate dispatch.

The complete Flow dispatch sequence question is resolved in Section 11. Flow
Record events identify the effective Flow, target role, Gate type, and code
source. Main sequences, role repetitions, Gate revisions, Flow switches, Branch
replacement, and Branch return are explicitly listed.

The typed-matcher question is resolved in Section 12. A pure matcher validates
the complete record and returns the legal append events for the requested Flow
and target role. It stores no cursor. Gate Reviewer approvals retain the Gate
signatures legal for that exact record.

The non-Code-Change switch question is resolved in Section 11.6. A completed
Validation-Only sequence may switch to standalone Debug. A standalone Debug
sequence through Tester may switch to standalone Diagnosis. These are top-level
Flow segments with no automatic return. Other switches require exact user
authorization.

1. **Final Acceptance follow-up mapping.** Replace "earliest affected step" with
   fixed destinations and required downstream Gates for
   `needs-coder-follow-up`, `needs-architect-follow-up`, and
   `needs-docs-sync`.
2. **Approval-to-dispatch correlation.** Target-role equality alone cannot
   distinguish the newly approved message from an older pending route to the
   same role. Define how VCM recognizes the first eligible dispatch created
   after approval without adding approval metadata to route files.
3. **Gate Reviewer approval consumption.** Define exact matching for gate type
   and code source, existing running Gate behavior, consumption for
   `started`/`running`/`disabled`/`not_required`/`already_approved`, recovery for
   `failed_to_start`, and tests that distinguish Gate consumption from normal
   `UserPromptSubmit` confirmation.
4. **Restart reconciliation.** Define how a restored `dispatching` approval is
   classified as unsent, submitted, started, completed, or failed so VCM neither
   duplicates a dispatch nor advances a transition that never started.
5. **Flow Record lifecycle boundaries.** Define the empty initial record,
    top-level Flow replacement history, record retention at task close, and
    guaranteed task close that cannot be blocked by malformed or unfinished
    Workflow Review runtime data. User waiting, Final Acceptance completion, and
    PR preparation are outside Workflow Review.
6. **User-authorization source capture.** Define how VCM captures and identifies
   exact direct user messages from Embedded Terminal, Gateway, and other input
   paths so PM cannot fabricate, broaden, or reuse override authorization.
7. **Override evidence retention.** Decide whether override evidence survives
   task close or remains task-runtime evidence only, while preserving audit and
   one-time-use guarantees for the lifetime selected.
8. **Machine-policy and Harness synchronization.** Decide whether one source
   generates both the backend transition policy and PM Harness description, or
   independent definitions are compared by synchronization tests. Manual drift
   must fail validation before release.
