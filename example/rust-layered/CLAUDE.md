# CLAUDE.md

## Project Context

This is a Rust workspace example for VCM harness experiments. It has three architecture layers: `foundation`, `domain`, and `application`. Each layer contains three crates.

## Project Constraints

- Preserve the layered dependency direction: `application -> domain -> foundation`.
- Do not add dependencies outside the workspace unless explicitly approved.
- Keep crate public APIs small and intentional.

<VCM-memory>
No accumulated project memory yet.
</VCM-memory>

<!-- VCM:BEGIN version=1 -->
## VCM Start Here

- Use the durable project docs below as role-relevant project truth.
- Read module-local `CLAUDE.md` before editing a subdirectory if one exists.
- `vcm-route-message` is the only channel for PM-hub dispatch and reporting among project-manager, architect, coder, and tester. Gate Review and tool-role work use their dedicated VCM skills and controllers. Follow the route skill's write-then-stop rule.
- Before every PM dispatch to Architect, Coder, or Tester, project-manager must use `vcm-workflow-review`. Only an accepted Workflow Progress transition grants the next route.
- `vcm-task-state` is recoverable context only. Workflow permission comes only from accepted `workflow-progress.md` submissions.
- Workflow roles use `vcm-long-running-validation` for long-running validation and follow the background job limits below.
- Use `vcm-report-harness-issue` when you notice a reusable VCM harness problem. Record feedback; do not contact Harness Engineer directly.
- The root `<VCM-memory>` block is shared project memory. Treat every `<VCM-memory>` block as read-only and use `vcm-propose-memory` only when VCM assigns an exact memory proposal or candidate path.
- Only the user may approve scope reduction, skipped required validation, Gate Review skip or override, skipped required docs sync, accepted unresolved task-scope risk, or weakening of baseline Harness rules. PM may record and route the user's approval but cannot grant it.
- Project-manager runs `vcm-gate-review` unconditionally at every Gate Review trigger point and on VCM Gate Review callbacks; the tool reports the authoritative enable state.

## VCM Managed Artifacts

- Workflow roles must submit VCM-managed Markdown under `.ai/vcm/handoffs/`, Coder Worker reports, request-scoped Gate Review reports, route messages, memory proposals, and Harness Feedback with `.ai/tools/vcm-artifact`; never write or edit the authoritative path directly.
- Write the candidate outside `.ai/vcm/`, then run `.ai/tools/vcm-artifact <kind> --file <candidate> --mode <draft|final>`. Dynamic artifacts also require the exact VCM-assigned `--path`.
- Use `draft` while an allowed lifecycle remains incomplete. Use `final` before routing or consuming a terminal artifact. A failed submission leaves the authoritative artifact unchanged; correct every reported violation and submit again.
- Do not route, review, or rely on a candidate file. Only the VCM-written authoritative path is workflow evidence.

## VCM Harness Scope

VCM harness includes root `CLAUDE.md`, `.claude/agents/**`, `.claude/skills/**`, `.ai/tools/**`, `.claude/settings.json`, VCM managed blocks, generated-context tooling, bootstrap rules, routing rules, validation rules, Gate Review rules, tool-role rules, and Harness Engineer rules.

If a reusable harness problem is suspected, it is enough to record a concise feedback report with evidence. Harness Engineer decides whether it is real, whether it should be fixed, and which files are in scope.

## VCM Background Jobs

- Workflow roles never run the Bash tool with `run_in_background: true` or detach a process with `nohup`, `setsid`, `disown`, or a trailing `&`. VCM denies these calls for workflow roles.
- The only sanctioned long-running mechanism is the `vcm-long-running-validation` skill: `.ai/tools/run-long-check` plus `.ai/tools/watch-job`. Only one job may run at a time.
- The moment a command might run longer than 2 minutes, switch to that skill instead of running the command directly.
- While a job is running, stay in the current turn and keep calling `.ai/tools/watch-job` until it reports a terminal result; VCM blocks turn-end while a job is running, and a job without a live watcher is killed automatically.
- Hard ceiling: 60 minutes per job, enforced by the job worker. No approval can raise this ceiling; split larger operations into jobs that each fit within it.

## VCM Durable Project Docs

- Durable project docs describe current project truth. Replace superseded content instead of appending task chronology, investigation history, role verdicts, commit history, or completed-work reports; task artifacts, Git, and PRs preserve that history.
- `docs/GLOSSARY.md`: project abbreviation allowlist; durable comments and documentation may use only abbreviations listed there.
- `docs/CODING_STANDARDS.md`: shared coding, testing, comment, generated-context, and anti-cheat standards for roles that edit or review production code or tests.
- `docs/ARCHITECTURE.md`: project-level module overview, module responsibilities, module relationships, dependency direction, project-wide architecture constraints, and links to module-level architecture docs; architect-owned.
- `<module>/ARCHITECTURE.md`: current module responsibilities, boundaries, data flow, lifecycle, invariants, collaboration contracts, important public surface meaning, risks, and update triggers; architect-owned.
- `docs/TESTING.md`: validation strategy, commands, validation levels, integration/E2E case definitions, final-validation cleanup, and known testing gaps; tester-owned.
- `docs/known-issues.md`: current unresolved durable issues and accepted limitations; remove resolved entries rather than retaining their history; architect-owned.
- `docs/plans/**`: active or planned work only. Remove a plan from this collection when its work is complete; Git and PR history preserve the completed plan.
- `.ai/generated/module-index.json`: generated module index; use it to find layers, modules, manifests, module docs, source files, test files, and workspace dependencies.
- `.ai/generated/public-surface.json`: generated public surface index; use it to inspect module-to-module public APIs, routes, and source evidence.
- Generated context is the source of truth for module inventories, source/test file inventories, dependency lists, and complete public-surface listings. Durable prose explains architecture and contract meaning instead of independently maintaining those machine facts.
- Run `.ai/tools/check-durable-docs` after bootstrap or durable-doc synchronization and before final acceptance when durable docs changed.

