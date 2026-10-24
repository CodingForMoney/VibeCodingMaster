# Harness Evaluation Loop

Last updated: 2026-10-24

Status: approved direction, not yet implemented

## Goal

Make the Task Harness Retrospective drive a full feedback loop: every
harness rule change is based on measured task evidence, names the outcome it is
expected to improve, and is verified against later tasks so ineffective rules
can be removed instead of accumulating.

## Current Gaps

The retrospective carries two mechanisms with very different maturity. Auto
Memory Review has a structured decision set, backend validation, a commit
boundary, history, and revert. The harness-improvement half does not:

- Coverage bias: a retrospective starts only after a code-change flow reaches
  `accepted` or `accepted-with-known-risks`. Failed, abandoned, or heavily
  reworked tasks, which expose the most harness problems, are never analyzed.
  Docs-only and validation-only flows are never analyzed.
- Single-task scope: Harness Engineer sees one task at a time and cannot tell a
  one-off mistake from a recurring problem, although earlier retrospective
  reports already exist under `.ai/vcm/harness-feedback/task-retrospectives/`.
- Unstructured evidence: the prompt only invites inspection of the worktree.
  Handoffs are current snapshots, so intermediate states are gone; the task
  usage report is not referenced; retries, manual interventions, and per-role
  durations have no structured source.
- No adoption path: `Recommended Harness Changes` is free-form Markdown. The
  backend checks only section headings, the frontend does not surface the
  report, and nothing records whether a recommendation was accepted, applied,
  or effective.
- Add-only rules: the retrospective proposes additions but never identifies
  existing rules that had no effect, which is the structural cause of large
  role prompts.

## Design

The loop has four layers. Measurement and verification are backend code;
diagnosis is the only model-owned layer.

### 1. Measure (backend, no model)

At task close, for every outcome (accepted, failed, abandoned), the backend
writes one structured task record to the base repository so it survives
worktree removal. The record aggregates data VCM already holds:

- flow, branches entered, total dispatches, and dispatches per role
  (Workflow Progress history);
- Gate results and attempts until approval (Gate Review index and requests);
- StopFailure retries, manual interventions by type (Confirm Executed,
  Restart With Context, Gate retry/skip/override, Mark All Done), and user
  questions (workflow control and message records);
- tokens and estimated cost per role and model (task usage analytics);
- wall time and active time per role (Round/Turn state).

### 2. Diagnose (Harness Engineer)

The retrospective prompt receives the current task record, the most recent N
task records, and unresolved findings from earlier retrospectives. Retrospectives
also run for failed and abandoned tasks, which take priority over accepted ones.

### 3. Prescribe (structured output)

Following the Auto Memory Review contract, Harness Engineer writes a
machine-readable recommendation set. Each recommendation contains:

- recommendation ID;
- target file and rule;
- change type: add, update, remove, or move to code enforcement;
- evidence task IDs;
- target metric and expected direction, for example "fewer Coder to
  Architect Debug branches".

The backend validates the structure. An added rule without a target metric is
invalid. Removal and move-to-code-enforcement recommendations are explicitly
in scope.

### 4. Adopt and verify (backend)

- Harness Studio lists recommendations; the user accepts or rejects each one.
- An accepted recommendation is applied and committed by Harness Engineer,
  reusing the memory commit-boundary and revert mechanics.
- The applied rule is tagged with its recommendation ID.
- After K further tasks, the backend compares the target metric before and
  after adoption. A rule whose metric did not improve produces a removal
  recommendation.

## Rollout

1. Layer 1 task records, and layer 2 inputs (task records, recent history,
   unresolved findings, failed and abandoned task triggers). Code-only and low
   cost; improves current retrospective quality immediately.
2. Layers 3 and 4 after enough task records exist to make before/after
   comparison meaningful.
3. Optional controlled benchmark: a fixed task set on `example/rust-layered`,
   run when comparing two harness or model-tier configurations.

## Open Questions

- Values of N (history window) and K (verification window), and the minimum
  sample size before a metric comparison is trusted.
- Where task records live: the base repository `.ai/vcm/` (local, gitignored)
  or `vcmDataDir` (survives repository re-clone).
- Whether failed or abandoned task retrospectives run automatically or only on
  user request, given their token cost.

## Related

- `docs/known-issues.md` KI-016 (worker model tiers), whose cost assumptions this
  loop can measure.
- `docs/ARCHITECTURE.md` Auto Memory Ownership, whose structured review contract
  layer 3 reuses.
