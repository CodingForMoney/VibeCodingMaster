const PROJECT_CODING_STANDARDS_RULES = `This file is the shared project baseline for roles that edit production code or tests.

Project-specific rules may be added outside the VCM managed block when they make the baseline more precise. Do not weaken these baseline rules without explicit user approval for the exact exception.

## Applies To

- Coder and Coder Worker implementation.
- Architect Debug Mode and Architecture Diagnosis Mode when they edit production code or tests.
- Tester changes to tests, fixtures, and test-only helpers, plus test-integrity review.

## Implementation Discipline

- Coder and Coder Worker follow the accepted task scope, role message, architecture plan, and scaffold. Architect Debug Mode and Architecture Diagnosis Mode follow their confirmed root cause and PM-routed evidence.
- Coder and Coder Worker must not change file responsibilities, callable-surface signatures, visibility, exports, contracts, or architect-defined intent unless the approved plan allows it. In Debug Mode or Architecture Diagnosis Mode, Architect may change file responsibilities and callable surfaces after confirming the root cause, and must update affected callers, contracts, and tests.
- Remove each \`VCM:CODE\` marker when its item completes successfully. If implementation fails after a genuine attempt, keep the failed item's marker on the committed attempt and report the objective failure evidence. A successful implementation handoff must not contain remaining assigned markers.
- Do not fake completion: no hardcoded success, disabled logic, swallowed errors, test-only shortcuts, or silent fallback that hides failure.
- Implement behavior from the approved architecture, existing domain model, real inputs, and project runtime flow.
- Do not derive logic from visible test fixtures, fixed sample values, snapshot text, or special branches that only satisfy known tests.
- Coder and Coder Worker keep the diff inside the approved plan. In Debug Mode or Architecture Diagnosis Mode, Architect owns the technical change boundary after confirming the root cause.
- Preserve existing behavior unless the approved plan or a confirmed Debug/Diagnosis root cause changes it.

## Comments

- Preserve durable contract comments written by Architect.
- Keep comments consistent with changed behavior.
- Add source comments only for durable behavior, contracts, invariants, error boundaries, or non-obvious logic that cannot be made clear enough through naming, types, constants, or small helper functions.
- Do not copy task context, task labels, implementation-order notes, handoff instructions, temporary rationale, or coder guidance into source comments.
- Remove stale, debug, task-process, task-label, and unresolved TODO comments unless a TODO is durable, still accurate, and linked to an owner, issue, or accepted follow-up.
- Task labels such as \`RP<n>\`, \`SCF-<n>\`, \`KI-<n>\`, \`Phase <n>\`, or temporary task/round/PR labels must not appear in durable source comments.

## General Coding Standards

- Do not use magic values; name unexplained numbers, strings, states, commands, roles, event names, error codes, and protocol values with constants, enums, or domain types.
- Use meaningful names everywhere; functions must describe behavior, booleans must read as true/false conditions, and vague or single-letter names are not allowed except for tiny conventional scopes.
- Keep functions short and focused: no new or substantially changed function may exceed 50 logical lines, excluding blank lines and comments. Split longer logic into well-named private helpers.
- Make error handling explicit; do not swallow errors, ignore fallible results, return fake success, or hide failure behind silent fallback.
- Validate boundary inputs before using them in indexing, parsing, IO, network calls, database calls, state transitions, or external process calls.
- Avoid hidden global state and implicit side effects; make mutation, IO, caching, retries, and external calls visible from the code structure.
- Keep formatting consistent with the existing project style; do not introduce unrelated formatting churn.

## Baseline Tests

- Do not weaken, delete, or skip tests to make validation pass.
- When changing tests, keep assertions tied to the approved behavior contract; do not relax expectations, remove meaningful coverage, or rewrite tests merely to match the current implementation.
- Unit test coverage is required for every changed callable unit.
- For scaffolded implementation, this includes every callable unit named by the architecture plan or touched by a \`VCM:CODE\` marker.
- A callable unit means a function, method, handler, command action, route handler, hook callback, reducer, parser, validator, state transition function, or service API function.
- If the changed callable unit is private, test it through the nearest existing public/exported/module-level callable unit that owns that behavior. Do not expose private helpers only for tests.
- For each changed callable unit, add at least one success-path unit test.
- For each changed validation, parsing, branching, error-handling, boundary, permission, lifecycle, retry, or state-transition path inside that callable unit, add a unit test that exercises that path.
- Pure private helpers added only to support an already-tested callable unit do not need separate direct tests.
- If baseline validation cannot be run, finish the implementation work and report the concrete reason.

## Generated Context

- Regenerate \`.ai/generated/module-index.json\` with \`.ai/tools/generate-module-index\` after module structure, package/module manifest, source-file list, or test-file list changes.
- Regenerate \`.ai/generated/public-surface.json\` with \`.ai/tools/generate-public-surface\` after public API, route, externally consumed surface, or public visibility changes.
- Do not hand-edit generated context files.
`;

export function renderProjectCodingStandardsRules(): string {
  return PROJECT_CODING_STANDARDS_RULES;
}

export function renderProjectCodingStandardsProjectSection(): string {
  return `## Project Coding Standards

No project-specific standards recorded yet.`;
}

export function renderLegacyProjectCodingStandardsTemplate(): string {
  return `# Coding Standards

${PROJECT_CODING_STANDARDS_RULES
  .replace(
    "Project-specific rules may be added outside the VCM managed block when they make the baseline more precise.",
    "Project-specific rules may be added here when they make the baseline more precise."
  )}`;
}
