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
authorization text. VCM records that text as the override evidence.

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

Before creating a normal-role approval, VCM requires every
`project-manager-*.md` outbound route file to be empty. A non-empty outbound
file means an earlier message is still pending or unreconciled; the new review
is denied with the exact file path and no approval is created. VCM does not
silently clear or reuse that content.

The backend record contains at least:

```text
task slug
base Flow Record sequence and hash
requested flow when supplied
effective flow
approved target role
expected route path for a normal role
allowed Gate signatures when target role is Reviewer
normal or user-override decision
created time
user-authorization evidence when applicable
dispatch status
```

The record is internal VCM state. Route messages do not carry these fields.

A new workflow-review request replaces any unused pending approval for the same
task. Appending another event to the Flow Record invalidates an unused approval
based on an older record.

An approval is valid for one PM dispatch only. It cannot authorize multiple
messages to the same role.

## 6. Role Dispatch Enforcement

`vcm-route-message` remains the PM-hub channel for normal role messages. Gate
Reviewer dispatch uses the Gate Review controller. Both paths require and claim
the matching pending workflow approval; Section 7 defines when it is consumed.

The backend remains the enforcement boundary. For a normal PM-to-role route, it
loads the task's pending dispatch approval and compares only backend-owned facts
with the route:

- the route is from Project Manager
- the route path equals the approval's expected route path
- the route target role equals the approved target role
- the approval still matches the current Flow Record sequence and hash
- the approval has not already been consumed or invalidated

When these conditions match, VCM permits the normal message dispatch. No
workflow approval fields are required in route-file frontmatter.

Workflow Review approval creation, route scanning, approval claiming, and
dispatch confirmation use the same task lock. After approval, only newly
written non-empty content at the expected route path may claim it. An outbound
file at another path has no approval and is not dispatched.

When no pending approval exists, the approval was denied, the target role does
not match, or the approval is stale, VCM must not send the message.

When the approved target is Reviewer, `.ai/tools/request-gate-review` must
find a matching pending approval before the Gate controller may start or reuse
the Reviewer. Its Gate type and code source must match one of the approval's
allowed Gate signatures. A different Gate signature or Flow Record base is
rejected.

Non-PM reports to PM do not require workflow approval. They provide evidence
for PM's next workflow-review request and cannot append to the Flow Record.

## 7. Approval Consumption

VCM must prevent both duplicate dispatch and false state advancement.

When a matching normal route is selected for delivery, the pending approval
moves to an internal dispatching state and stores the exact route-content hash
and generated message ID so another Hook cannot reuse it. This write-ahead
transition must be persisted before terminal input is submitted. The approval
is consumed and cleared only when Claude Code confirms that message through
`UserPromptSubmit`; Section 14 defines the transcript fallback used only during
restart recovery.

Reviewer uses the following status rules because starting a review is not
the same as resolving its checkpoint:

| Gate result | Approval and Flow Record handling |
| --- | --- |
| `disabled` | consume the approval and append a Gate event with disposition `disabled` |
| `not_required` | consume the approval and append a Gate event with disposition `not_required` |
| `already_approved` | consume the approval and append a Gate event with disposition `already_approved` |
| `started` | move the approval to `dispatching`, bind the exact Gate request ID, and append nothing |
| `running` for the same request ID | keep the existing `dispatching` approval and append nothing |
| `running` for another Gate or request ID | reject the request without consuming the approval or appending an event |
| `failed_to_start` | return the approval to recoverable `pending` and append nothing |
| callback `approve` | consume the approval and append a Gate event with decision `approve` |
| callback `request_changes` | consume the approval and append a Gate event with decision `request_changes` |
| callback `failed` | keep a recoverable failed approval and append nothing |
| user skip or override | consume the approval and append the exact Gate event plus its exception evidence |

The Gate type and code source must match the approval before any status may
change it. A `dispatching` Gate approval stores the exact request ID and Gate
signature so an unrelated running review cannot claim it.

If terminal submission fails before confirmation, VCM records the failed
attempt and makes the approval recoverable for the same unchanged route, or
returns it to pending. It must not append a Flow Record event as though the
target role started successfully.

