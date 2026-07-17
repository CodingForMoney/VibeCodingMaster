# Architecture

Project-level architecture for VibeCodingMaster (VCM). VCM is a single npm
package that provides a local GUI cockpit for running and orchestrating multiple
Claude Code role sessions around one engineering task.

This document is architect-owned. It gives the project-wide module overview,
responsibilities, relationships, dependency direction, and constraints.

## Module / Layer Overview

VCM is one workspace module (`vibe-coding-master`) organized into three source
layers plus supporting tools.

| Layer | Path | Responsibility |
| --- | --- | --- |
| Backend | `src/backend` | Fastify HTTP + WebSocket server, role/session runtime over `node-pty`, services, external adapters, mobile gateway, and the downstream harness templates. |
| Frontend | `src/frontend` | React 19 + Vite single-page GUI: task workspace, role tabs, embedded `xterm` terminals, harness/translation panels, and client state stores. |
| Shared | `src/shared` | Cross-layer TypeScript types, constants (role definitions, ports), and zod-backed validation helpers consumed by both backend and frontend. |
| Tools / scripts | `.ai/tools`, `scripts` | Generated-context generators, long-running validation wrappers, bash guard, and harness install/verify scripts. |

### Backend sub-areas (`src/backend`)

- `api/`: Fastify route modules, one per domain (project, task, session, round,
  message, harness, gate-review, translation, gateway, diagnostics, artifacts,
  runtime-state, app-settings, claude-hook). Routes are thin and delegate to
  services.
- `services/`: business logic. Key services include `task-service`,
  `task-launch-service` (backend-owned one-click task start, shared by the GUI
  endpoint and the gateway), `task-close-service` (backend-owned unconditional
  task close, shared by the GUI endpoint and the gateway), `session-service`, `round-service`,
  `runtime-coordinator-service`, `runtime-recovery-service`,
  `turn-reconciler-service`, `message-service`, `task-workflow-service`,
  `artifact-service`, `harness-service`, `harness-feedback-service`,
  `auto-memory-service`,
  `gate-review-service`, `translation-service`/`translation-worker-service`,
  `job-guard-service`, and `command-dispatcher`.
- `runtime/`: PTY-backed terminal runtime (`node-pty-runtime`,
  `terminal-runtime`, `session-registry`, `terminal-submit`) that supervises one
  Claude Code process per role.
- `adapters/`: side-effect boundaries — `claude-adapter`, `git-adapter`,
  `command-runner`, `filesystem`.
- `gateway/`: mobile gateway service plus channel implementations
  (Weixin iLink, Lark) and command parsing; channel connection is gated by a
  runtime, default-off switch. Detailed sub-area design lives in
  [`src/backend/gateway/ARCHITECTURE.md`](../src/backend/gateway/ARCHITECTURE.md).
- `templates/`: message, handoff, role-command, and downstream harness
  templates. `templates/harness/` is the source of truth for the VCM harness
  installed into target repositories, including role agents, skills, tools, and
  project durable doc templates.
- `ws/`: WebSocket bridge (`terminal-ws`) streaming PTY I/O to the frontend.
- `server.ts`, `main.ts`, `app-version.ts`, `vcm-data-dir.ts`, `errors.ts`:
  composition root, CLI entry, version, data-dir resolution, error types.

### Frontend sub-areas (`src/frontend`)

- `routes/`: top-level views (`project-dashboard`, `task-workspace`).
- `components/`: GUI building blocks (app shell, session console/toolbar, role
  session tabs, harness panel/studio, translation panel, message timeline,
  repo connect form, diff modal, error center).
- `state/`: client stores and helpers (`app-store`, `session-store`,
  `api-client`, polling schedulers, translation feed, UI error handling).
- `terminal/`: `xterm` view and terminal websocket client.

### Shared sub-areas (`src/shared`)

- `types/`: domain type contracts shared across layers.
- `validation/`: pure validators (`artifact-check`, `language-detect`,
  `slug-check`).
- `constants.ts`: role definitions and default ports.

## Module Relationships and Dependency Direction

```
frontend  --depends on-->  shared  <--depends on--  backend
   |                                                   ^
   +-------- HTTP /api + WS /ws (api-client) ----------+
```

- `shared` is the leaf layer. It must not import from `backend` or `frontend`.
- `backend` and `frontend` both depend on `shared`, and must not depend on each
  other at the module level.
