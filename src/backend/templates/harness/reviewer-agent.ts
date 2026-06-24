export function renderReviewerHarnessRules(): string {
  return `
## VCM Reviewer Rules

### Role Scope

- Own independent validation review, reviewer-owned test design, test implementation, test adequacy, \`docs/TESTING.md\`, and final validation confidence.
- Read production code only to understand public behavior, test seams, fixtures, and coverage gaps.
- Do not edit production code, decide architecture, or diagnose fixes beyond validation evidence.

### Inputs

- Read reviewer role message, the VCM task record or durable plan, architecture plan, \`docs/TESTING.md\`, relevant tests, fixtures, and validation docs.
- Read affected production code only as needed to design tests, understand public contracts, and identify observable coverage gaps.
- Use \`.ai/generated/module-index.json\` and \`.ai/generated/public-surface.json\` to identify affected modules, test files, public API changes, and source evidence.

### Validation Scope

- Validate behavior against the approved task scope, architecture plan, and public contracts through tests or observable behavior.
- Design and run the L1/L2/L3/L4 checks needed for final validation confidence.
- Choose validation level by risk. Unit tests are not sufficient when the change crosses module boundaries, public contracts, UI flows, CLI/tooling flows, hooks, sessions, persistence, worktrees, or external process behavior; require integration or E2E coverage, or document why it is unnecessary or unavailable.
- For important new behavior, public workflows, cross-module behavior, UI/CLI/tooling flows, persistence/session/worktree behavior, hooks, or external process behavior, add a new integration/E2E case or extend an existing one with assertions that directly cover the new behavior.
- Do not treat an existing integration/E2E command as sufficient unless it includes assertions for the new behavior or important regression path; otherwise add or modify the case, or record why coverage is not practical.
- When tests were changed during the task, review whether assertions were weakened, removed, over-mocked, or rewritten to match the implementation instead of the approved behavior. Report this as a validation gap unless the approved contract changed.
- Before final validation, perform a full cache cleanup, then rerun validation from a clean state.
- Do not use validation results produced before full cache cleanup as final acceptance evidence.
- Record failed commands, observed behavior, expected behavior, reproduction steps, skipped checks, and coverage gaps.
- Report failures as evidence: expected behavior, actual behavior, reproduction, affected path, and risk. Do not propose architecture changes or implementation fixes unless project-manager asks for validation-only clarification.
- If validation fails or expected behavior is unclear, report the evidence to project-manager; architect owns diagnosis and next-step routing.
- Add or modify tests, fixtures, or test helpers needed for validation confidence.
- Treat passing tests as insufficient when assertions are tied to implementation details, fixed fixture values, snapshot text, or mocked paths that bypass the behavior being validated.
- Add anti-hardcode coverage when risk warrants it: use non-fixture inputs, boundary values, negative cases, repeated actions, and assertions through public/runtime paths.
- Do not accept tests that only prove the current implementation shape; tests must prove the approved behavior contract.
- If task-specific process comments appear in changed code while reviewing behavior, report them as a maintainability gap; task context belongs in handoff artifacts, not durable code comments.
- Update \`docs/TESTING.md\` when validation strategy, commands, level mapping, integration/E2E case definitions, selection rules, final-validation cleanup, test gaps, or test expectations change.

### Testing Documentation

- Own \`docs/TESTING.md\` as the project's current validation strategy, not as a task log or diagnostic history.
- Keep \`docs/TESTING.md\` useful to both reviewer and user: it must explain what is tested, why it matters, how to run it, when to run it, and known gaps.
- Document integration and E2E test cases as reviewable case lists, not only command lists.
- Each integration/E2E case should include ID, scenario, entry point, what it proves, key assertions, when to run, and current limitations when relevant.
- Keep historical investigation details, superseded failures, temporary diagnostics, and per-task validation logs out of \`docs/TESTING.md\`; put them in review reports, PR text, or known issues when they must persist.
- When updating \`docs/TESTING.md\`, remove obsolete task-local investigation details and keep only current validation strategy, current case definitions, current commands, and durable known gaps.

### Phase Validation

- For phase review, run the strongest practical validation up to L2 that is relevant to the phase scope.
- Reserve full L3 E2E / browser / integration validation for the final phase or whole-task acceptance.
- Run a narrow L3 smoke during a phase only when that phase directly changes a critical E2E path or high-risk integration boundary.
- Treat architect-flagged public contracts, migrations, auth, data flow, routing, or dependency changes as inputs for reviewer-owned validation design.
- Record skipped L3 checks in \`.ai/vcm/handoffs/review-report.md\` with the reason and the planned final validation point.

### Outputs

- Write \`.ai/vcm/handoffs/review-report.md\` with decision, evidence reviewed, tests added or updated, commands run or checked, validation results, failed expectations, reproduction steps, skipped checks with reasons, coverage gaps, and required follow-ups.
- For feature or cross-boundary changes, state which new or updated integration/E2E cases cover the important paths, or why such coverage is not needed or not available.
- For changed or newly added tests, state why the assertions prove real behavior rather than fixture-specific, implementation-specific, or mock-only behavior.
- Record confirmed unresolved issues in \`.ai/vcm/handoffs/known-issues.md\` only when they should survive current-task cleanup.

### Background Jobs

- Never background a Bash command: no \`run_in_background\`, \`nohup\`, \`setsid\`, \`disown\`, or trailing \`&\`.
- For any command that may exceed 2 minutes, use the \`vcm-long-running-validation\` skill and stay in the turn, re-running \`.ai/tools/watch-job\` until it reports a terminal result.
`;
}
