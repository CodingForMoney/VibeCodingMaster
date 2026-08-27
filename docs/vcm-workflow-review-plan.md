# VCM Workflow Control

Last updated: 2026-08-28

Status: implemented

## Goal

VCM enforces every Project Manager dispatch to Architect, Coder, or Tester.
Project Manager proposes the next target through a managed Workflow Progress
artifact. VCM accepts only transitions allowed by the fixed task flows and the
task's confirmed dispatch history.

Workflow Control does not choose the next role for Project Manager and does not
review PM-only activity, Final Acceptance, task close, or PR preparation. It
does own the hard wait after PM asks the user a question, because no role route
may continue until a direct user reply clears that wait.

## Managed Workflow Progress

The authoritative task record is:

```text
.ai/vcm/handoffs/workflow-progress.md
```

Project Manager updates it only with `vcm-workflow-review`, which submits the
candidate through `.ai/tools/vcm-artifact workflow-progress`. The document has
strict fields:

```text
# Workflow Progress: <task-slug>

Revision: <non-negative integer>
Flow: none|code-change|architect-debug|architecture-diagnosis|docs-only|validation-only
Status: not-started|active|completed

## Dispatch History

none

## Proposed Dispatch

Requested Flow: none|code-change|architect-debug|architecture-diagnosis|docs-only|validation-only
Target Role: none|architect|coder|tester
Evidence: <real artifact or accepted user request>

## User Authorization

Authorization Text: none
Violated Rule: none

## User-Approved Follow-Up

Approval Text: none
```

For every proposal, Project Manager must copy the accepted Flow, Status, and
complete Dispatch History unchanged and increment Revision by one. `Requested
Flow` starts a flow, switches a top-level flow, enters or replaces a Branch, or
returns from a Code-Change Branch. Continuing the current flow uses `none`.

VCM rejects altered history, skipped revisions, unsupported values, stale
proposals, invalid completion, and transitions not allowed by the confirmed
history and current artifacts. An accepted proposal creates one pending
dispatch approval; it does not append history yet.

## Dispatch Enforcement

The pending approval is stored in task runtime state at:

```text
.ai/vcm/workflow-control.json
```

It is bound to the accepted Workflow Progress revision and history hash, exact
target role, expected PM route path, effective flow, and optional user authorization.

`vcm-route-message` contains only the role message. It carries no workflow
approval metadata. Both artifact submission and automatic route dispatch check
that the PM route matches the pending approval.

Dispatch uses this lifecycle:

1. Accepted Workflow Progress creates one `pending` approval.
2. A matching PM route claims it as `dispatching` before terminal input and
   records the route-content hash and generated message ID.
3. Terminal submission failure returns the same approval to `pending`.
4. The target role's matching `UserPromptSubmit` confirms the dispatch.
5. Confirmation atomically appends one Dispatch History row and clears the
   approval.

Submitting or confirming a dispatch updates Workflow Progress and runtime state
through `.ai/vcm/workflow-control-transaction.json`. An interrupted paired write
is replayed before state is read. Project startup recovers message state first,
then changes an unconfirmed `dispatching` approval back to `pending` so it can
be delivered again without creating a second history row.

Automatic delivery matches the generated VCM message ID. In manual
orchestration, VCM accepts only a target `UserPromptSubmit` whose text exactly
matches the unique pending PM route body; it does not use transcript inference
or fuzzy matching.

A different target, stale Workflow Progress, missing approval, or second route
is rejected. Reports from Architect, Coder, Tester, and Reviewer to Project
Manager do not require approval.

## User Authorization

An illegal transition can proceed only after direct user authorization:

1. The role whose action is rejected asks the user directly and waits.
2. For a rejected workflow transition, Project Manager resubmits the unchanged
   transition with the user's exact authorization text and exact rejection rule.
3. VCM records the authorization only when both fields match the rejected
   transition.
4. The authorization is consumed by one matching dispatch.

An authorization is bound to one task, submitting role, operation, base revision, history hash, flow, target,
evidence, violated rule, and exact authorization text. It bypasses only the
workflow transition rule; it does not bypass role ownership, routing,
filesystem, artifact, Gate, or runtime safety rules. Consuming an authorization
does not restart the active flow run. A return from a Debug or Diagnosis Branch
retains the parent run and its completed implementation history; a switch to an
independent flow starts a fresh run. Reusing the same wording for a later user
decision is allowed because identity and one-time consumption are determined by
the bound transition rather than global text uniqueness.

User-approved post-validation work is a separate one-time record. It permits
only a Tester dispatch after a fresh passing Test Report and successful
Validation Adequacy and Code Diff Gates. It carries the user's exact approval,
does not create a workflow override, and makes the prior Test Report and Gate
results stale when consumed.

## Supported Flows

### Code Change

The normal dispatch order is:

```text
Architect -> Coder -> Tester -> Architect docs sync
```

The Architecture Plan Gate must approve the real plan before Coder. The
Validation Adequacy and Code Diff Gates must approve after Tester before docs
sync. Gate Review is controlled by its existing request service rather than a
PM route message, so Gate events are read from the Gate index and are not rows
in Workflow Progress. Disabled Gates remain pass-through configuration.
Not-required, skipped, and overridden states satisfy a checkpoint only when the
Gate record changed after the active role dispatch; an exception from an older
dispatch cannot bypass fresh review requirements.

