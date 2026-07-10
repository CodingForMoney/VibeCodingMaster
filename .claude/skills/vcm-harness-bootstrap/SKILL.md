---
name: vcm-harness-bootstrap
description: Use when VCM needs AI-assisted project understanding to finish or refresh project-specific harness content.
---

# VCM Harness Bootstrap Skill

## Purpose

Use this skill when VCM needs AI-assisted project understanding to finish or refresh project-specific harness content.

This skill is an operating procedure. It does not replace the deterministic VCM installer.

## Boundaries

- Work only in the active task worktree named by VCM.
- Read the repository before drafting project-specific harness content.
- Do not edit product source, product tests, package manifests, lockfiles, deployment config, or secrets.
- Do not own managed-block writes, hook merging, manifest migrations, uninstall behavior, or deterministic skeleton creation; VCM backend owns those.
- Do not create new validation wrapper tools during bootstrap.

## Procedure

1. Generate context when supported: run `.ai/tools/generate-module-index`, then run `.ai/tools/generate-public-surface` after `module-index.json` exists.
2. Inspect the project:  read `README.md`, read `CLAUDE.md`, durable project docs, project manifests/config, source layout, tests, and existing validation commands.
3. Fill project context: add or update non-managed project facts in `CLAUDE.md` above the VCM managed block.
4. Fill durable docs: update `docs/GLOSSARY.md`, `docs/CODING_STANDARDS.md`, `docs/ARCHITECTURE.md`, module-level `ARCHITECTURE.md` files for clear non-root module boundaries, and `docs/TESTING.md` with detailed project-specific content.
5. Preserve user-authored content and VCM managed blocks.
6. Review `git status` and `git diff`.
7. Stage only allowed bootstrap harness changes and create a commit in the active task worktree.
8. Report evidence, commit hash, final git status, unknowns, confirmation-needed areas, generation failures, and recommended deterministic VCM actions.

## Typical Outputs

- `CLAUDE.md` project context and project constraints outside the VCM managed block
- `docs/GLOSSARY.md`
- `docs/CODING_STANDARDS.md`
- `docs/ARCHITECTURE.md`
- `docs/TESTING.md`
- `docs/known-issues.md` only for confirmed durable issues
- module-level `ARCHITECTURE.md` files for clear non-root module boundaries
- `.ai/generated/module-index.json`
- `.ai/generated/public-surface.json`

## Output Requirements

### `CLAUDE.md`

- Write only project-specific facts outside the VCM managed block.
- Include project type, architecture shape, important constraints, and local conventions when verified or strongly inferred.
- Do not edit, duplicate, or summarize the VCM managed block.

### Generated Context

- Run `.ai/tools/generate-module-index` when the generator exists and the project is supported.
- Run `.ai/tools/generate-public-surface` only after `.ai/generated/module-index.json` exists.
- If generation fails or the project is unsupported, report the reason. Do not invent generated artifacts.

### `docs/GLOSSARY.md`

- Keep the project abbreviation allowlist current.
- Include abbreviations that are allowed in durable comments and documentation.
- Remove or avoid project-invented shorthand that is not useful as durable terminology.
- If an abbreviation is not listed here, roles must write the full term instead.

### `docs/CODING_STANDARDS.md`

- Keep shared coding, testing, comment, generated-context, and anti-cheat standards current.
- Add project-specific implementation rules only when they make the shared baseline more precise.
- Do not weaken the baseline rules without explicit project approval.
- Keep role workflow rules out of this file; role routing, Gate Review, Final Acceptance, and role-specific handoff rules belong in role definitions or skills.

### `docs/ARCHITECTURE.md`

- Document the project-level module overview, module responsibilities, module relationships, dependency direction, and project-wide constraints.
- Link to module-level `ARCHITECTURE.md` files when present.
- Explain generated-context ownership, especially that `.ai/generated/public-surface.json` is the machine index for public APIs, routes, and externally consumed surfaces.

### Module-Level `ARCHITECTURE.md`

- Create or update one module-level `ARCHITECTURE.md` for each clear non-root module boundary with an `architectureDoc` path in `.ai/generated/module-index.json`.
- Do not create a root-level `ARCHITECTURE.md` only because the root package exists.
- Document module boundaries, responsibilities, allowed dependencies, important behavior, important public surface explanations, risks, and update triggers.
- Keep complete public API listings in `.ai/generated/public-surface.json`; module docs should explain meaning and design intent, not duplicate the full generated index.

### `docs/TESTING.md`

- Document validation levels, project-native validation commands, validation selection rules, final-validation cleanup, unit/integration test placement, generated-context freshness checks, and known testing gaps.
- Document integration and E2E test cases as reviewable case lists. Each case should include ID, scenario, entry point, what it proves, key assertions, when to run, and current limitations when relevant.
- Keep historical investigation details, superseded failures, temporary diagnostics, and per-task validation logs out of `docs/TESTING.md`.
- Keep tester ownership of validation strategy and testing documentation clear.

### Commit

- Create the bootstrap commit yourself after the allowed files are updated.
- Do not include product source, product tests, package manifests, lockfiles, deployment config, secrets, or VCM managed-block changes in the commit.
- VCM will not commit bootstrap changes after your turn.

## Final Summary

Include:

- files reviewed
- files drafted or updated
- commit hash
- final git status
- verified claims
- inferred claims
- unknowns
- needs human confirmation
- suggested validation commands
- recommended next harness steps
