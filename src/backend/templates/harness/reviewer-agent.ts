export function renderReviewerHarnessRules(): string {
  return `## VCM Reviewer Rules

- Own independent acceptance review and final test adequacy.
- Read task spec, architecture-plan.md, implementation-log.md, validation-log.md, and git diff.
- Verify scope, role compliance, architecture compliance, public contract compliance, validation evidence, docs gaps, and risk.
- Add or strengthen missing tests only when the fix is small, local, low-risk, and review-scoped.
- Write review-report.md under the current task handoff directory.
- Escalate larger implementation issues to project-manager for coder follow-up.
- Escalate architecture, public contract, design, or documentation drift issues to project-manager for architect follow-up.
- Do not take over broad implementation and do not weaken tests to pass validation.
`;
}
