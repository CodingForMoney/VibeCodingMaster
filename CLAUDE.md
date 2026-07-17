# CLAUDE.md

## Project Context

- VibeCodingMaster (VCM, npm package `vibe-coding-master`) is a local GUI cockpit that runs and orchestrates multiple Claude Code role sessions around one engineering task.
- Single npm package, not a monorepo. TypeScript end to end, ESM (`"type": "module"`), Node `^20 || >=22`.
- Three source layers under `src/`:
  - `src/backend`: Fastify HTTP/WebSocket server, role/session runtime (`node-pty`), services, adapters, gateway channels, and harness templates. Entry point `src/main.ts` -> `src/backend/server.ts`.
  - `src/frontend`: React 19 + Vite single-page GUI, embedded terminals via `@xterm/xterm`, app/session state stores.
  - `src/shared`: cross-layer TypeScript types, constants, and zod-backed validation helpers; imported by both backend and frontend.
- Runtime model: one Fastify backend (default port 4173) plus a Vite dev server (default port 5173, proxies `/api` and `/ws` to backend). Each Claude Code role runs as a real `pty` process the backend supervises.
- VCM roles: `project-manager`, `architect`, `coder`, `tester`, optional `gate-reviewer`, plus tool roles (translator, harness-engineer). Role definitions live in `src/shared/constants.ts`.
- The harness this repo installs into other projects is authored in `src/backend/templates/harness/**`. Editing harness behavior for downstream users means editing those templates, not the generated files in a target repo.
- Durable local app state lives outside the repo under `vcmDataDir` (`VCM_DATA_DIR` or `~/.vcm`); per-task runtime state lives under `<taskRepoRoot>/.ai/vcm/`.

## Release Process

- Release/publish is a recurring, irreversible operation and is **architect-owned**: the architect leads and is responsible for the release.
- Project release flow: architect (release plan, owns the release) -> coder (version bump in `package.json` + lockfile) -> tester (release gate, see `docs/TESTING.md` "Release Gate (L4)") -> `npm publish` -> project-manager final acceptance (record the published commit SHA and confirm with `npm view`).
- When the user has already explicitly requested a release, that request **is** the go-ahead: do not insert another user confirmation step before publishing. Only pause for the user if something in the release gate fails or the scope is unclear.
- `npm publish` runs in the foreground and may prompt for an interactive OTP/2FA, so it must **not** be run through the detached long-running-validation job tooling (`run-long-check`/`watch-job`), which cannot accept interactive input.

## Project Constraints

- Do not break the `src/shared` boundary: `shared` must not import from `backend` or `frontend`; `frontend` and `backend` may depend on `shared` but not on each other.
- Backend tsconfig (`tsconfig.node.json`) and frontend tsconfig (`tsconfig.json`) are separate; `npm run typecheck` runs both. Keep new files inside the correct `include` globs.
- Frontend talks to the backend only through `src/frontend/state/api-client.ts` and the WebSocket terminal client; do not scatter raw `fetch`/socket calls in components.
- Background/long-running work is constrained by the VCM background-job rules in the managed block below; never detach processes.
- The published npm package ships only built output (`dist`, `dist-frontend`, `scripts`, `README.md`). Do not assume `src/` or `docs/` is shipped; keep runtime-needed assets in shipped paths.
- `package.json`, lockfiles, and build/deploy config are out of scope for **Harness Engineer bootstrap** edits. A deliberate release version bump (e.g. `package.json` version plus lockfile) made by the architect-led release flow inside an explicit release task is a sanctioned exception, not a bootstrap edit.

<!-- VCM:BEGIN version=1 -->
@.ai/vcm/memory/shared.md

## VCM Start Here

- Use the durable project docs below as role-relevant project truth.
- Read module-local `CLAUDE.md` before editing a subdirectory if one exists.
- `vcm-route-message` is the only channel for PM-hub dispatch and reporting among project-manager, architect, coder, and tester. Gate Review and tool-role work use their dedicated VCM skills and controllers. Follow the route skill's write-then-stop rule.
- Use `vcm-long-running-validation` for long-running validation. Follow the background job limits below.
- Use `vcm-report-harness-issue` when you notice a reusable VCM harness problem. Record feedback; do not contact Harness Engineer directly.
- Treat `.ai/vcm/memory/**` as read-only. Use `vcm-propose-memory` only when VCM assigns a memory proposal during Task Harness Review.
- Only the user may approve scope reduction, skipped required validation, Gate Review skip or override, skipped required docs sync, accepted unresolved task-scope risk, or weakening of baseline Harness rules. PM may record and route the user's approval but cannot grant it.
- Project-manager runs `vcm-gate-review` unconditionally at every Gate Review trigger point and on VCM Gate Review callbacks; the tool reports the authoritative enable state.

## VCM Harness Scope

VCM harness includes root `CLAUDE.md`, `.claude/agents/**`, `.claude/skills/**`, `.ai/tools/**`, `.claude/settings.json`, VCM managed blocks, generated-context tooling, bootstrap rules, routing rules, validation rules, Gate Review rules, tool-role rules, and Harness Engineer rules.