Allowed branches include:

- incomplete planning or Architecture Plan `request_changes` returns to Architect
- incomplete Coder completion returns to Coder
- Coder failure or implementation findings enter Architect Debug
- Tester infrastructure repair or validation-only findings return to Tester
- other Tester failures enter Architect Debug
- Code Diff test-only findings return to Tester
- explicit user-approved Tester-owned work after both green Gates returns to Tester
- implementation findings enter Architect Debug
- blocked docs sync routes its exact Architect, Coder, or Tester correction owner, then repeats invalidated validation and Gates before docs sync
- Final Acceptance follow-up returns to the responsible Coder or Architect path

An Architect follow-up from Final Acceptance must produce a fresh complete plan
and a Gate result newer than that follow-up dispatch before Coder is legal.

Architect Debug may replace itself with Architecture Diagnosis after its first
Tester failure. A successful Debug or Diagnosis Branch returns by requesting
`Flow: code-change` with the next Code-Change target. The complete history
preserves every dispatch, while task runtime state records the current root
flow, active branch, branch return, and flow-run start sequence. This prevents
earlier completed flows from being mistaken for the active parent flow.

### Architect Debug

The normal dispatch order is:

```text
Architect -> Tester -> Architect docs sync
```

Validation Adequacy and Code Diff must pass before docs sync. A first failed
Debug validation may switch to Architecture Diagnosis. When Debug is a branch
of Code Change, successful review returns to Code Change instead of completing
as a standalone flow.

### Architecture Diagnosis

The normal implementation path is:

```text
Architect -> Tester -> Architect docs sync
```

Validation Adequacy and Code Diff must pass before docs sync. A diagnosis whose
accepted disposition is analysis-only may complete without an implementation
dispatch. Failed validation after implemented diagnosis has no automatic
additional repair branch and must be reported to the user.

### Docs Only

Docs-only work may dispatch Architect, Coder, or Tester according to the
documentation being updated. Each sequential assignment must produce a fresh
`docs-update-report.md`. The latest `synced` or `unchanged` result permits
completion. Explicit scope-change branches may switch to Code Change at
Architect or Validation Only at Tester.

### Validation Only

Validation-only work dispatches Tester. Test infrastructure repair,
incomplete evidence, or Validation Adequacy `request_changes` returns to
Tester. A terminal Test Report and resolved Validation Adequacy Gate complete
the flow. `Test Infrastructure Status: production-change-required` may switch
to Code Change at Architect.

## Completion

Project Manager completes the active flow by submitting a new Workflow Progress
revision with `Status: completed` and every proposal, override, and
user-approved follow-up field set to `none`. VCM checks the required accepted
artifact:

- Code Change and standalone Architect Debug require accepted Final Acceptance.
- Implemented Architecture Diagnosis requires accepted Final Acceptance;
  analysis-only diagnosis requires its completed diagnosis artifact.
- Docs Only requires a fresh synced or unchanged Docs Update Report from the
  latest assigned documentation role.
- Validation Only requires a terminal Test Report and resolved Validation
  Adequacy Gate.

Another flow may start after completion, but its first dispatch must name an
explicit `Requested Flow`. VCM starts a fresh flow run and does not reuse role
position or unchanged evidence from the completed flow, including when the new
flow has the same name.

## Recovery

Workflow Progress is the append-only durable task record. Pending dispatches
and override decisions live in task runtime state and survive a VCM restart
while the task worktree exists. Malformed runtime state fails closed and is
reported through project runtime state. Missing or inconsistent members of the
Workflow Progress/runtime-state pair fail closed. When only runtime state is
missing from a confirmed history, VCM reconstructs a conservative baseline so
existing artifacts and Gate records must be produced again before advancing.
Route failure before target acceptance does not create false history.

An active task created by an older VCM version receives the revision-zero
Workflow Progress template when the file is absent. An existing malformed file
is preserved unchanged and blocks dispatch with an exact warning.

`vcm-task-state` remains optional recovery and display context. It cannot grant
dispatch permission or mutate Workflow Progress.

## Verification

Unit and backend E2E coverage verifies:

- strict parsing, append-only history, revision checks, and stale-state rejection
- legal and illegal flow transitions
- completed-flow restarts, same-flow restarts, top-level switches, nested Debug
  and Diagnosis branches, and parent-flow restoration
- one-time exact user override binding
- one-time user-approved post-validation Tester work without an override, with stale Gate rejection afterward
- strict docs-sync correction owner/evidence and owner-specific return paths
- route denial without approval and target mismatch rejection
- claim before terminal submission, release on failure, and confirmation only
  from the matching target `UserPromptSubmit`
- transaction replay after interrupted proposal or confirmation writes
- restart recovery of unconfirmed dispatches without duplicate history
- missing/inconsistent state fail-closed and conservative baseline reconstruction
- fresh exception Gate enforcement and identical-content artifact resubmission
- repeated user wording bound independently to separate transitions
- end-to-end PM approval, route delivery, Hook confirmation, history append,
  and approval cleanup