## VCM Glossary Policy

- `docs/GLOSSARY.md` is the only source of truth for abbreviations allowed in durable comments and documentation.
- When writing or editing durable comments or documentation, use only abbreviations listed in `docs/GLOSSARY.md`; otherwise write the full term.
- To introduce a new abbreviation, update `docs/GLOSSARY.md` before using it.

## VCM Task Flow

- All standard workflow routes among project-manager, architect, coder, and tester are PM-hub routes. Project-manager starts and advances every flow; architect, coder, and tester report blockers, failures, conflicts, incomplete work, and findings back to project-manager.
- Code changes use: `project-manager -> architect interview -> architect planning -> coder -> tester -> architect docs sync -> project-manager final acceptance`.
- Architect Debug Mode runs inside either Architect Debug Flow or Architect Debug Branch. Architecture Diagnosis Mode runs inside either Architecture Diagnosis Flow or Architecture Diagnosis Branch.
- Code-Change Flow, Architect Debug Flow, and an Architecture Diagnosis Flow that produces code changes run tester validation, validation-adequacy Gate Review, and then code-diff Gate Review before architect docs sync and project-manager final acceptance. An analysis-only Architecture Diagnosis Flow completes from the diagnosis result.
- Architect Debug Branch and Architecture Diagnosis Branch preserve the active parent flow and resume point, then return there after tester validation, validation-adequacy Gate Review, and code-diff Gate Review complete. They do not run their own final acceptance.
- Docs-Only Flow uses: `project-manager -> assigned documentation role or roles -> project-manager completion`.
- Validation-Only Flow uses: `project-manager -> tester -> validation-adequacy Gate Review -> project-manager completion`.
- Communication-Only Flow uses: `project-manager response or relay -> completion`.
- Gate Review is PM-triggered at its defined trigger points; the tool decides whether review is enabled or required.
- Ignore commits whose subject starts with `[VCM Harness]`. Do not review, attribute, or route those commits unless they cause a test failure. A test failure caused by a Harness commit follows the normal test-failure flow.
- Final acceptance closes only a complete code-delivery flow; it never closes Architect Debug Branch or Architecture Diagnosis Branch.
- PR-Preparation Flow starts only after the active delivery flow completes; every complete code-delivery flow requires final acceptance to pass.
- If Docs-Only Flow or Validation-Only Flow reveals that the accepted outcome requires production-code, runtime-behavior, public-contract, dependency, or system-architecture changes, project-manager routes through the full Code-Change Flow.
- Detailed failure handling and route decisions belong to project-manager rules.
- Keep role outputs under `.ai/vcm/handoffs/`.
- Gate Review Gate reports live under `.ai/vcm/gate-reviews/` and are VCM-managed task evidence.
- Runtime task records and handoffs under `.ai/vcm/` are temporary. Durable facts must move into code, tests, PR text, commit history, or long-term docs.
- Only architect writes `.ai/vcm/handoffs/known-issues.md`; other roles report unresolved findings back through their own handoff artifacts.

## VCM Current Handoff Contract

- A role-owned handoff under `.ai/vcm/handoffs/` is the complete current result for that artifact, not an append-only log or a pointer to an earlier revision.
- Whenever a handoff is rewritten, make the new revision self-contained: restate every still-relevant decision, evidence item, command, result, coverage mapping, finding, approval, and remaining action needed to interpret the current result without another round's artifact.
- Remove or replace superseded content. Do not use a prior round, prior report revision, consumed route message, role Session, or transcript as a substitute for evidence in the current handoff.
- A handoff may cite current code, durable docs, commits, preserved job output, or request-scoped Gate Review evidence that still exists at the cited path.
- Before routing an artifact reference, confirm the referenced handoff satisfies this contract.

## User Communication

- A message without a VCM marker is user communication.
- When the user asks a question, answer only.
- Do not modify files, run tests, update artifacts, send messages, report to project-manager, or advance the workflow unless the user explicitly instructs that action.
- Perform only the actions explicitly requested by the user and remain within the current role's responsibilities.

## VCM Validation Levels

- L0 fast checks (default runner: coder): format, lint, typecheck, boundary, dependency, or other cheap project checks.
- L1 baseline implementation checks (default runner: coder): changed behavior and direct regressions through project-defined unit tests.
- L2 module / integration checks: targeted diagnostic L2 may run in Coder when explicitly assigned, Architect Debug Mode, or Architecture Diagnosis Mode; Tester owns full and final L2 validation.
- L3 smoke E2E checks: targeted diagnostic L3 may run in Architect Debug Mode or Architecture Diagnosis Mode; Tester owns full and final L3 validation for core user journeys or critical browser/API flows.
- L4 full regression / release checks (default runner: tester; architect-owned release flow) are release-only unless explicitly requested.

## VCM Worktree Policy

- Use one branch, one worktree, one handoff directory, and one PR or final patch per VCM-managed task.
- VCM workflow role handoffs run sequentially in the same task worktree. Coder-managed workers may run concurrently within the Coder turn; Architect may run one foreground scaffold worker inside its planning turn.
- If `git status` shows uncommitted changes, commit them before handing off to another role.

<!-- VCM:END -->
