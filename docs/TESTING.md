# Testing

Reviewer-owned validation strategy for VibeCodingMaster (VCM). This document maps
the VCM validation levels to project-native commands, where tests live, how to
select what to run, and the current testing gaps.

## Validation Levels and Commands

All commands run from the repository root (the task worktree during a VCM task).

| Level | Scope | Command(s) |
| --- | --- | --- |
| L0 fast checks | Format/lint/typecheck/boundary. Project ships typecheck across both tsconfigs. | `npm run typecheck` |
| L1 coder unit checks | Changed behavior + direct regressions via Vitest unit tests. | `npm test` (optionally a scoped `npx vitest run <path>`) |
| L2 module / integration checks | Module/API/runtime wiring. Vitest config reserves `tests/integration/api/**` and `tests/integration/runtime/**`. | `npm test` (runs unit + any integration tests that exist) |
| L3 smoke E2E checks | Core GUI journeys via Playwright. | `npm run e2e` |
| L4 full regression / release | Build + package verification before publish. | `npm run build` then `npm run verify:package` |

Notes:

- `npm run typecheck` runs `tsc` against both `tsconfig.json` (frontend + shared)
  and `tsconfig.node.json` (backend), so it is the boundary/type gate for the
  whole module.
- `npm test` is `vitest run`. Its `include` globs already cover unit and the
  reserved integration directories, so a single `npm test` is both L1 and L2 once
  integration tests exist.
- `npm run e2e` is `playwright test` against `tests/e2e`, and its `webServer`
  starts `npm run dev` automatically (reusing an existing server if one is up).

## Validation Selection Rules

- Docs-only or comment-only change: L0 (`npm run typecheck`) is usually enough; no
  code behavior to retest.
- `src/shared/**` change: always L0 + L1, because shared types/validators are
  cross-cutting to both backend and frontend.
- `src/backend/**` change: L0 + the affected `tests/unit/backend/**` files; run
  full `npm test` before handoff. Add L2 when touching runtime, routes, or
  cross-service wiring.
- `src/frontend/**` change: L0 + the affected `tests/unit/frontend/**` files; add
  L3 (`npm run e2e`) when changing a core user journey (connect repo, create task,
  start/resume a role session, send a message, translation panel).
- `src/backend/templates/harness/**` change: L0 + `npm test` (harness template
  sync and harness service/route tests guard these), because output ships into
  downstream repos.
- `.ai/tools/**` or `scripts/harness-tools/**` change: run
  `tests/unit/backend/harness-tools.test.ts` and `vcm-bash-guard.test.ts`.
- Pre-publish / release: L4 (`npm run build` + `npm run verify:package`).

## Long-Running Validation

Use the `vcm-long-running-validation` skill (`.ai/tools/run-long-check` +
`.ai/tools/watch-job`) for any command that may exceed ~2 minutes (notably
`npm run e2e` and full builds). Never run validation as a detached/background
process; the job guard denies it. Honor the 60-minute per-job ceiling.

## Test Layout

```
tests/
  unit/
    backend/   # services, routes, runtime, adapters, gateway, harness, tools
    frontend/  # api-client, stores, components (message timeline, harness panel, translation panel)
    shared/    # pure validators (artifact-check, language-detect, slug-check)
  integration/ # reserved by vitest config: api/**, runtime/** (not yet present)
  e2e/         # reserved by playwright config (not yet present)
```

- Place unit tests next to their layer under `tests/unit/<layer>/` named
  `<subject>.test.ts`.
- Place integration tests under `tests/integration/api/**` or
  `tests/integration/runtime/**` so the existing Vitest `include` picks them up.
- Place Playwright specs under `tests/e2e/`.

## Integration / E2E Case List

These are reserved by configuration but not yet implemented. They are the
recommended first cases when integration/E2E coverage is added.

### Integration (reserved: `tests/integration/api/**`, `tests/integration/runtime/**`)

| ID | Scenario | Entry point | Proves | Key assertions | When to run | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| INT-API-001 | Project + task lifecycle over HTTP | Fastify app via `project-routes` / `task-routes` | Routes + services persist task state correctly | Create project, create task, read back task, status transitions | L2, on backend api/service change | Not yet implemented |
| INT-API-002 | Message bus round trip | `message-routes` / `message-service` | Route-file dispatch and history persistence | Posted message is persisted and retrievable in order | L2, on messaging change | Not yet implemented |
| INT-RT-001 | Session start/resume lifecycle | `runtime-coordinator-service` + `session-registry` | PTY session can start, persist id, and resume | Session id persisted; resume reuses id; stop cleans registry | L2, on runtime change | Not yet implemented; needs `claude`/pty test doubles |

### E2E (reserved: `tests/e2e/`)

| ID | Scenario | Entry point | Proves | Key assertions | When to run | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| E2E-001 | Connect repository and create a task | GUI at `http://127.0.0.1:5173` | Core onboarding journey works end to end | Repo connects, branch/status render, task appears in list | L3, before release / on shell or routing change | Not yet implemented; requires a real `claude` binary for live sessions |
| E2E-002 | Start a role session and observe terminal output | Task workspace role tabs | Embedded terminal streams PTY output over `/ws` | Session starts, xterm receives output, status badge updates | L3, on runtime/terminal change | Not yet implemented; environment-dependent |
| E2E-003 | Translation panel renders translated transcript | Translation panel | Translator session reads transcript JSONL and renders | Panel shows translated entries without mutating handoffs | L3, on translation change | Not yet implemented |

## Generated-Context Freshness Checks

- Regenerate `.ai/generated/module-index.json` with `.ai/tools/generate-module-index`
  after adding/removing/moving modules, source files, or test files.
- Regenerate `.ai/generated/public-surface.json` with
  `.ai/tools/generate-public-surface` (after module-index exists) after changing
  exported APIs, HTTP routes, or shared types.
- Treat stale generated indexes as a validation failure during review: if a
  source/route/export change is not reflected in the indexes, regenerate before
  acceptance.

## Final-Validation Cleanup

- Remove temporary scripts, scratch files, and any test-only fixtures created
  during investigation before final acceptance.
- Do not leave `.only`/`.skip` in committed Vitest or Playwright specs.
- Ensure no detached/background validation jobs remain running.
- Confirm generated indexes are regenerated and committed when source/surface
  changed.
- Before publish, `npm run build` and `npm run verify:package` must pass.

## Known Testing Gaps

- No integration tests exist yet; `tests/integration/**` is configured but empty.
- No E2E tests exist yet; `tests/e2e/**` is configured (Playwright) but empty.
- E2E and live runtime tests depend on a real `claude` binary and `node-pty`,
  which are environment-sensitive and not currently stubbed for CI.
- There is no lint command in `package.json`; L0 is currently typecheck-only.
- Coverage thresholds are not enforced by configuration.