A confirmed normal-role dispatch atomically appends the approved
flow-and-target event and clears the pending approval. A resolved Gate
checkpoint atomically appends its Gate event and consumes its approval. Branch
entry, replacement, or return is derived from that complete record rather than
stored as mutable state. A normal route file is cleared only when its current
content still matches the claimed route-content hash. Content written after the
claim remains pending and requires another Workflow Review approval.

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

VCM requires non-empty authorization text but does not authenticate its input
channel or resolve a separate user-message source record.

The override record binds:

- task slug
- base Flow Record sequence and hash
- requested flow when supplied
- exact target role
- user authorization text supplied by PM
- the normal rule being bypassed
- approval and consumption times

The resulting pending dispatch approval uses the same route enforcement as a
normal approval. The route message still contains no approval metadata.

An override is one-time and cannot be reused after any Flow Record append,
for another role, another flow request, another task, or a broader exception.
Its evidence remains available for the lifetime of the active task so the
decision can be audited and its consumption can be enforced.

Workflow override authority bypasses only the fixed workflow transition rule.
It does not bypass filesystem permissions, role boundaries, PM-hub routing,
task ownership, or other runtime safety controls.

## 10. Authoritative Flow Record

Workflow Review cannot rely on a PM-declared current state. Its only source of
truth is an append-only task-scoped record of confirmed normal-role dispatches
and resolved Gate checkpoints.

VCM initializes a versioned Flow Record with the task slug and an empty event
list when a task is created. An active older task with no Flow Record is
initialized the same way. An existing malformed record is never treated as
empty: VCM denies new role dispatches and reports the parsing or validation
error until the task is repaired or closed.

Each entry contains at least:

```text
sequence
effective flow
target role
dispatch type
gate type when target role is Reviewer
code source when gate type is code-diff
Gate disposition when target role is Reviewer
Gate decision when disposition has a review decision
confirmed time
override evidence reference when applicable
```

`effective flow` is one of `code-change`, `architect-debug`,
`architecture-diagnosis`, `docs-only`, or `validation-only`. `dispatch type`
distinguishes the normal role route from the Gate Review controller. `gate type`
is `architecture-plan`, `code-diff`, or `validation-adequacy`; `code source` is
`coder`, `architect-debug`, or `architect-diagnosis`. Gate `disposition` is
`disabled`, `not_required`, `already_approved`, `completed`, `skipped`, or
`overridden`. A completed disposition records decision `approve` or
`request_changes`. Gate identity and resolution are part of the Gate node, not
PM's reason for choosing the next dispatch.

The Flow Record does not persist a current step, cursor, status, Branch object,
entry point, or resume point. It also does not store the role's reason, result,
or PM interpretation. VCM matches the complete Flow Record sequence against the
fixed policy to determine which next flow-and-target combinations are legal.

A normal-role entry is appended only after the target `UserPromptSubmit`
confirms the approved route, except for the exact transcript-based restart
recovery defined in Section 14. A Gate entry is appended only after the matching
checkpoint has an actionable resolution: `disabled`, `not_required`,
`already_approved`, callback `approve`, callback `request_changes`, or an exact
user skip or override. Gate request creation, `started`, `running`,
`failed_to_start`, and callback `failed` do not append entries. Approval,
route-file creation, terminal submission failure, ordinary role output, user
waiting, PM activity, Final Acceptance completion, task completion, and PR
preparation do not append entries.

Branch state is derived from the sequence:

- Code-Change followed by an approved `architect-debug` dispatch enters Debug
  Branch
- `architecture-diagnosis` after that Branch replaces Debug with Diagnosis
- an approved `code-change` return dispatch exits the Branch
- Debug or Diagnosis entered from any other flow is a top-level flow switch

The complete record therefore determines whether a Branch is active and which
Code-Change path may resume. No separately persisted cursor can drift from the
dispatch history.

A top-level Flow switch appends a new Flow segment to the same record. It never
clears, replaces, or truncates earlier events. Earlier segments remain evidence
for validating which switch was legal, but they create no automatic return
point.

PM cannot append or rewrite this record. Session, Turn, Round, Gate Review,
artifact, and process states remain independent. Runtime events may only confirm
an already approved normal route or resolve an already approved Gate checkpoint.
The existing `update-task-state` endpoint and tool must not mutate the Flow
Record. Frontend code only displays the record and user-authorization controls.

## 11. Workflow And Branch Inventory

