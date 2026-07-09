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
- The published npm package ships only built output (`dist`, `dist-frontend`, `scripts`, `README.md`). Do not assume `src/` or `docs/` is shipped; keep runtime-needed assets in shipped paths.
- `package.json`, lockfiles, and build/deploy config are out of scope for **Harness Engineer bootstrap** edits. A deliberate release version bump (e.g. `package.json` version plus lockfile) made by the architect-led release flow inside an explicit release task is a sanctioned exception, not a bootstrap edit.

<!-- VCM:BEGIN version=1 -->
## VCM Start Here

- Use the durable project docs below as role-relevant project truth.
- Read module-local `CLAUDE.md` before editing a subdirectory if one exists.
- Follow the role definition in `.claude/agents/**` and use the task skills in `.claude/skills/**` when they apply.

## VCM Global Invariants

- Use `vcm-route-message` only for PM-hub routes: project-manager dispatches to roles, and roles report questions, results, blockers, and findings back to project-manager. Follow its write-then-stop rule.
- Project-manager runs `vcm-gate-review` unconditionally at every Gate Review trigger point and on VCM Gate Review callbacks; the tool reports the authoritative enable state.
- Gate Review must review real task artifacts: architecture plans, review reports, final diffs, generated context, code, tests, docs, and handoff evidence. Do not substitute role claims for artifacts.
- Runtime task records and handoffs under `.ai/vcm/` are temporary. Durable facts must move into code, tests, PR text, commit history, or long-term docs.

## VCM Structured Handoffs

- Role handoffs must be written as structured artifacts under `.ai/vcm/handoffs/` using the responsible role or skill format.
- Route messages should reference handoff artifacts instead of copying long content.
- Do not replace required handoff artifacts with chat prose.

## VCM Durable Project Docs

- `docs/GLOSSARY.md`: abbreviation allowlist for durable comments and docs.
- `docs/ARCHITECTURE.md`: project-level architecture; architect-owned.
- `<module>/ARCHITECTURE.md`: module-level architecture; architect-owned.
- `docs/TESTING.md`: validation strategy, levels, commands, cases, and known testing gaps; reviewer-owned.
- `docs/known-issues.md`: durable known issues and accepted limitations; architect-owned.
- `.ai/generated/module-index.json`: generated module map.
- `.ai/generated/public-surface.json`: generated public surface index.

## VCM Glossary Policy

- `docs/GLOSSARY.md` is the only source of truth for abbreviations allowed in durable comments and documentation.
- When writing or editing durable comments or documentation, use only abbreviations listed in `docs/GLOSSARY.md`; otherwise write the full term.
- To introduce a new abbreviation, update `docs/GLOSSARY.md` before using it.

## VCM Long-Running Validation

- Never run the Bash tool with `run_in_background: true`. Never detach a process with `nohup`, `setsid`, `disown`, or a trailing `&`. VCM denies these calls.
- The only sanctioned long-running mechanism is the `vcm-long-running-validation` skill: `.ai/tools/run-long-check` plus `.ai/tools/watch-job`.
- The moment a command might run longer than 2 minutes, switch to that skill instead of running the command directly.
- While a job is running, stay in the current turn and keep calling `.ai/tools/watch-job` until it reports a terminal result; VCM blocks turn-end while a job is running, and a job without a live watcher is killed automatically.
- Hard ceiling: 60 minutes per job, enforced by the job worker. Do not run or suggest operations expected to exceed 60 minutes without user approval; split larger work first.

## VCM Harness Feedback

- VCM harness includes root `CLAUDE.md`, `.claude/agents/**`, `.claude/skills/**`, `.ai/tools/**`, VCM managed blocks, generated-context tooling, routing rules, validation rules, Gate Review rules, Translator rules, and Harness Engineer rules.
- Use `vcm-report-harness-issue` when you notice a reusable VCM harness problem. Record concise evidence; do not contact Harness Engineer directly.

## VCM Worktree Policy

- Use one branch, one worktree, one handoff directory, and one PR or final patch per VCM-managed task.
- Roles work sequentially in the same task worktree.
- If `git status` shows uncommitted changes, commit them before handing off to another role.

<!-- VCM:END -->
