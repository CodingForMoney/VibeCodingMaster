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
  Per-task role sessions launch (and resume) in their task worktree. Project-level
  tool sessions (translator, harness-engineer) instead anchor launch/resume cwd
  and `transcriptPath` at the base `repoRoot` and enter the active task worktree
  via `/cd`: Claude anchors a transcript to its first-launch cwd and never
  relocates it on `/cd`, so the constant `repoRoot` anchor keeps `claude --resume`
  valid across task close/create boundaries (the worktree may be deleted) and
  keeps `transcriptPath` stable; the active task root is exposed through
  `VCM_TASK_REPO_ROOT` independent of pty cwd. The `/cd` is emitted as a bare,
  unquoted path (Claude Code's `/cd` consumes the literal rest-of-line; quoting
  breaks it) and is on-demand — it fires only when the session's tracked cwd
  differs from the target. Because `claude --resume` restores the session's prior
  working directory, a resume that lands back in the same task worktree issues no
  `/cd`; `/cd` fires on a fresh launch (repoRoot -> worktree) or a real switch
  (e.g. into a different/new task). Project-level tool sessions report
  their project sentinel (not the active task) as `VCM_TASK_SLUG`, so their hook
  payloads match their own session record; the hook layer additionally ignores
  round/status mutations from any session whose authoritative record is not bound
  to the posted task (defensive task-binding guard).
- **Round / orchestration**: `round-service` and `command-dispatcher` drive the
  role route (`project-manager -> architect -> coder -> reviewer -> docs sync ->
  PM final acceptance`) under manual or automatic orchestration. Orchestration
  decisions are backend-owned and the GUI consumes them rather than re-deriving:
  the active role tab follows the authoritative `roundState.activeRole` (no
  client-side message-diff), and `round-service.computeFlowPause` emits the
  authoritative `roundState.flowPause` signal (paused + reason) that the GUI uses
  for pause alerts — the GUI keeps only alert mechanics (dedupe, sound, viewing
  gate, wording). One reason is `awaiting-user`: when a user-facing role
  (project-manager) settles to stopped with no onward route, `round-service`
  persists a sticky await-user anchor on the round state, surfaced through
  `flowPause` (reason `awaiting-user`, with `role` and `since`). The GUI renders
  it as the standard transient flow-pause modal + alarm. The anchor is sticky — it
  survives round auto-continuation and other roles' activity (including
  gate-reviewer) and clears only when the awaiting role receives the user's next
  prompt — so the GUI fires the alert exactly once per pending decision by keying
  `getFlowPauseNotificationKey` (`src/frontend/state/flow-pause-alert.ts`) on the
  stable `(reason, since)` (non-sticky pauses still key on `roundId:stoppedAt`),
  and labels it via the authoritative `flowPause.role` (not the live `activeRole`,
  which may have advanced under another role). While a role is actively recovering,
  await-user is intentionally not surfaced and reappears once recovery resolves.
- **Await-user design tension (retained intentionally)**: issue #17 originally
  surfaced await-user as a persistent web banner carrying the PM's captured
  user-facing reply (`flowPause.message`); that banner was removed at the user's
  request in favor of the prior transient modal + alarm. The backend still computes
  the full sticky pipeline — including the best-effort PM-reply capture
  (`claude-transcript-reply`, also used independently by the gateway push path),
  the `pendingUserReply` stash, and `flowPause.message` — but with the banner gone
  the captured `message` is no longer read on the web. The sticky reason/`role`/
  `since` and the task-binding guard remain load-bearing; the message-capture
  pipeline is currently inert on the web surface (tracked in known issues).
- **One-click start**: `task-launch-service` is the single backend owner of
  one-click task start — it composes the role roster (CORE roles plus gate-reviewer
  when enabled), applies the launch-template orchestration mode, and starts/resumes
  each role with atomic partial-start semantics. Both the
  `POST /api/tasks/:taskSlug/one-click-start` endpoint and the mobile gateway call
  it, so the GUI and gateway paths cannot drift; the GUI issues a single call. It
  is a small cycle-free service (the obvious homes would cycle:
  runtime-coordinator depends on the gateway, and session-service cannot depend on
  message-service).
- **Messaging**: `message-service` persists the message bus; PM-mediated route
  files dispatch work between roles.
- **Harness**: `harness-service` plus `templates/harness/**` produce the
  two-stage harness (deterministic install + AI-assisted bootstrap) for target
  repos; `harness-feedback-service` records harness issues.
- **Gate Review**: `gate-review-service` runs optional gate turns bound to the
  current task/worktree.
- **Translation**: `translation-service`, `translation-queue`, and
  `translation-worker-service` read Claude transcript JSONL and feed the GUI
  translation panel without writing into handoffs. The serial queue persists in
  `runtime/queue.json`. Conversation (composer in/out) translation writes to a
  single shared, self-describing `runtime/conversations/result.json` that carries
  the active `batchId` plus per-index results, so crash recovery re-associates the
  output with the right queue item by validating that in-file `batchId`
  all-or-nothing (exists, parses, identity matches, all expected indexes present);
  on any mismatch it degrades safely to a stale-release rather than mis-assigning.
  File translation keeps per-task runtime job directories and durable
  `files/completed/*` outputs.
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
- Package shipping only `dist*`/`scripts`/`README.md` (not `src/` or `docs/`)
  means runtime-required assets must live in shipped paths.

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
