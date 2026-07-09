# CLAUDE.md

## Project Context

This is a Rust workspace example for VCM harness experiments. It has three architecture layers: `foundation`, `domain`, and `application`. Each layer contains three crates.

## Project Constraints

- Preserve the layered dependency direction: `application -> domain -> foundation`.
- Do not add dependencies outside the workspace unless explicitly approved.
- Keep crate public APIs small and intentional.

<!-- VCM:BEGIN version=1 -->
## VCM Start Here

- Use the durable project docs below as role-relevant project truth.
- Read module-local `CLAUDE.md` before editing a subdirectory if one exists.
- Use `vcm-route-message` only for PM-hub routes: project-manager dispatches to roles, and roles report questions, results, blockers, and findings back to project-manager. Follow its write-then-stop rule.
- Use `vcm-long-running-validation` for long-running validation. Follow the background job limits below.
- Use `vcm-report-harness-issue` when you notice a reusable VCM harness problem. Record feedback; do not contact Harness Engineer directly.
- Project-manager runs `vcm-gate-review` unconditionally at every Gate Review trigger point and on VCM Gate Review callbacks; the tool reports the authoritative enable state.

## VCM Harness Scope

VCM harness includes root `CLAUDE.md`, `.claude/agents/**`, `.claude/skills/**`, `.ai/tools/**`, `.claude/settings.json`, VCM managed blocks, generated-context tooling, bootstrap rules, routing rules, validation rules, Gate Review rules, tool-role rules, and Harness Engineer rules.

If a reusable harness problem is suspected, it is enough to record a concise feedback report with evidence. Harness Engineer decides whether it is real, whether it should be fixed, and which files are in scope.

## VCM Background Jobs

- Never run the Bash tool with `run_in_background: true`. Never detach a process with `nohup`, `setsid`, `disown`, or a trailing `&`. VCM denies these calls.
- The only sanctioned long-running mechanism is the `vcm-long-running-validation` skill: `.ai/tools/run-long-check` plus `.ai/tools/watch-job`.
- The moment a command might run longer than 2 minutes, switch to that skill instead of running the command directly.
- While a job is running, stay in the current turn and keep calling `.ai/tools/watch-job` until it reports a terminal result; VCM blocks turn-end while a job is running, and a job without a live watcher is killed automatically.
- Hard ceiling: 60 minutes per job, enforced by the job worker. Do not run or suggest operations expected to exceed 60 minutes without user approval; split larger work first.

## VCM Durable Project Docs

- `docs/GLOSSARY.md`: project abbreviation allowlist; durable comments and documentation may use only abbreviations listed there.
- `docs/ARCHITECTURE.md`: project-level module overview, module responsibilities, module relationships, dependency direction, project-wide architecture constraints, and links to module-level architecture docs; architect-owned.
- `<module>/ARCHITECTURE.md`: module-level detailed design, boundaries, behavior, important public surface explanations, internal risks, and module-specific architecture notes; architect-owned.
- `docs/TESTING.md`: validation strategy, commands, validation levels, integration/E2E case definitions, final-validation cleanup, and known testing gaps; reviewer-owned.
- `docs/known-issues.md`: durable known issues and accepted limitations; architect-owned.
- `.ai/generated/module-index.json`: generated module index; use it to find layers, modules, manifests, module docs, source files, test files, and workspace dependencies.
- `.ai/generated/public-surface.json`: generated public surface index; use it to inspect module-to-module public APIs, routes, and source evidence.

## VCM Glossary Policy

- `docs/GLOSSARY.md` is the only source of truth for abbreviations allowed in durable comments and documentation.
- When writing or editing durable comments or documentation, use only abbreviations listed in `docs/GLOSSARY.md`; otherwise write the full term.
- To introduce a new abbreviation, update `docs/GLOSSARY.md` before using it.

## VCM Task Flow

- All role routes are PM-hub routes. Project-manager starts and advances every flow; non-PM roles report blockers, failures, conflicts, incomplete work, and findings back to project-manager.
- Code changes use: `project-manager -> architect -> coder -> reviewer -> architect docs sync -> project-manager final acceptance`.
- Debug work uses: `project-manager -> architect Debug Mode -> reviewer -> project-manager final acceptance`.
- Docs-only changes use: `project-manager -> architect -> project-manager final acceptance`.
- Test-only or validation-only work uses: `project-manager -> reviewer -> project-manager final acceptance`.
- Architecture Diagnosis is a PM-triggered branch inside code/debug work: `project-manager -> architect Architecture Diagnosis Mode -> project-manager route decision`.
- Gate Review is PM-triggered at its defined trigger points; the tool decides whether review is enabled or required.
- Final acceptance closes every delivery flow before task completion or PR preparation.
- PR preparation starts only after final acceptance.
- If docs/test/validation-only work reveals required code, architecture, public contract, dependency, durable-doc, or test-strategy changes, project-manager routes through the full code-change flow.
- Detailed failure handling and route decisions belong to project-manager rules.
- Keep role outputs under `.ai/vcm/handoffs/`.
- Gate Review Gate reports live under `.ai/vcm/gate-reviews/` and are VCM-managed task evidence.
- Runtime task records and handoffs under `.ai/vcm/` are temporary. Durable facts must move into code, tests, PR text, commit history, or long-term docs.
- Record current-task unresolved findings in `.ai/vcm/handoffs/known-issues.md`.

## VCM Validation Levels

- L0 fast checks (default runner: coder): format, lint, typecheck, boundary, dependency, or other cheap project checks.
- L1 baseline implementation checks (default runner: coder): changed behavior and direct regressions through project-defined unit tests.
- L2 module / integration checks: targeted fast L2 may run in coder when explicitly assigned; full L2, integration suites, multi-node, cross-service, persistence, runtime, or public-contract gates are reviewer-run.
- L3 smoke E2E checks (default runner: reviewer): core user journeys or critical browser/API flows.
- L4 full regression / release checks (default runner: reviewer; architect-owned release flow) are release-only unless explicitly requested.

## VCM Worktree Policy

- Use one branch, one worktree, one handoff directory, and one PR or final patch per VCM-managed task.
- Roles work sequentially in the same task worktree.
- If `git status` shows uncommitted changes, commit them before handing off to another role.

<!-- VCM:END -->
