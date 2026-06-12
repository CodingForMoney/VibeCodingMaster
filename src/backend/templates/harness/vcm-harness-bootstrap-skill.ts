export function renderVcmHarnessBootstrapSkillRules(): string {
  return `## Purpose

Use this skill when VCM needs AI-assisted project understanding to finish or refresh project-specific harness content.

This skill is an operating procedure. It does not replace the deterministic VCM installer.

## Boundaries

- Read the repository before drafting project-specific harness content.
- Do not edit product source, product tests, package manifests, lockfiles, deployment config, or secrets.
- Do not own managed-block writes, hook merging, manifest migrations, uninstall behavior, or deterministic skeleton creation; VCM backend owns those.
- Do not create new validation wrapper tools during bootstrap.

## Procedure

1. Generate context when supported: run \`.ai/tools/generate-module-index\`, then run \`.ai/tools/generate-public-surface\` after \`module-index.json\` exists.
2. Inspect the project:  read \`README.md\`, read \`CLAUDE.md\`, durable project docs, project manifests/config, source layout, tests, and existing validation commands.
3. Fill project context: add or update non-managed project facts in \`CLAUDE.md\` above the VCM managed block.
4. Fill durable docs: update \`docs/ARCHITECTURE.md\`, module-level \`ARCHITECTURE.md\` files, and \`docs/TESTING.md\` with detailed project-specific content.
5. Preserve user-authored content and VCM managed blocks.
6. Report evidence, unknowns, confirmation-needed areas, generation failures, and recommended deterministic VCM actions.

## Typical Outputs

- \`CLAUDE.md\` project context and project constraints outside the VCM managed block
- \`docs/ARCHITECTURE.md\`
- \`docs/TESTING.md\`
- \`docs/known-issues.md\` only for confirmed durable issues
- module-level \`ARCHITECTURE.md\` files
- \`.ai/generated/module-index.json\`
- \`.ai/generated/public-surface.json\`

## Output Requirements

### \`CLAUDE.md\`

- Write only project-specific facts outside the VCM managed block.
- Include project type, architecture shape, important constraints, and local conventions when verified or strongly inferred.
- Do not edit, duplicate, or summarize the VCM managed block.

### Generated Context

- Run \`.ai/tools/generate-module-index\` when the generator exists and the project is supported.
- Run \`.ai/tools/generate-public-surface\` only after \`.ai/generated/module-index.json\` exists.
- If generation fails or the project is unsupported, report the reason. Do not invent generated artifacts.

### \`docs/ARCHITECTURE.md\`

- Document the project-level module overview, module responsibilities, module relationships, dependency direction, and project-wide constraints.
- Link to module-level \`ARCHITECTURE.md\` files when present.
- Explain generated-context ownership, especially that \`.ai/generated/public-surface.json\` is the machine index for crate-external public APIs.

### Module-Level \`ARCHITECTURE.md\`

- Create or update one module-level \`ARCHITECTURE.md\` for each clear module boundary.
- Document module boundaries, responsibilities, allowed dependencies, important behavior, important public surface explanations, risks, and update triggers.
- Keep complete public API listings in \`.ai/generated/public-surface.json\`; module docs should explain meaning and design intent, not duplicate the full generated index.

### \`docs/TESTING.md\`

- Document validation levels, project-native validation commands, validation selection rules, final-validation cleanup, unit/integration test placement, generated-context freshness checks, and known testing gaps.
- Document integration and E2E test cases as reviewable case lists. Each case should include ID, scenario, entry point, what it proves, key assertions, when to run, and current limitations when relevant.
- Keep historical investigation details, superseded failures, temporary diagnostics, and per-task validation logs out of \`docs/TESTING.md\`.
- Keep reviewer ownership of validation strategy and testing documentation clear.

## Final Summary

Include:

- files reviewed
- files drafted or updated
- verified claims
- inferred claims
- unknowns
- needs human confirmation
- suggested validation commands
- recommended next harness steps
`;
}
