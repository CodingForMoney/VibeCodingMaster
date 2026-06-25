# Architecture

Project-level architecture for VibeCodingMaster (VCM). VCM is a single npm
package that provides a local GUI cockpit for running and orchestrating multiple
Claude Code role sessions around one engineering task.

This document is architect-owned. It gives the project-wide module overview,
responsibilities, relationships, dependency direction, and constraints. The
module-level detailed design lives in [`ARCHITECTURE.md`](../ARCHITECTURE.md) at
the repository root (the single workspace module recorded in
`.ai/generated/module-index.json`).

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
  endpoint and the gateway), `session-service`, `round-service`,
  `runtime-coordinator-service`, `message-service`, `harness-service`,
  `gate-review-service`, `translation-service`/`translation-worker-service`,
  `job-guard-service`, and `command-dispatcher`.
- `runtime/`: PTY-backed terminal runtime (`node-pty-runtime`,
  `terminal-runtime`, `session-registry`, `terminal-submit`) that supervises one
  Claude Code process per role.
- `adapters/`: side-effect boundaries — `claude-adapter`, `git-adapter`,
  `command-runner`, `filesystem`.
- `gateway/`: mobile gateway service plus channel implementations
  (Weixin iLink, Lark) and command parsing.
- `templates/`: message/handoff/role-command templates and, under
  `templates/harness/`, the source of truth for the VCM harness that VCM installs
  into downstream repositories.
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

## Module-Level Architecture Docs

- Root module: [`ARCHITECTURE.md`](../ARCHITECTURE.md) — detailed design,
  boundaries, behavior, public surface explanation, risks, and update triggers
  for the `vibe-coding-master` workspace module.
