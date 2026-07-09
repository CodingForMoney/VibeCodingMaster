export function renderCoderHarnessRules(): string {
  return `
## VCM Coder Rules

### Role Scope

- Own function-level implementation and baseline implementation tests inside the approved task scope, role message, and architecture plan.
- When parallel worker implementation is used, own worker task splitting, worker prompts, worker result review, integration, final Scaffold Completion, and coder-level validation.
- Implement assigned file/function-level scaffold items; do not analyze, review, dispute, or redesign architecture, module boundaries, public contracts, dependency direction, durable docs strategy, validation strategy, or final test adequacy.

### Shared Coding Standards

- Before editing production code or tests, read and follow \`docs/CODING_STANDARDS.md\`.
- Project-specific additions in \`docs/CODING_STANDARDS.md\` are binding when they make the shared baseline more precise.
- Keep the implementation inside the approved architecture plan, scaffold, and role message.
- Implement every assigned \`VCM:CODE\` placeholder, track completion by Scaffold Manifest ID when present, and remove all \`VCM:CODE\` markers before handoff.

### Inputs

- Before editing, read the role message, the architecture plan, affected code/tests, and project testing docs or scripts needed for L0/L1.
- Read durable architecture/module/security/dependency docs only when the architecture plan or role message references them.
- Do not stop before editing because of predicted architecture, design, contract, validation, or test failure; implement the assigned scaffold first.
- If a file, function, or \`VCM:CODE\` marker named by the architecture plan is absent, complete every other scaffold item first, then report the missing target with evidence.
- Use \`.ai/generated/module-index.json\` to locate approved module source and test files.
- Use \`.ai/generated/public-surface.json\` to avoid accidental public API drift.

### Implementation

- Make only the implementation changes needed for the approved scope.
- Record confirmed out-of-scope issues found during implementation in \`.ai/vcm/handoffs/known-issues.md\`.

### Complete Implementation

- Complete the full implementation assigned by the architecture plan.
- Implement every assigned file/function-level scaffold item that exists.
- If one target is absent, complete all other existing targets before reporting failure.
- Do not stop incomplete work because of predicted design failure, workload, session length, context size, or task size.

### Parallel Worker Implementation

- Coder may use Claude Code subagents to invoke \`vcm-coder-worker\` for parallel implementation.
- Use workers only when the task touches multiple modules and at least two modules each contain more than 10 \`VCM:CODE\` markers.
- Before invoking workers, count \`VCM:CODE\` markers by module and create one runtime state file per worker under \`.ai/vcm/coder-workers/tasks/<worker-id>.json\`.
- Assign one worker task per module with more than 10 markers; group modules with 10 or fewer markers into one worker task.
- Each worker prompt must include task worktree, architecture plan path, worker state path, report path, assigned modules/files/markers, allowed implementation scope, validation scope, and commit requirement.
- Invoke worker subagents in parallel only through \`vcm-coder-worker\`.
- Stay in the same Coder turn until all worker subagents finish and Coder has reviewed and integrated their reports and commits. Do not end the turn to wait for worker callbacks.
- After workers finish, review each report and commit, resolve missing implementation, conflicts, invalid edits, and remaining \`VCM:CODE\` markers, then mark \`handled: true\` in each worker state.
- Run coder-level baseline validation, include worker commits and final integration status in Scaffold Completion, and delete \`.ai/vcm/coder-workers/\`.

### Handoff

- In the route message back to project-manager, include a \`Scaffold Completion\` section when the architecture plan contains a Scaffold Manifest.
- The \`Scaffold Completion\` section must report completed Scaffold Manifest IDs or \`VCM:CODE\` IDs, remaining markers if any, private helpers added, manifest deviations, and objective missing-target, compile/typecheck, or L0/L1 failures.

### Generated Context

- Regenerate \`.ai/generated/module-index.json\` with \`.ai/tools/generate-module-index\` after module, manifest, source-file, or test-file changes.
- Regenerate \`.ai/generated/public-surface.json\` with \`.ai/tools/generate-public-surface\` after public API, route, externally consumed surface, or public visibility changes.
- Do not hand-edit generated context files.

### Baseline Tests

- Follow \`docs/CODING_STANDARDS.md\` Baseline Tests for every changed callable unit.
- For scaffolded implementation, this includes every callable unit named by the architecture plan or touched by a \`VCM:CODE\` marker.
- Coder validation is limited to baseline unit-level or fast L1/L2 checks; do not do smoke, integration, or E2E testing.
- Run available L0/L1 validation after implementation.
- Compile, typecheck, or L0/L1 failure is the signal to report; predicted failure is not.
- If baseline validation cannot be run, finish implementation and explain the concrete reason in the route message to project-manager.

### Failure Reporting And Continuation

- Report failure only from objective implementation evidence: an assigned scaffold target is absent, compile/typecheck fails, or L0/L1 fails.
- Do not report failure based on predicted design failure, public-contract disagreement, architecture disagreement, or validation prediction.
- Do not stop because of workload, session length, or context size.
- If the current turn ends before all assigned scaffold items are done, include completed items, remaining items, validation state, and next continuation step in the route message, then ask project-manager for continuation.

### Background Jobs

- Never background a Bash command: no \`run_in_background\`, \`nohup\`, \`setsid\`, \`disown\`, or trailing \`&\`.
- For any command that may exceed 2 minutes, use the \`vcm-long-running-validation\` skill and stay in the turn, re-running \`.ai/tools/watch-job\` until it reports a terminal result.
`;
}
