# Architect Context Optimization Plan

Status: temporary implementation plan. Delete this document after the feature is implemented and the durable documentation is updated.

## Objective

Reduce Architect token usage without weakening architecture quality.

- Keep code-reality analysis, user confirmation, architecture decisions, Gate corrections, Debug, Architecture Diagnosis, and documentation work on Fable.
- Preserve reusable task knowledge as reviewed artifacts instead of relying on the Architect conversation transcript.
- Delegate mechanical scaffold execution to a dedicated SubAgent with an independent, smaller context.
- Restart Architect after completed planning so later work starts from the reviewed artifacts instead of the interview, exploration, and planning conversation history.
- Keep the existing VCM Code-Change Flow and role ownership unchanged.

## Flow Compatibility

The external Code-Change Flow remains:

```text
Architect Interview
-> Architect planning
-> architecture-plan Gate
-> Coder implementation
-> code-diff Gate
-> Tester validation
-> validation-adequacy Gate
-> Architect docs sync
-> Final Acceptance
```

The change refines the existing Architect Interview and Architect planning work. It does not add another PM-visible workflow node.

```text
Architect Interview and Evidence (Fable)
-> Architecture Design and Plan (Fable)
-> Scaffold Execution (SubAgent)
-> Scaffold Review and Planning Completion (Fable)
-> report complete planning result to PM
-> deferred Architect restart
-> existing architecture-plan Gate
```

## Stage 1: Architecture Interview And Evidence

Architect uses Fable and the existing Architect session.

Responsibilities:

- Define the affected feature or module boundary.
- Read the relevant project documents and current-worktree code.
- Trace the affected entry points, project-owned calls, state, lifecycle, failure paths, side effects, callers, and consumers.
- Record contradictions between code, comments, generated context, and durable documents.
- Confirm user-owned behavior and contract decisions through Architect Interview.

Outputs:

- `.ai/vcm/handoffs/architecture-brief.md`
- `.ai/vcm/handoffs/architecture-evidence.md`

`architecture-evidence.md` is a reusable evidence artifact, not a transcript or tool log. It records:

- the feature or module boundary
- the inspected files and symbols
- verified behavior and call paths
- ownership, state, lifecycle, and failure-path evidence
- relevant callers and consumers
- external boundaries and their observed contracts
- code/document contradictions and unresolved evidence
- the source commit and worktree state used for the analysis

Do not copy source files, shell output, user conversation, or exploratory reasoning into the evidence artifact.

Stage 1 is complete only when the brief is confirmed and the evidence needed for architecture decisions is recorded. It does not produce the architecture decision, plan, or scaffold.

## Stage 2: Architecture Design And Plan

Architect continues with Fable in the existing session so the code reading and user decisions remain available through normal context and prompt caching.

Inputs:

- confirmed `architecture-brief.md`
- `architecture-evidence.md`
- current worktree and generated project context
- applicable durable architecture and project documents

Responsibilities:

- Verify that the evidence still matches the current worktree.
- Resolve ownership, data flow, lifecycle, boundaries, invariants, failure behavior, dependency direction, and public-surface impact.
- Write the complete current-task implementation plan.
- Produce the complete Scaffold Manifest.
- Keep `architecture-plan.md` as the current executable plan rather than a history of discarded decisions.

Output:

- `.ai/vcm/handoffs/architecture-plan.md`

Stage 2 does not repeat Stage 1 exploration when its evidence remains current. Architect re-reads code when evidence is missing, stale, contradicted, or insufficient for a design decision.

## Scaffold Execution SubAgent

Add a project SubAgent dedicated to mechanical scaffold execution.

Proposed definition:

- name: `vcm-architect-scaffold-worker`
- scope: project harness under `.claude/agents/`
- model: Opus
- effort: xhigh
- tools: only the file, search, shell, and editing tools required for scaffold work
- execution: foreground only
- working directory: the active task worktree

Architect receives the `Agent` tool and explicitly invokes this worker in the foreground. Architect must wait for it to finish in the current turn.

The worker receives only:

- active task worktree path
- `architecture-brief.md`
- `architecture-evidence.md`
- `architecture-plan.md`
- exact Scaffold Manifest IDs, files, symbols, and required surfaces
- `docs/CODING_STANDARDS.md`
- required scaffold ledger, L0, and commit expectations

The worker may:

- create the exact planned files, modules, signatures, contracts, configuration, and placeholders
- place the exact planned `VCM:CODE` markers
- materialize the planned wired exemplar
- run the required scaffold ledger and L0 checks