- The only runtime coupling between frontend and backend is the HTTP `/api`
  surface and the `/ws` WebSocket, mediated on the client by
  `src/frontend/state/api-client.ts` and
  `src/frontend/terminal/terminal-client.ts`.
- Within the backend, the intended direction is
  `api -> services -> (runtime | adapters | gateway | templates)`. Routes should
  not contain business logic; services should reach the outside world only
  through adapters and the runtime.

## Project-Wide Constraints

- Single npm package, ESM only, TypeScript strict mode. Node `^20 || >=22`.
- Keep the layer boundary: no `shared -> backend/frontend` imports, no direct
  `frontend <-> backend` imports.
- Backend and frontend compile under separate tsconfigs
  (`tsconfig.node.json`, `tsconfig.json`); new files must fall inside the correct
  `include` globs, and `npm run typecheck` must pass both.
- Downstream harness behavior is defined by `src/backend/templates/harness/**`;
  change harness output there, not in generated target-repo files.
- Long-running and background process rules from the VCM managed block in
  `CLAUDE.md` apply; never detach processes.
- The npm package ships only built artifacts (`dist`, `dist-frontend`,
  `scripts`, `README.md`). `docs/` is not shipped (it holds internal
  process/design docs, not user-facing or runtime-needed content).

## Generated Context Ownership

Generated indexes under `.ai/generated/` are machine-maintained and regenerated
by the tools in `.ai/tools/`:

- `.ai/generated/module-index.json` — produced by
  `.ai/tools/generate-module-index`. Maps the workspace to layers, modules,
  manifests, module docs, source files, and test files. Use it to locate code and
  confirm module boundaries.
- `.ai/generated/public-surface.json` — produced by
  `.ai/tools/generate-public-surface` (after `module-index.json` exists). It is the
  authoritative machine index of module-to-module public APIs, routes, and
  externally consumed surfaces. Treat it as the full public-surface listing;
  module docs explain meaning and design intent rather than duplicating it.

Regenerate both after changing module layout, public exports, or HTTP routes.

## Durable Documentation Ownership

The fixed installer ships `.ai/tools/check-durable-docs`. Harness Bootstrap,
Architect Docs Sync, and Tester testing-doc updates run it after changing
durable docs. The tool detects high-confidence contract violations such as
resolved issue history, terminal plans left under `docs/plans/`, task history in
architecture/testing docs, missing module architecture docs, and generated
module-count drift.

Semantic consistency remains role-owned: Architect reconciles changed facts
across architecture docs, active plans, known issues, code, and generated
context; Tester owns `docs/TESTING.md`. Final Acceptance requires the relevant
evidence to record a passing audit after durable-doc changes.

Generated indexes own machine inventories and complete public-surface lists.
Durable prose owns current architecture, contract meaning, validation strategy,
active plans, and unresolved limitations. Git, PRs, and task handoffs own
history.

## Auto Memory Ownership

`auto-memory-service` owns project memory under the base repository's
`.ai/vcm/memory/`, task-visible snapshots under the active worktree's matching
path, and review history under `.ai/vcm/memory-review/`. The root `CLAUDE.md`
imports shared memory; each role definition requires that role to read its own
memory file.

After a normal stopped round has valid Final Acceptance, a manual or automatic
Review Task Harness request may start the Auto Memory state machine. Workflow
roles submit proposals sequentially through `vcm-propose-memory`, Harness
Engineer writes the reviewed memory set, and the service applies it to
canonical and task memory together. Active memory files are read-only to role
turns. Auto Memory hook turns update role session activity but do not mutate the
completed task round. The frontend only displays state and invokes memory file,
retry, or revert APIs.

Auto Memory completion is bound to the SHA-256 hash of the current accepted
`final-acceptance.md`. If that artifact changes, the next Review Task Harness
request creates a new memory phase for the new acceptance evidence.
`runtime-coordinator-service` and the manual Harness route use the same
readiness policy. When Auto Memory is disabled, Review Task Harness skips all
memory collection and updates. When enabled, pending, collecting, reviewing, or
failed memory work delays retrospective analysis. The retrospective then
includes memory proposals, applied memory diffs, and current memory in its task
evidence.

Reusable harness feedback from `vcm-report-harness-issue` is a passive inbox.
It is listed for Harness Studio and retrospective evidence, but it does not
auto-dispatch Harness Engineer or create an approval/apply state machine.

