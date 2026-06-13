# CLAUDE.md

<!-- VCM:BEGIN version=1 -->
## VCM Start Here

- Use the durable project docs below as role-relevant project truth.
- Read module-local `CLAUDE.md` before editing a subdirectory if one exists.
- Use `vcm-route-message` whenever a VCM role hands off work, asks another role a question, reports a result, reports a blocker, or raises a finding. Follow its write-then-stop rule.
- Use `vcm-long-running-validation` for long-running validation. Follow the background job limits below.
- Project-manager uses `vcm-codex-review-gate` at enabled Codex Review Gate trigger points and on VCM Codex review callbacks.

## VCM Background Jobs

- Never run the Bash tool with `run_in_background: true`. Never detach a process with `nohup`, `setsid`, `disown`, or a trailing `&`. VCM denies these calls.
- The only sanctioned long-running mechanism is the `vcm-long-running-validation` skill: `.ai/tools/run-long-check` plus `.ai/tools/watch-job`.
- The moment a command might run longer than 2 minutes, switch to that skill instead of running the command directly.
- While a job is running, stay in the current turn and keep calling `.ai/tools/watch-job` until it reports a terminal result; VCM blocks turn-end while a job is running, and a job without a live watcher is killed automatically.
- Hard ceiling: 60 minutes per job, enforced by the job worker. Do not run or suggest operations expected to exceed 60 minutes without user approval; split larger work first.

## VCM Durable Project Docs

- `docs/ARCHITECTURE.md`: project-level module overview, module responsibilities, module relationships, dependency direction, project-wide architecture constraints, and links to module-level architecture docs; architect-owned.
- `<module>/ARCHITECTURE.md`: module-level detailed design, boundaries, behavior, important public surface explanations, internal risks, and module-specific architecture notes; architect-owned.
- `docs/TESTING.md`: validation strategy, commands, validation levels, integration/E2E case definitions, final-validation cleanup, and known testing gaps; reviewer-owned.
- `docs/known-issues.md`: durable known issues and accepted limitations; architect-owned.
- `.ai/generated/module-index.json`: generated module index; use it to find layers, modules, manifests, module docs, source files, test files, and workspace dependencies.
- `.ai/generated/public-surface.json`: generated crate-external public API index; use it to inspect module-to-module public interfaces and source evidence.

## VCM Task Flow

- Code changes use the full route: `project-manager -> architect -> coder -> reviewer -> architect docs sync -> project-manager final acceptance`.
- Before code changes, architect must write an architecture plan and code scaffolding that cover file responsibilities, cross-file callable surfaces, user-visible behavior, docs impact, risks, and Replan triggers.
- Docs-only changes may use: `project-manager -> architect -> project-manager final acceptance`.
- Test-only or validation-only work may use: `project-manager -> reviewer -> project-manager final acceptance`.
- If a docs/test/validation-only task reveals required code, architecture, public contract, dependency, durable-doc, or test-strategy changes, route back through the full code-change flow.
- Keep role outputs under `.ai/vcm/handoffs/`.
- Codex Review Gate reports live under `.ai/vcm/codex-reviews/` and are VCM-managed task evidence.
- Runtime task records and handoffs under `.ai/vcm/` are temporary. Durable facts must move into code, tests, PR text, commit history, or long-term docs.
- Record current-task unresolved findings in `.ai/vcm/handoffs/known-issues.md`.

## VCM Validation Levels

- L0 fast checks: format, lint, typecheck, boundary, dependency, or other cheap project checks.
- L1 coder unit checks: changed behavior and direct regressions through project-defined unit tests.
- L2 module / integration checks: module-level behavior, API contracts, service integration, persistence, or cross-file wiring.
- L3 smoke E2E checks: core user journeys or critical browser/API flows.
- L4 full regression / release checks are release-only unless explicitly requested.

## VCM Worktree Policy

- Use one branch, one worktree, one handoff directory, and one PR or final patch per VCM-managed task.
- Roles work sequentially in the same task worktree.
- If `git status` shows uncommitted changes, commit them before handing off to another role.

<!-- VCM:END -->