The worker must not:

- make architecture decisions
- change accepted behavior, ownership, lifecycle, boundaries, dependency direction, public contracts, or plan scope
- add, remove, merge, or reinterpret Scaffold Manifest items
- replace missing design information with its own design

When execution exposes missing or contradictory design information, the worker reports the exact evidence to Architect. Architect resolves it with Fable before scaffold completion.

Use one scaffold worker. Scaffold work can touch shared public surfaces, build configuration, and cross-module wiring, so parallel scaffold commits are not part of this design.

The worker is not a VCM workflow role. Its lifecycle does not update the VCM Round or role routing state. The parent Architect remains the active workflow role for the whole turn.

## Architect Scaffold Review

The SubAgent does not own the planning result. After it finishes, Architect must use Fable to inspect:

- every changed file against the plan
- callable surfaces and durable contract comments
- Scaffold Manifest and `VCM:CODE` marker equality
- cross-module wiring and build configuration
- L0 and scaffold build evidence
- the final scaffold commit and worktree state

Architect may correct scaffold execution directly. Architect reports `Planning Result: complete` only after the existing plan and scaffold completion contract is satisfied.

## Deferred Architect Restart

### Skill And Tool

Add:

- `.claude/skills/restart-architect/SKILL.md`
- `.ai/tools/request-architect-restart`
- a backend endpoint that schedules an Architect restart after completed planning

The Skill is valid only for Architect immediately before reporting `Planning Result: complete` to PM.

Required Architect sequence:

1. Complete and review the plan, scaffold, L0 evidence, and scaffold commit.
2. Call `restart-architect`.
3. Write the complete planning result to the Architect-to-PM route file.
4. End the turn immediately under the existing `vcm-route-message` rule.

The Skill does not restart the active Session and does not wait for Architect to become idle. It calls the backend scheduling endpoint and returns immediately.

### Backend Scheduling

The endpoint records one pending Architect restart bound to:

- the active task
- the current Architect terminal Session
- the current planning completion request

Scheduling is idempotent. Repeated requests from the same Architect Session create one pending restart.

The pending restart executes only when:

- the same Architect Session reaches a normal Stop Hook
- the Session has been recorded as idle
- the Architect-to-PM route message has been delivered successfully
- `architecture-plan.md` still declares `Planning Result: complete`

Do not execute the pending restart for:

- `Planning Result: incomplete`
- `Planning Result: user clarification required`
- StopFailure or interrupted turns
- failed or cancelled route delivery
- a different or replaced Architect Session
- a closed task

The existing immediate role restart endpoint remains unchanged. The new endpoint schedules use of that restart operation after the completion conditions are satisfied.

### Hook And Route Ordering

The backend owns all waiting and coordination. No HTTP request, Skill, shell process, or Architect turn waits for idle state.

```text
Architect schedules restart
-> Architect writes complete result route
-> Architect Stop Hook
-> backend records Architect idle
-> backend confirms route delivery to PM
-> backend restarts Architect
-> backend clears pending restart
```

Because the new Architect Session starts without an immediate user message, restarting it does not create another Architect Turn and does not compete with PM or Gate Reviewer activity.

## New Session Context Restoration

Claude Code supports an interactive initial prompt and appended system-prompt instructions. This design uses `--append-system-prompt` for the restarted Architect Session.

Do not use a positional initial prompt such as `claude "..."`. It would immediately submit a user message, trigger role hooks, and create an additional Architect Turn.

Append a short restoration instruction to the restarted Session:

```text
This Architect session continues the current task after completed architecture planning.

Before performing any assigned work, read:
- .ai/vcm/handoffs/architecture-brief.md
- .ai/vcm/handoffs/architecture-evidence.md
- .ai/vcm/handoffs/architecture-plan.md
- the current scaffold commit and worktree state
- the latest Gate Review report when present

Treat the current artifacts and worktree as the source of truth. Do not repeat the completed interview or planning work unless current evidence contradicts them.
```

Inject only the instruction and artifact paths. Do not inject the artifact contents into the system prompt. Architect reads the latest files when its next assigned turn begins.

The restoration instruction applies only to the newly restarted Architect Session. Normal role starts and other roles are unchanged.

## Model Policy

- Stage 1 Architecture Interview and Evidence: Fable
- Stage 2 Architecture Design and Plan: Fable
- Scaffold Execution SubAgent: Opus with xhigh effort
- Parent Architect scaffold review: Fable
- Architecture Gate corrections: Fable
- Architect Debug Mode: Fable
- Architecture Diagnosis Mode: Fable
- Architect docs sync: Fable
- Gate Reviewer: Fable

