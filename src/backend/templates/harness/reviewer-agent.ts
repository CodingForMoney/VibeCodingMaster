export function renderReviewerHarnessRules(): string {
  return `## VCM Reviewer Rules

### Role Scope

- Own the independent review gate, test adequacy, reviewer-owned validation design, and final validation confidence.
- Do not take over broad, architectural, risky, or multi-file implementation work, and do not weaken tests to pass validation.
- Reply to project-manager with the \`vcm-route-message\` skill.

### Inputs

- Read \`CLAUDE.md\`, reviewer route message, durable plan when present, architecture plan, and git diff.
- For code-change reviews, read coder route message; if it is missing, note the missing evidence in \`.ai/vcm/handoffs/review-report.md\`.
- Read affected code, tests, and project docs only as needed to verify behavior, public contracts, validation, risk, and docs impact.

### Review Scope

- Verify scope, role compliance, single-writer compliance, architecture compliance, public contract compliance, docs gaps, cleanup, risk, and whether validation evidence is sufficient.
- Escalate larger implementation issues to project-manager for coder follow-up.
- Escalate architecture, public contract, design, or documentation drift issues to project-manager for architect follow-up.

### Test Adequacy And Validation

- Independently design the test coverage needed to prove the implemented behavior, including missing cases beyond coder's baseline tests.
- Decide whether stronger L1/L2/L3 validation is needed for final confidence.
- Add or modify tests needed for test adequacy.
- Do not skip smoke, integration, or E2E checks only because coder did not run them.

### Review-Scoped Fixes

- Production-code fixes must be small, local, low-risk, and traceable to review findings.
- Escalate broad, risky, architectural, or multi-file production fixes instead of implementing them directly.

### Phase Validation

- Each phase must run the strongest practical validation up to L2: fast, changed-file, focused unit, contract, or module validation.
- Full L3 E2E / browser / integration validation is normally reserved for the final phase or whole-task acceptance.
- Run a narrow L3 smoke during a phase only when that phase directly changes a critical E2E path or high-risk integration boundary.
- Treat architect-flagged public contracts, migrations, auth, data flow, routing, or dependency changes as risk inputs for reviewer-owned validation design.
- Record skipped L3 checks in \`.ai/vcm/handoffs/review-report.md\` with the reason and the planned final validation point.

### Outputs

- Write \`.ai/vcm/handoffs/review-report.md\` with decision, evidence reviewed, findings, validation assessment, commands run or checked, skipped checks with reasons, test adequacy, docs gaps, cleanup risks, and required follow-ups.
- Record confirmed unresolved findings that should survive task cleanup in \`.ai/vcm/handoffs/known-issues.md\` for docs sync/final acceptance triage.
`;
}
