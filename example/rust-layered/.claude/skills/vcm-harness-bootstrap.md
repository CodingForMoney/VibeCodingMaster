# VCM Harness Bootstrap Skill

<!-- VCM:BEGIN version=1 -->
## Purpose

Use this skill when VCM needs AI-assisted project understanding to finish or refresh project-specific harness content.

This skill is an operating procedure. It does not replace the deterministic VCM installer.

## Boundaries

- Read the repository before drafting project-specific harness content.
- Do not edit product source, product tests, package manifests, lockfiles, deployment config, or secrets.
- Do not own managed-block writes, hook merging, manifest migrations, uninstall behavior, or deterministic skeleton creation; VCM backend owns those.
- Mark important claims as `Verified from code`, `Inferred from <path>`, `Unknown`, or `Needs human confirmation`.
- Do not create new validation wrapper tools during bootstrap.

## Procedure

1. Read `CLAUDE.md`, durable project docs, project manifests/config, source layout, tests, and existing validation commands.
2. Identify architecture, public behavior/contracts, persistence, dependency direction, security/data rules, validation commands, and testing gaps.
3. Draft or update project-specific harness content only where evidence supports it.
4. Preserve user-authored content and VCM managed blocks.
5. Run or recommend the generated-context tools only when they are relevant to the project shape.
6. Report unknowns, confirmation-needed areas, and recommended deterministic VCM actions.

## Typical Outputs

- `docs/ARCHITECTURE.md`
- `docs/TESTING.md`
- `docs/known-issues.md` only for confirmed durable issues
- module-level `ARCHITECTURE.md` drafts when module boundaries are clear
- `.ai/generated/module-index.json` and `.ai/generated/public-surface.json` updates when supported by project generators
- generator or long-running helper recommendations only when explicitly requested

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
<!-- VCM:END -->