This inventory is the complete source list for the machine workflow policy.
Every main-path transition and allowed branch listed here must be represented in
the backend policy. Anything not listed is denied unless VCM records an exact
one-time user-authorized override.

The sequences below contain confirmed normal-role dispatches and resolved Gate
checkpoints. A repeated normal role is another confirmed dispatch to that role.
A Gate entry includes its Gate identity and actionable resolution. Ordinary
role results, unresolved Gate activity, user waiting, PM work, and completion do
not appear as record events.

### 11.1 Code-Change Flow

The main Flow Record sequence is:

```text
code-change / architect
-> code-change / architect
-> code-change / reviewer / architecture-plan
-> code-change / coder
-> code-change / reviewer / code-diff / coder
-> code-change / tester
-> code-change / reviewer / validation-adequacy
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
  appending to the Flow Record
- each follow-up uses the fixed dispatch sequence below
- Final Acceptance `accepted` completes the task through the existing task
  lifecycle without a Workflow Review request
- Final Acceptance `accepted-with-known-risks` uses the existing user-approval
  and task-completion path without a Workflow Review request

These branches produce the following record extensions:

- interview, planning, planning revision, Coder continuation, Tester revision,
  and docs-sync correction repeat the same responsible role
- Architecture Plan Gate revision appends Architect and later another
  `architecture-plan` Gate event
- Coder completion appends `code-diff` with source `coder`
- Coder failure, Code Diff Gate correction, Tester failure, or a permitted
  implementation correction during docs sync appends `architect-debug` /
  Architect
- Validation Adequacy revision appends Tester and later another
  `validation-adequacy` Gate event
- a Final Acceptance Coder follow-up appends Coder and repeats every downstream
  Code-Change Gate and role dispatch
- a Final Acceptance Architect or docs-sync follow-up appends Architect; any
  later dispatch must independently match a legal Code-Change continuation,
  Debug entry, or Diagnosis entry

Final Acceptance follow-up sequences are fixed.

Coder follow-up appends:

```text
code-change / coder
-> code-change / reviewer / code-diff / coder
-> code-change / tester
-> code-change / reviewer / validation-adequacy
-> code-change / architect
```

Coder continuation may repeat Coder before Code Diff Gate. Every downstream
Gate, Tester dispatch, and docs-sync dispatch is required again.

Architect follow-up appends:

```text
code-change / architect
-> code-change / reviewer / architecture-plan
-> code-change / coder
-> code-change / reviewer / code-diff / coder
-> code-change / tester
-> code-change / reviewer / validation-adequacy
-> code-change / architect
```

Architect continuation and Gate revision loops remain legal inside this fixed
sequence. The architecture-plan Gate, Coder, and every downstream event are
required again.

Docs-sync follow-up appends Architect in `code-change`. Incomplete docs sync may
repeat Architect. Successful docs sync returns to PM Final Acceptance without
another role dispatch or Gate event.

Architect follow-up and docs-sync follow-up begin with the same Flow Record
event. Workflow Review does not record the reason. A later architecture-plan
Gate selects the Architect follow-up sequence; repeated Architect dispatches or
no further role dispatch remain the docs-sync path. Direct Coder, Tester, or
another Gate request from that shared prefix is denied unless it matches one
of these fixed sequences or an explicitly allowed Debug or Diagnosis entry.

### 11.2 Architect Debug Flow And Branch

The shared Flow Record sequence is:

```text
architect-debug / architect
-> architect-debug / reviewer / code-diff / architect-debug
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
  another `code-diff` Gate event with source `architect-debug`
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

The code-producing Flow Record sequence is:

```text
architecture-diagnosis / architect
-> architecture-diagnosis / reviewer / code-diff / architect-diagnosis
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
  later another `code-diff` Gate event with source `architect-diagnosis`
- standalone code-producing Tester pass appends `validation-adequacy` Gate
  Review and then Architect docs sync, both in `architecture-diagnosis`
- code-producing Branch Tester pass appends the approved `code-change` return
  dispatch to Reviewer for `validation-adequacy`
- analysis-only Branch completion appends the approved `code-change` return
  dispatch to Architect
- Tester failure and user waiting append nothing

### 11.4 Docs-Only Flow

The main Flow Record sequence is:

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

The main Flow Record sequence is:

```text
validation-only / tester
-> validation-only / reviewer / validation-adequacy
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
another `validation-adequacy` Gate event in `validation-only`. Required code
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
-> validation-only / reviewer / validation-adequacy
-> architect-debug / architect
```

```text
architect-debug / architect
-> architect-debug / reviewer / code-diff / architect-debug
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
- Gate Review `started` or same-request `running` appends nothing and remains at
  the Gate until an actionable resolution
