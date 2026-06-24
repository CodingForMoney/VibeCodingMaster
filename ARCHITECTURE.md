# Module Architecture: `vibe-coding-master`

Module-level detailed design for the single workspace module recorded in
`.ai/generated/module-index.json`. For the project-wide overview and dependency
direction, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Module Boundary

The module is the entire npm package and is internally split into three source
layers under `src/`:

- `src/backend` — Node/Fastify server process and runtime.
- `src/frontend` — React/Vite browser GUI.
- `src/shared` — types, constants, and validators shared by both.

External boundaries of the module:

- CLI entry `vcm` (`dist/main.js`, source `src/main.ts`).
- HTTP API on the backend port (default 4173) and a `/ws` WebSocket.
- Spawned `claude` Claude Code processes (one per role) via `node-pty`.
- Git working trees / worktrees on disk and durable state under `vcmDataDir`.
- Optional mobile gateway channels (Weixin iLink, Lark) reaching external chat
  platforms.

## Responsibilities

- Connect to a base git repository and manage per-task git worktrees.
- Create tasks and supervise one Claude Code session per VCM role inside embedded
  terminals.
- Mediate role-to-role messaging through PM-dispatched route files and persist
  message history, session state, and handoff artifacts.
- Run and gate the VCM task flow (manual and automatic orchestration, Gate
  Reviews, final acceptance).
- Provide a translation panel backed by a long-lived translator session reading
  Claude transcript JSONL.
- Author and install the VCM harness into downstream repositories.
- Enforce background-job limits (job guard, long-running validation wrappers).

## Allowed Dependencies

- `backend` may import from `shared`; never from `frontend`.
- `frontend` may import from `shared`; never from `backend`.
- `shared` imports from neither `backend` nor `frontend` (leaf layer).
- Within `backend`: `api -> services -> runtime | adapters | gateway | templates`.
  Routes stay thin; side effects (process spawn, git, filesystem, network) go
  through `adapters/` and `runtime/`.
- Within `frontend`: components and routes reach the backend only through
  `state/api-client.ts` and `terminal/terminal-client.ts`.

## Important Behavior

- **Composition root**: `src/main.ts` parses CLI flags and calls
  `startServer` in `src/backend/server.ts`, which registers the `api/` route
  modules and the `ws/terminal-ws` bridge.
- **Session runtime**: `runtime/` owns PTY lifecycle and a `session-registry`;
  `runtime-coordinator-service` and `session-service` coordinate start/stop/
  resume/restart, persisting Claude session ids for `claude --resume` recovery.
- **Round / orchestration**: `round-service` and `command-dispatcher` drive the
  role route (`project-manager -> architect -> coder -> reviewer -> docs sync ->
  PM final acceptance`) under manual or automatic orchestration.
- **Messaging**: `message-service` persists the message bus; PM-mediated route
  files dispatch work between roles.
- **Harness**: `harness-service` plus `templates/harness/**` produce the
  two-stage harness (deterministic install + AI-assisted bootstrap) for target
  repos; `harness-feedback-service` records harness issues.
- **Gate Review**: `gate-review-service` runs optional gate turns bound to the
  current task/worktree.
- **Translation**: `translation-service`, `translation-queue`, and
  `translation-worker-service` read Claude transcript JSONL and feed the GUI
  translation panel without writing into handoffs.
- **Gateway**: `gateway-service` and channel adapters let the user talk to PM and
  manage tasks from a phone.
- **Job safety**: `job-guard-service` and `.ai/tools` wrappers enforce no
  detached/background processes and the long-running validation contract.

## Public Surface

The authoritative, full machine listing of this module's exported APIs, HTTP
routes, and externally consumed surfaces is
`.ai/generated/public-surface.json`. Do not duplicate that listing here.

Design intent of the most externally meaningful surfaces:

- **CLI**: `vcm` with `--help`, `--version`, `--host=`, `--port=`, `--dev`,
  `--open`.
- **HTTP `/api/*`**: one route module per domain in `src/backend/api/`; these are
  the contract the frontend and gateway consume.
- **`/ws`**: terminal I/O streaming contract used by the xterm client.
- **`src/shared/types/**`**: the typed contracts shared across the HTTP boundary;
  changes here ripple to both layers.
- **`src/backend/templates/harness/**`**: the downstream-facing harness contract
  installed into other repositories.

## Risks

- Layer-boundary erosion (accidental `frontend <-> backend` or
  `shared -> backend/frontend` imports) is the primary architectural risk.
- `node-pty` is a native dependency; runtime/spawn changes can be platform
  sensitive (see `scripts/fix-node-pty-spawn-helper.mjs`).
- Harness template edits affect every downstream repo VCM installs into; they are
  higher blast-radius than ordinary GUI changes.
- Shared-type changes are cross-cutting and must be typechecked under both
  tsconfigs.
- Package shipping only `dist*`/`docs`/`scripts` means runtime-required assets
  must live in shipped paths.

## Update Triggers

Update this document when:

- a new top-level area is added under `src/backend`, `src/frontend`, or
  `src/shared`;
- the allowed dependency rules or layer boundaries change;
- the externally meaningful surfaces (CLI flags, `/api` domains, `/ws` contract,
  shared types, harness templates) change in a way that affects consumers;
- a new external integration (gateway channel, adapter) is added.

After any of these, also regenerate `.ai/generated/module-index.json` and
`.ai/generated/public-surface.json`.