If a reusable harness problem is suspected, it is enough to record a concise feedback report with evidence. Harness Engineer decides whether it is real, whether it should be fixed, and which files are in scope.

## VCM Background Jobs

- Never run the Bash tool with `run_in_background: true`. Never detach a process with `nohup`, `setsid`, `disown`, or a trailing `&`. VCM denies these calls.
- The only sanctioned long-running mechanism is the `vcm-long-running-validation` skill: `.ai/tools/run-long-check` plus `.ai/tools/watch-job`. Only one job may run at a time.
- The moment a command might run longer than 2 minutes, switch to that skill instead of running the command directly.
- While a job is running, stay in the current turn and keep calling `.ai/tools/watch-job` until it reports a terminal result; VCM blocks turn-end while a job is running, and a job without a live watcher is killed automatically.
- Hard ceiling: 60 minutes per job, enforced by the job worker. No approval can raise this ceiling; split larger operations into jobs that each fit within it.

## VCM Durable Project Docs

- `docs/GLOSSARY.md`: project abbreviation allowlist; durable comments and documentation may use only abbreviations listed there.
- `docs/CODING_STANDARDS.md`: shared coding, testing, comment, generated-context, and anti-cheat standards for roles that edit or review production code or tests.
- `docs/ARCHITECTURE.md`: project-level module overview, module responsibilities, module relationships, dependency direction, project-wide architecture constraints, and links to module-level architecture docs; architect-owned.
- `<module>/ARCHITECTURE.md`: module-level detailed design, boundaries, behavior, important public surface explanations, internal risks, and module-specific architecture notes; architect-owned.
- `docs/TESTING.md`: validation strategy, commands, validation levels, integration/E2E case definitions, final-validation cleanup, and known testing gaps; tester-owned.
- `docs/known-issues.md`: durable known issues and accepted limitations; architect-owned.
- `.ai/generated/module-index.json`: generated module index; use it to find layers, modules, manifests, module docs, source files, test files, and workspace dependencies.
- `.ai/generated/public-surface.json`: generated public surface index; use it to inspect module-to-module public APIs, routes, and source evidence.

## VCM Glossary Policy

- `docs/GLOSSARY.md` is the only source of truth for abbreviations allowed in durable comments and documentation.
- When writing or editing durable comments or documentation, use only abbreviations listed in `docs/GLOSSARY.md`; otherwise write the full term.
- To introduce a new abbreviation, update `docs/GLOSSARY.md` before using it.

## VCM Task Flow

- All standard workflow routes among project-manager, architect, coder, and tester are PM-hub routes. Project-manager starts and advances every flow; architect, coder, and tester report blockers, failures, conflicts, incomplete work, and findings back to project-manager.
- Code changes use: `project-manager -> architect interview -> architect planning -> coder -> tester -> architect docs sync -> project-manager final acceptance`.
- Architect Debug Mode runs inside either Architect Debug Flow or Architect Debug Branch. Architecture Diagnosis Mode runs inside either Architecture Diagnosis Flow or Architecture Diagnosis Branch.
- Architect Debug Flow and an Architecture Diagnosis Flow that produces code changes continue through code-diff Gate Review, tester validation, architect docs sync, and project-manager final acceptance. An analysis-only Architecture Diagnosis Flow completes from the diagnosis result.
- Architect Debug Branch and Architecture Diagnosis Branch preserve the active parent flow and resume point, then return there after successful validation. They do not run their own final acceptance.
- Docs-Only Flow uses: `project-manager -> architect -> project-manager completion`.
- Validation-Only Flow uses: `project-manager -> tester -> validation-adequacy Gate Review -> project-manager completion`.
- Communication-Only Flow uses: `project-manager response or relay -> completion`.
- Gate Review is PM-triggered at its defined trigger points; the tool decides whether review is enabled or required.
- Final acceptance closes only a complete code-delivery flow; it never closes Architect Debug Branch or Architecture Diagnosis Branch.
- PR-Preparation Flow starts only after the active delivery flow completes; every complete code-delivery flow requires final acceptance to pass.
- If Docs-Only Flow or Validation-Only Flow reveals that the accepted outcome requires production-code, runtime-behavior, public-contract, dependency, or system-architecture changes, project-manager routes through the full Code-Change Flow.
- Detailed failure handling and route decisions belong to project-manager rules.
- Keep role outputs under `.ai/vcm/handoffs/`.
- Gate Review Gate reports live under `.ai/vcm/gate-reviews/` and are VCM-managed task evidence.
- Runtime task records and handoffs under `.ai/vcm/` are temporary. Durable facts must move into code, tests, PR text, commit history, or long-term docs.
- Only architect writes `.ai/vcm/handoffs/known-issues.md`; other roles report unresolved findings back through their own handoff artifacts.

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
- VCM workflow role handoffs run sequentially in the same task worktree. Coder-managed workers may run concurrently within the Coder turn.
- If `git status` shows uncommitted changes, commit them before handing off to another role.

<!-- VCM:END -->
