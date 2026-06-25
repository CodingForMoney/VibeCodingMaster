# CLAUDE.md

## Project Context

- VibeCodingMaster (VCM, npm package `vibe-coding-master`) is a local GUI cockpit that runs and orchestrates multiple Claude Code role sessions around one engineering task.
- Single npm package, not a monorepo. TypeScript end to end, ESM (`"type": "module"`), Node `^20 || >=22`.
- Three source layers under `src/`:
  - `src/backend`: Fastify HTTP/WebSocket server, role/session runtime (`node-pty`), services, adapters, gateway channels, and harness templates. Entry point `src/main.ts` -> `src/backend/server.ts`.
  - `src/frontend`: React 19 + Vite single-page GUI, embedded terminals via `@xterm/xterm`, app/session state stores.
  - `src/shared`: cross-layer TypeScript types, constants, and zod-backed validation helpers; imported by both backend and frontend.
- Runtime model: one Fastify backend (default port 4173) plus a Vite dev server (default port 5173, proxies `/api` and `/ws` to backend). Each Claude Code role runs as a real `pty` process the backend supervises.
- VCM roles: `project-manager`, `architect`, `coder`, `reviewer`, optional `gate-reviewer`, plus tool roles (translator, harness-engineer). Role definitions live in `src/shared/constants.ts`.
- The harness this repo installs into other projects is authored in `src/backend/templates/harness/**`. Editing harness behavior for downstream users means editing those templates, not the generated files in a target repo.
- Durable local app state lives outside the repo under `vcmDataDir` (`VCM_DATA_DIR` or `~/.vcm`); per-task runtime state lives under `<taskRepoRoot>/.ai/vcm/`.

## Release Process

- Release/publish is a recurring, irreversible operation and is **architect-owned**: the architect leads and is responsible for the release.
- Project release flow: architect (release plan, owns the release) -> coder (version bump in `package.json` + lockfile) -> reviewer (release gate, see `docs/TESTING.md` "Release Gate (L4)") -> `npm publish` -> project-manager final acceptance (record the published commit SHA and confirm with `npm view`).
- When the user has already explicitly requested a release, that request **is** the go-ahead: do not insert another user confirmation step before publishing. Only pause for the user if something in the release gate fails or the scope is unclear.
- `npm publish` runs in the foreground and may prompt for an interactive OTP/2FA, so it must **not** be run through the detached long-running-validation job tooling (`run-long-check`/`watch-job`), which cannot accept interactive input.

## Project Constraints

- Do not break the `src/shared` boundary: `shared` must not import from `backend` or `frontend`; `frontend` and `backend` may depend on `shared` but not on each other.
- Backend tsconfig (`tsconfig.node.json`) and frontend tsconfig (`tsconfig.json`) are separate; `npm run typecheck` runs both. Keep new files inside the correct `include` globs.
- Frontend talks to the backend only through `src/frontend/state/api-client.ts` and the WebSocket terminal client; do not scatter raw `fetch`/socket calls in components.
- Background/long-running work is constrained by the VCM background-job rules in the managed block below; never detach processes.
- The published npm package ships only built output (`dist`, `dist-frontend`, `docs`, `scripts`, `README.md`). Do not assume `src/` is shipped; keep runtime-needed assets in shipped paths.
- `package.json`, lockfiles, and build/deploy config are out of scope for **Harness Engineer bootstrap** edits. A deliberate release version bump (e.g. `package.json` version plus lockfile) made by the architect-led release flow inside an explicit release task is a sanctioned exception, not a bootstrap edit.

<!-- VCM:BEGIN version=1 -->
## VCM Start Here

- Use the durable project docs below as role-relevant project truth.
- Read module-local `CLAUDE.md` before editing a subdirectory if one exists.
- Use `vcm-route-message` whenever a VCM role hands off work, asks another role a question, reports a result, reports a blocker, or raises a finding. Follow its write-then-stop rule.
- Use `vcm-long-running-validation` for long-running validation. Follow the background job limits below.
- Use `vcm-report-harness-issue` when you notice a reusable VCM harness problem. Record feedback; do not contact Harness Engineer directly.
- Project-manager uses `vcm-gate-review` at enabled Gate Review trigger points and on VCM Gate Review callbacks.

## VCM Harness Scope

VCM harness includes root `CLAUDE.md`, `.claude/agents/**`, `.claude/skills/**`, `.ai/tools/**`, `.claude/settings.json`, VCM managed blocks, generated-context tooling, bootstrap rules, routing rules, validation rules, Gate Review rules, Translator rules, and Harness Engineer rules.

If a reusable harness problem is suspected, it is enough to record a concise feedback report with evidence. Harness Engineer decides whether it is real, whether it should be fixed, and which files are in scope.

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
- `.ai/generated/public-surface.json`: generated public surface index; use it to inspect module-to-module public APIs, routes, and source evidence.

## VCM Task Flow

- Code changes use the full route: `project-manager -> architect -> coder -> reviewer -> architect docs sync -> project-manager final acceptance`.
- Before code changes, architect must write an architecture plan with a Scaffold Manifest and minimum necessary code scaffolding that cover file responsibilities, cross-file callable surfaces, user-visible behavior, docs impact, risks, and Replan triggers.
- Docs-only changes may use: `project-manager -> architect -> project-manager final acceptance`.
- Test-only or validation-only work may use: `project-manager -> reviewer -> project-manager final acceptance`.
- If a docs/test/validation-only task reveals required code, architecture, public contract, dependency, durable-doc, or test-strategy changes, route back through the full code-change flow.
- Keep role outputs under `.ai/vcm/handoffs/`.
- Gate Review Gate reports live under `.ai/vcm/gate-reviews/` and are VCM-managed task evidence.
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
