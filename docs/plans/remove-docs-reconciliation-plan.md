# Remove Architect Docs Reconciliation

Last updated: 2026-10-26

Status: approved direction, not yet implemented

## Goal

Keep architecture docs current at the moment a design changes instead of in a
separate post-validation pass. Delivery flows return to
`validation-adequacy Gate -> code-diff Gate -> Final Acceptance`, and the
code-diff Gate remains the review that confirms the docs match the final code.

## Why Reconciliation Is Unnecessary

Docs drift from code only when the implementation departs from the planned
design. Every path that can change the design is already Architect-owned:

- Coder cannot change design. The scaffold freezes cross-file surfaces and
  contracts; Coder fills implementations only.
- Replan revises the plan and its doc changes together and returns through the
  architecture-plan Gate.
- Architect Debug and Architecture Diagnosis fixes are made by Architect, who
  can update the owning docs in the same fix commits.
- The code-diff Gate's Documentation Fit check confirms the docs describe the
  final code; a mismatch is a `docs-only` finding.

The separate reconciliation pass added a dispatch, a report, and a repeat after
every correction that returns through validation-adequacy, and it complicated
PM, skills, Workflow Control, and Coder and Tester rules.

## Current Gaps

- Delivery flows run `validation-adequacy -> Architect docs reconciliation ->
  code-diff`, with `docs-sync-report.md` required before code-diff.
- Completion requires a code-diff approval recorded after the final Architect
  dispatch.
- `check-docs-sync` validates the docs-sync report's Module Coverage and
  Reconciliation Commits, and Artifact Service rejects a failing report.
- User-approved Tester follow-up is checked before reconciliation, so its
  precondition differs from the code-diff-first order.
- A blocked docs-sync report routes correction owners, including Coder-owned
  documentation.

## Target Design

### Flow

- Code-Change, Architect Debug Flow, and code-producing Architecture Diagnosis
  Flow run `Tester validation -> validation-adequacy Gate -> code-diff Gate ->
  Final Acceptance`.
- Debug and Diagnosis Branches are unchanged: they run their own code-diff Gate
  and return to the parent resume point.
- A code-diff rejection whose findings are only `docs-only` routes to Architect
  to correct the docs, then reruns the code-diff Gate incrementally. Mixed
  `docs-only` and `test-only` findings route to Architect first. Any
  `implementation` finding keeps the existing Architect fix path.
- User-approved Tester follow-up returns to its original checkpoint: a passing
  Test Report with successful validation-adequacy and code-diff Gates.

### Architect Ownership Of Docs

- Architect writes the architecture doc changes during planning (unchanged).
- Any Replan, Architect Debug fix, or Architecture Diagnosis fix that changes a
  durable architecture fact updates the owning doc in the same commits.
- Active plans under `docs/plans/**` that the task completes are removed during
  planning, because the task branch merges only after implementation.
- Generated context keeps its existing owners: Coder regenerates after module or
  public-surface changes, and Architect does so in Debug and Diagnosis.
- Known issues are handled on demand. Final Acceptance already requires a
  known-issues disposition; when a promotion or removal is needed it returns
  `needs-architect-follow-up`, Architect updates `docs/known-issues.md`, and the
  code-diff Gate reviews that commit incrementally.

### Removed

- The Architect docs reconciliation dispatch and its PM branches (Docs Sync
  Correction and the reconciliation precondition on code-diff).
- `docs-sync-report.md` as a code-flow artifact, including Module Coverage,
  Reconciliation Commits, and Docs Sync Check, and the Artifact Service check on
  submission. `docs-update-report.md` for Docs-Only Flow is unchanged.
- The Final Acceptance decision `needs-docs-sync`; documentation follow-up uses
  `needs-architect-follow-up`.
- The completion rule that requires a code-diff approval after the final
  Architect dispatch, replaced by requiring a passed code-diff Gate for the
  flow (fresh after any later Architect follow-up dispatch).

### Mechanical Coverage Check

`check-docs-sync` stops reading a docs-sync report and checks the plan instead.
When the code-diff Gate is requested for a delivery flow, every module touched
by the task's commits must appear in `architecture-plan.md` Docs Impact, and
every document Docs Impact lists as changed must have changed in the task. A
failing check makes the request report `failed_to_start` with the findings. A
repository without a module index is still checked as one module `.` owned by
`docs/ARCHITECTURE.md`.

The validation-adequacy input hash keeps excluding `docs/**`, every
`ARCHITECTURE.md`, and `.ai/generated/**`, so doc commits from a docs-only
correction do not invalidate validation.

## Change Surface

- Root `CLAUDE.md` managed block, Project Manager, Architect, Coder, Tester, and
  Reviewer definitions; `vcm-gate-review`, `vcm-workflow-review`, and
  `vcm-final-acceptance` skills.
- Workflow Control transitions, completion validation, follow-up legality, and
  `docs-only` routing.
- Artifact registry, templates, and validation for `docs-sync-report` and the
  Final Acceptance decision list.
- `check-docs-sync`, `docs-sync-check.ts`, the code-diff request path, and the
  example harness.
- Unit, integration, and backend E2E tests; README, `docs/ARCHITECTURE.md`,
  `docs/TESTING.md`, and `docs/vcm-cc-best-practices.md`.

## Related

- `docs/plans/harness-instruction-layering-plan.md`: one authoritative home per
  rule, which this change also reduces the need for.
