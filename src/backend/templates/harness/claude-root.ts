export function renderRootClaudeHarnessRules(): string {
  return `## VCM Start Here

- Use the durable project docs below as role-relevant project truth.
- Read module-local \`CLAUDE.md\` before editing a subdirectory if one exists.

## VCM Durable Project Docs

- \`docs/ARCHITECTURE.md\`: project-level module overview, module responsibilities, module relationships, dependency direction, project-wide architecture constraints, and links to module-level architecture docs; architect-owned.
- \`<module>/ARCHITECTURE.md\`: module-level detailed design, boundaries, behavior, important public surface explanations, internal risks, and module-specific architecture notes; architect-owned.
- \`docs/TESTING.md\`: validation strategy, commands, validation levels, and known testing gaps; reviewer-owned.
- \`docs/known-issues.md\`: durable known issues and accepted limitations; architect-owned.
- \`.ai/generated/module-index.json\`: generated module index; use it to find layers, modules, manifests, module docs, source files, test files, and workspace dependencies.
- \`.ai/generated/public-surface.json\`: generated crate-external public API index; use it to inspect module-to-module public interfaces and source evidence.

## VCM Task Flow

- Code changes use the full route: \`project-manager -> architect -> coder -> reviewer -> architect docs sync -> project-manager final acceptance\`.
- Before code changes, architect must write a plan that covers changed files, file responsibilities, public interfaces or user-visible behavior, validation requirements, and Replan triggers.
- Docs-only changes may use: \`project-manager -> architect -> project-manager final acceptance\`.
- Test-only or validation-only work may use: \`project-manager -> reviewer -> project-manager final acceptance\`.
- If a docs/test/validation-only task reveals required code, architecture, public contract, dependency, durable-doc, or test-strategy changes, route back through the full code-change flow.
- Keep role outputs under \`.ai/vcm/handoffs/\`.
- Runtime task records and handoffs under \`.ai/vcm/\` are temporary. Durable facts must move into code, tests, PR text, commit history, or long-term docs.
- Record current-task unresolved findings in \`.ai/vcm/handoffs/known-issues.md\`.
- Use the \`vcm-route-message\` skill when writing or updating VCM role messages.
- Use the \`vcm-final-acceptance\` skill before declaring a VCM-managed task complete.

## VCM Validation Levels

- L0 fast checks: format, lint, typecheck, boundary, dependency, or other cheap project checks.
- L1 focused unit / contract checks: changed behavior, public function contracts, and direct regressions.
- L2 module / integration checks: module-level behavior, API contracts, service integration, persistence, or cross-file wiring.
- L3 smoke E2E checks: core user journeys or critical browser/API flows.
- L4 full regression / release checks are release-only unless explicitly requested.
- Coder normally runs baseline unit-level checks plus \`check-fast\`; reviewer decides final validation sufficiency and whether L2/L3 is required.

## VCM Worktree Policy

- Use one branch, one worktree, one handoff directory, and one PR or final patch per VCM-managed task.
- Roles work sequentially in the same task worktree.
- If \`git status\` shows uncommitted changes, commit them before handing off to another role.

`;
}