- another running Gate or request cannot consume the pending approval
- Gate Review `disabled`, `not_required`, `already_approved`, or `approve`
  appends its resolved Gate event and permits the normal next dispatch
- Gate Review `request_changes` appends its resolved Gate event and permits only
  the correction path defined for that Gate in the active flow
- Gate Review `failed_to_start` or `failed` stops advancement for VCM retry,
  user skip, or user override handling and appends nothing
- a recorded user skip or override appends one Gate event and applies only to
  its exact checkpoint
- a direct role-to-PM report does not append to the Flow Record
- Translator and Harness Engineer are auxiliary roles and never become Round or
  core workflow nodes

Architect Debug Branch and Architecture Diagnosis Branch exist only inside
Code-Change Flow. At most one is inferred from the record. Ordinary same-role
continuation, Gate waiting, and user waiting do not create nested branches.
An explicit top-level flow switch is recorded by the next confirmed normal-role
dispatch.

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
Diagnosis sequence returns to `reviewer`. An analysis-only Diagnosis or
`normal architecture plan required` sequence returns to `architect`.

After receiving the qualifying role result, PM requests Branch return and the
next role in one review. For a completed code-producing Branch:

```text
.ai/tools/request-workflow-review --flow code-change \
  --target-role reviewer
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
mechanism. This typed `workflow-policy` is the single source of truth for the
machine dispatch graph.

Each rule identifies a legal Flow Record pattern plus the optional requested
flow and target role that may be requested next. The policy may use
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
3. enumerate the role or Gate candidates that may follow the full record
4. filter them by effective Flow and target role
5. deny when no legal event remains; otherwise return the matching event set

For a normal role, every matching event has the same effective Flow and target
role, so one Pending Approval is sufficient. For Reviewer, matching events
also carry Gate type and code source. The Pending Approval stores all Gate
signatures legal for that exact record, Flow, and target. The Gate controller
must later match one of those signatures, bind its exact request ID, and append
the Gate event only after an actionable resolution.

The matcher treats the resolved Gate event's disposition and decision as part
of the record. `approve`, `disabled`, `not_required`, and `already_approved`
open the normal continuation. `request_changes` opens only the Gate's correction
path. An unresolved or failed Gate has no Flow Record event and therefore cannot
open either path.

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

The matcher reads the typed policy directly. A renderer reads the same policy
and generates a fixed Workflow Dispatch Policy block for the Project Manager
Harness. That generated block contains the ordered role and Gate nodes, legal
repetitions, Flow switches, Branch entry, Branch replacement, Branch return,
target roles, and Gate signatures. It is not hand-edited.

PM rules that explain how to interpret role, Gate, or user results remain
manually authored because they are model behavior rules rather than the machine
dispatch graph. They may guide PM's choice among legal candidates but cannot
add a transition absent from the typed policy.

The installer template, VCM self-Harness, and `example/rust-layered` use the
same rendered block. Synchronization tests fail when any copy differs from the
renderer. The machine policy remains authoritative for dispatch permission even
if explanatory PM prose is incomplete or stale.

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
and override evidence are task-scoped backend data in the active worktree. They
are not copied to the base repository or a project-wide workflow history.

VCM restores the authoritative Flow Record first. A malformed record produces
an explicit recovery error and grants no transition. Every restored approval
must still match the record's current sequence and hash; otherwise VCM
invalidates it with the exact reason.

A restored normal-role `pending` approval remains pending when its base still
matches. A route file may claim it through the ordinary locked dispatch path.
VCM never sends a non-empty PM outbound route that has no matching pending or
dispatching approval.

Normal-role `dispatching` is a persisted write-ahead state. Recovery classifies
it from durable evidence:

- a matching `UserPromptSubmit` receipt completes the dispatch
- if that Hook receipt was lost, an exact accepted user message in the approved
  target Session transcript, recorded after the claim and matching the route
  content hash, also completes the dispatch
- completion atomically appends the approved Flow Record event and consumes the
  approval
- without either completion proof, unchanged route content with the claimed
  hash returns the approval to `pending` so the ordinary dispatcher may retry
- missing or changed route content invalidates the approval and reports a
  recovery error; VCM neither sends nor appends an event

Reviewer recovery uses the exact Gate request ID and Gate signature stored
by its `dispatching` approval:

- a persisted actionable Gate resolution is applied through the Section 7
  status rules
- a live Gate process bound to the same request in the current runtime keeps the
  approval `dispatching`
- `failed_to_start` or callback `failed` returns the approval to recoverable
  `pending` without appending an event
- a missing request, mismatched request ID, or mismatched Gate signature
  invalidates the approval and reports a recovery error

Reconciliation runs under the task lock. Applying a confirmed normal dispatch
or resolved Gate checkpoint and consuming its approval is atomic. Repeating
reconciliation after another restart cannot append the same Flow Record event,
consume an approval twice, or resend a route already proven complete.

Task close always clears pending and dispatching approvals and proceeds even if
Workflow Review data is incomplete or malformed. Such conditions may produce a
warning but cannot block worktree removal. The Flow Record and override evidence
are deleted with the task worktree and are not archived elsewhere. Re-entering
an active task restores its record and override evidence; a closed task has no
resumable Workflow Review state.

## 15. Required Tests

Backend unit and end-to-end coverage must include:

- new task creation initializes a versioned empty Flow Record
- entering an active older task with no Flow Record initializes an empty record
- a malformed existing Flow Record denies role dispatch with an exact error but
  cannot block task close
- top-level Flow switches append new segments without clearing earlier events
- re-entering an active task restores its complete Flow Record
- task close clears approval state, succeeds with unfinished or malformed
  Workflow Review data, and creates no base-repository or project-wide archive
- the backend matcher and PM Workflow Dispatch Policy block are produced from
  the same typed workflow policy
- installer output, VCM self-Harness, and `example/rust-layered` contain the
  exact generated PM policy block
- hand-edited or stale generated PM policy content fails synchronization tests
- every transition in the typed policy has a positive matcher test and every
  unlisted flow-and-target candidate is denied
- every main-path transition in Section 11 has a positive policy and backend
  integration test
- every allowed branch in Section 11 has a positive policy and end-to-end test
- every supported role-dispatch flow in Section 11 has an end-to-end scenario
  through its final reviewed dispatch
- Flow Record entries preserve effective Flow, target role, Gate type, code
  source, disposition, and decision exactly where each field applies
- all main dispatch sequences, same-role repetitions, Gate revision loops, Flow
  switches, Branch replacements, and Branch returns listed in Section 11 are
  covered
- Final Acceptance Coder follow-up repeats Code Diff Gate, Tester, Validation
  Adequacy Gate, and Architect docs sync
- Final Acceptance Architect follow-up repeats Architecture Plan Gate, Coder,
  every downstream Gate, Tester, and Architect docs sync
- Final Acceptance docs-sync follow-up permits Architect repetition but no
  direct Coder, Tester, or Gate dispatch
- the pure matcher does not mutate the Flow Record or persist a derived cursor
- the same Flow Record, requested Flow, and target role always return the same
  decision and legal Gate-signature set
- malformed records, reordered events, skipped dispatches, and invalid
  candidates are denied
- Reviewer approval stores only Gate signatures legal for the exact base
  record and rejects every other Gate type or code source
- Gate `disabled`, `not_required`, `already_approved`, callback `approve`,
  callback `request_changes`, user skip, and user override each consume the
  matching approval and append the exact resolved Gate event
- Gate `started`, same-request `running`, `failed_to_start`, and callback
  `failed` append no Gate event and permit no next role
- another running Gate or mismatched request ID cannot consume or reuse the
  pending approval
- Gate `request_changes` permits only its correction path; all other actionable
  Gate dispositions permit only the normal continuation
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
- approval creation is denied while any PM outbound route file is non-empty
- a normal-role approval records the only route path allowed to claim it
- only route content written at that expected path after approval may move the
  approval to dispatching
- PM route to the approved role is dispatched
- PM route to another role is rejected
- claiming stores the exact route-content hash and message ID
- confirmation clears the route file only when its content still matches the
  claimed hash
- content written after claim remains pending and cannot reuse the consumed
  approval
- one approval cannot dispatch two messages
- a new review invalidates the prior unused approval
- a Flow Record append invalidates an approval based on an older sequence
- non-PM report to PM remains deliverable without approval
- user waiting, PM final responses, Final Acceptance completion, task
  completion, and PR preparation never require Workflow Review
- Workflow Review cannot create a PM-target or targetless approval
- ordinary normal-role dispatch changes the Flow Record only after target
  `UserPromptSubmit`; only Section 14's exact transcript recovery may replace a
  lost receipt
- failed terminal submission does not append to the Flow Record
- dispatching state is durably recorded before normal terminal submission
- restart restores a current-base pending approval without granting any other
  route permission
- restart completes a normal dispatch from its matching `UserPromptSubmit`
  receipt without sending it again
- restart may recover a lost Hook receipt only from an exact accepted target
  Session transcript message recorded after the claim with matching content hash
- restart returns an unconfirmed dispatch to pending only when the claimed route
  content and hash remain unchanged
- restart invalidates an unconfirmed dispatch when its route is missing or
  changed and appends no Flow Record event
- restart resolves a Gate only from the exact stored request ID, signature, and
  actionable result
- restart keeps only a currently live matching Gate request in `dispatching`
- failed Gate recovery returns to pending; missing or mismatched Gate recovery
  invalidates the approval
- repeated reconciliation is idempotent for normal and Gate dispatches
- restart never sends a non-empty PM outbound route that has no matching
  pending or dispatching approval
- unchanged rejected routes do not generate repeated callbacks
- exact user override is accepted and recorded
- missing, stale, or reused user authorization is rejected
- override evidence remains auditable and non-reusable throughout the active
  task, then is deleted with the worktree without project-level archival
- malformed override evidence may warn but cannot block task close
- user override cannot bypass non-workflow safety controls

## 16. Resolved Design Decisions

All pre-implementation design questions are resolved. The decisions below
summarize the constraints that implementation must preserve.

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
and target role. It stores no cursor. Reviewer approvals retain the Gate
signatures legal for that exact record.

The non-Code-Change switch question is resolved in Section 11.6. A completed
Validation-Only sequence may switch to standalone Debug. A standalone Debug
sequence through Tester may switch to standalone Diagnosis. These are top-level
Flow segments with no automatic return. Other switches require exact user
authorization.

The Final Acceptance follow-up question is resolved in Section 11.1. Coder
follow-up repeats Code Diff Gate and every downstream dispatch. Architect
follow-up repeats Architecture Plan Gate and the complete downstream path.
Docs-sync follow-up repeats only Architect before PM reruns Final Acceptance.

The normal route-correlation question is resolved in Sections 5 through 7.
Every PM outbound route file must be empty before approval. The approval binds
the expected path; claiming stores the exact content hash and message ID. Route
files carry no workflow approval metadata.

The Reviewer consumption question is resolved in Sections 7 and 10.
Starting or running a Gate does not append a Flow Record event. Only a matching
actionable resolution consumes the approval and appends the resolved Gate
checkpoint; failed starts and failed callbacks remain recoverable without
advancing the flow.

The restart-reconciliation question is resolved in Section 14. Normal dispatch
uses persisted write-ahead state and requires an exact Hook receipt or accepted
transcript message before advancing. Gate recovery uses its exact request ID,
signature, and actionable result. Unproven work returns to pending only when its
original input remains intact; otherwise it is invalidated without advancing.

The Flow Record lifecycle question is resolved in Sections 10 and 14. A task
starts with a versioned empty record, active tasks restore it, and Flow switches
append history. Task close always succeeds and removes Workflow Review state
with the worktree without copying or archiving it elsewhere.

User-authorization source capture is intentionally out of scope. PM supplies
the exact user authorization text, and VCM records and binds it without
authenticating the originating input channel.

Override evidence retention follows the Flow Record lifecycle. Evidence remains
auditable and one-time within the active task, then is deleted with the task
worktree without base-repository or project-wide archival.

Machine-policy and Harness synchronization is resolved in Section 12. One typed
workflow policy drives both the backend matcher and the generated PM Workflow
Dispatch Policy block. PM's result-interpretation prose remains manual, while
the generated dispatch graph and its synchronized Harness copies cannot drift.