Coder, Tester, PM, Translator, and Harness Engineer model behavior is outside this change.

## Gate Review Integration

The architecture-plan Gate must review the actual Stage 1 and Stage 2 artifacts plus the real scaffold.

Add `.ai/vcm/handoffs/architecture-evidence.md` to:

- architecture-plan Gate source artifacts
- architecture-plan Gate input hash
- Gate Reviewer architecture-plan instructions

Changing `architecture-evidence.md` must invalidate a previously approved architecture-plan Gate result.

The architecture-plan Gate continues to review the complete final plan and scaffold. Staging does not permit partial Gate approval.

If the Gate returns `request_changes`, the restarted Fable Architect reads:

- brief
- architecture evidence
- current architecture plan
- actual scaffold and current worktree
- complete Gate report

Architect revises the affected design and scaffold, then the existing full architecture-plan Gate runs again.

## Failure And Recovery

- If scheduling fails, Architect must not report successful scheduling. It may retry the Skill before writing the complete route message.
- If the complete route is not delivered, keep the current Architect Session and do not restart it.
- If Restart fails after route delivery, preserve the delivered planning result, expose the precise runtime error, and ensure the next Architect dispatch starts a fresh Fable Session with the restoration instruction.
- If VCM restarts while a restart request is pending, stale pending restart state may be discarded. Normal VCM Session recovery applies; correctness does not depend on this context optimization.
- Closing the task clears any pending Architect restart.

## Harness Changes

Update the fixed harness and every synchronized example copy together:

- Architect role definition
- `restart-architect` Skill
- `request-architect-restart` tool
- `vcm-route-message` ordering where necessary
- Gate Reviewer architecture-plan input rules
- harness manifest and installer templates

Architect rules must state:

- Stage 1 and Stage 2 outputs and boundaries
- foreground scaffold worker invocation
- Architect ownership of scaffold review and planning completion
- mandatory restart scheduling before a complete planning result route

## Backend Changes

- Extend Claude launch command construction with an optional appended system prompt used only for this restart path.
- Add the schedule-restart endpoint and service operation.
- Track one pending Architect restart per active task and Architect Session.
- Integrate pending restart evaluation with normal Stop Hook processing and successful route delivery.
- Reuse the existing immediate Architect restart implementation after conditions pass.
- Clear pending state on success, cancellation, task close, Session replacement, and invalid completion.
- Add `architecture-evidence.md` to architecture-plan Gate hashing and prompt inputs.

## Tests

Add backend unit and mock-Claude E2E coverage for:

- Stage 1 and Stage 2 artifacts are required before complete planning.
- Scaffold worker remains inside the Architect turn and does not create a VCM role transition.
- Scheduling does not stop or restart the active Architect Session immediately.
- A normal Architect Stop plus successful complete-result delivery restarts Architect exactly once.
- Duplicate scheduling is idempotent.
- Incomplete planning, user clarification, StopFailure, interruption, delivery failure, Session replacement, and task close do not restart Architect.
- Restarted Architect uses Fable and preserves the selected permission and effort configuration.
- Restart launch includes `--append-system-prompt` and no positional initial prompt.
- Restart initialization does not produce an extra UserPromptSubmit or workflow Turn.
- Restart failure preserves the PM result and is recoverable on the next Architect dispatch.
- Changing `architecture-evidence.md` changes the architecture-plan Gate input hash.
- Gate `request_changes` routes to the fresh Architect Session and the complete Gate runs again.
- Docs sync continues to use the fresh Fable Architect Session.

## Confirmed Decisions

- The existing PM-visible Code-Change Flow remains unchanged.
- Code reality and user confirmation are preserved as Stage 1 artifacts.
- Architecture design and the complete plan are preserved as Stage 2 artifacts.
- Scaffold execution uses a dedicated foreground SubAgent with independent context.
- The parent Architect remains responsible for the final scaffold and planning result.
- Architect restarts only after complete planning is delivered and the old Session is idle.
- The restarted Session restores context from artifact paths instead of conversation history.
- Later Gate corrections, Debug, Diagnosis, and documentation work use Fable.
- Documentation work is not downgraded to a cheaper model.

## Final Review Decision

The Scaffold SubAgent uses Opus with xhigh effort. All model boundaries and workflow behavior are defined above.