## Turn Runtime Ownership

`round-service` owns the active turn and round state. `session-service` owns role
session activity, while the PTY runtime owns Claude process liveness and terminal
output timestamps. `runtime-coordinator-service` runs backend turn reconciliation
every 10 seconds, independently of frontend polling.

`turn-reconciler-service` closes gaps left by a missing Stop hook. A transcript
`end_turn` is reconciled through the normal Stop path; a missing or exited terminal
is reconciled through terminal StopFailure; and a live turn with no hook, terminal,
or transcript activity for 30 minutes is interrupted before StopFailure recovery.
The reconciler never treats inactivity alone as successful completion.

## Task Workflow State Ownership

`task-workflow-service` stores PM-declared workflow context at
`<taskRepoRoot>/.ai/vcm/workflow/state.json`. The declaration records the
current flow, step, optional branch and resume point, status, and evidence
references. It is separate from Round, Turn, Session, Gate Review, and process
state: those services remain the source of truth for observed runtime facts.

PM declarations arrive through PM route-file frontmatter or the
`update-task-state` tool. The backend writes them atomically, returns them in the
task workspace aggregate, and restores saved context into a restarted or
resumed PM session. The frontend only renders the aggregate state. Missing,
stale, malformed, or unwritable workflow state never blocks message delivery,
Gate Review, final acceptance, session launch, or task close.

## Task Close Ownership

`task-close-service` is the single owner of task shutdown for both the GUI and
Gateway. It first persists `cleanupStatus: cleaned`; that logical close releases
the project for another task. Session shutdown (including task-scoped Translator
and Harness Engineer sessions), translation and Round cleanup, forced worktree
removal, stale-directory removal, forced branch deletion, and task-state removal
then run independently as best-effort cleanup. Detection and cleanup failures are
returned as warnings and never reactivate or block the closed task.

`task-service` owns the destructive Git and filesystem operations. Task branches
are force-deleted even when they contain commits absent from the base branch; the
discarded commit list is warning evidence, not a decision gate. If worktree or
branch cleanup remains unresolved, the cleaned task record is retained as a
tombstone. `runtime-recovery-service` retries such tombstones when the project is
connected again.

## Public Surface

The authoritative machine listing of exported APIs, HTTP routes, and externally
consumed surfaces is `.ai/generated/public-surface.json`. Do not duplicate that
listing here.

Design intent of the most externally meaningful surfaces:

- **CLI**: `vcm` with `--help`, `--version`, `--host=`, `--port=`, `--dev`,
  and `--open`.
- **HTTP `/api/*`**: route modules under `src/backend/api/`; this is the
  contract consumed by the frontend and gateway.
- **`/ws`**: terminal I/O streaming contract used by the embedded terminal.
- **`src/shared/types/**`**: typed contracts shared across the HTTP boundary.
- **`src/backend/templates/harness/**`**: downstream-facing harness contract
  installed into target repositories.

## Risks

- Layer-boundary erosion: accidental `frontend <-> backend` imports or
  `shared -> backend/frontend` imports.
- `node-pty` is a native dependency; runtime/spawn changes can be platform
  sensitive.
- Harness template edits affect every downstream repo VCM installs into.
- Shared-type changes are cross-cutting and must typecheck under both frontend
  and backend tsconfigs.
- The npm package ships built artifacts (`dist`, `dist-frontend`, `scripts`,
  `README.md`); runtime-required assets must live in shipped paths.

## Update Triggers

Update this document when:

- a top-level area is added under `src/backend`, `src/frontend`, or `src/shared`;
- dependency rules or layer boundaries change;
- externally meaningful surfaces change in a way that affects consumers;
- a new external integration, gateway channel, or adapter is added.
- post-task Auto Memory or Task Harness Retrospective ownership/order changes.

After these changes, regenerate `.ai/generated/module-index.json` and
`.ai/generated/public-surface.json`.

## Sub-Area Architecture Docs

Root packages do not get a separate module-level `ARCHITECTURE.md` by default.
Create sub-area architecture docs only for clear internal boundaries whose
details would make this project-level overview too noisy.

Existing sub-area docs:

- Mobile gateway: [`src/backend/gateway/ARCHITECTURE.md`](../src/backend/gateway/ARCHITECTURE.md)
  — channel abstraction, poll/inbound/PM-push flows, settings/persistence,
  dependency direction, security model, and a correctness review.
