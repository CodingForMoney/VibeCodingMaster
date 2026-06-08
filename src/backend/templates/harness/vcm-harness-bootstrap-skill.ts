export function renderVcmHarnessBootstrapSkillRules(): string {
  return `## Purpose

Use this skill when VCM needs AI-assisted project understanding to finish or refresh project-specific harness content.

This skill is an operating procedure. It does not replace the deterministic VCM installer.

## Boundaries

- Read the repository before drafting project-specific harness content.
- Do not edit product source, product tests, package manifests, lockfiles, deployment config, or secrets.
- Do not own managed-block writes, hook merging, manifest migrations, uninstall behavior, or deterministic skeleton creation; VCM backend owns those.
- Mark important claims as \`Verified from code\`, \`Inferred from <path>\`, \`Unknown\`, or \`Needs human confirmation\`.
- Do not create validation tools that pass while only acting as empty placeholders.

## Procedure

1. Read \`CLAUDE.md\`, durable project docs, project manifests/config, source layout, tests, and existing validation commands.
2. Identify architecture, public behavior/contracts, persistence, dependency direction, security/data rules, validation commands, and testing gaps.
3. Draft or update project-specific harness content only where evidence supports it.
4. Preserve user-authored content and VCM managed blocks.
5. Report unknowns, confirmation-needed areas, and recommended deterministic VCM actions.

## Typical Outputs

- \`docs/ARCHITECTURE.md\`
- \`docs/TESTING.md\`
- \`docs/known-issues.md\` only for confirmed durable issues
- module-local \`CLAUDE.md\` drafts when module boundaries are clear
- project-specific \`.ai/tools/*\` recommendations or updates when explicitly requested

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
