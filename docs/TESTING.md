# Testing

Tester-owned validation strategy for VibeCodingMaster (VCM). This document maps
the VCM validation levels to project-native commands, where tests live, how to
select what to run, and the current testing gaps.

## Validation Levels and Commands

All commands run from the repository root (the task worktree during a VCM task).

| Level | Scope | Command(s) |
| --- | --- | --- |
| L0 fast checks | Format/lint/typecheck/boundary. Project ships typecheck across both tsconfigs. | `npm run typecheck` |
| L1 coder unit checks | Changed behavior + direct regressions via Vitest unit tests. | `npm run build` then `npm test` on a clean tree (build first — see note); optionally a scoped `npx vitest run <path>` |
| L2 module / integration checks | Module/API/runtime wiring, including backend E2E with mock Claude Code and Gateway runtimes. | `npm run build` then `npm test` on a clean tree (build first — see note); use `npm run test:e2e:backend` for backend orchestration journeys |
| L3 smoke E2E checks | Core GUI journeys via Playwright. | `npm run e2e` |
| L4 full regression / release | Build + package verification before publish. | `npm run build` then `npm run verify:package` |

Notes:

- `npm run typecheck` runs `tsc` against both `tsconfig.json` (frontend + shared)
  and `tsconfig.node.json` (backend), so it is the boundary/type gate for the
  whole module.
- `npm test` is `vitest run`. Its `include` globs cover unit, reserved
  integration, and backend E2E tests, so the full suite includes all non-browser
  validation.
- **Build before `npm test` on a clean tree.**
  `tests/unit/backend/harness-templates-sync.test.ts` shells out to the compiled
  CLI (`dist/main.js`), so run `npm run build` first; otherwise those 5 cases fail
  with "compiled CLI not found" — a build-state failure, not a regression. This is
  why the Release Gate below runs `build` before `test` (see also "Known Testing
  Gaps").
- `npm run e2e` is `playwright test` against future browser specs under
  `tests/e2e`; `tests/e2e/backend/**` is excluded. Its `webServer` starts
  `npm run dev` automatically (reusing an existing server if one is up).
- `npm run test:e2e:backend` runs the backend journeys under
  `tests/e2e/backend/**` with deterministic Claude Code and Gateway doubles; it
  does not require a live Claude process or browser.

## Validation Selection Rules

- Docs-only or comment-only change: L0 (`npm run typecheck`) is usually enough; no
  code behavior to retest.
- `src/shared/**` change: always L0 + L1, because shared types/validators are
  cross-cutting to both backend and frontend.
- `src/backend/**` change: L0 + the affected `tests/unit/backend/**` files; run
  full `npm test` before handoff. Add L2 when touching runtime, routes, or
  cross-service wiring.
- Session lifecycle, round routing, Gate Review, translation, Gateway, Auto
  Memory, or Harness Retrospective change: run `npm run test:e2e:backend`.
- Turn or terminal-process lifecycle changes: run `round-service.test.ts`,
  `session-service.test.ts`, `terminal-process-exit-service.test.ts`, and
  `runtime-recovery.e2e.test.ts`. Verify transcript output cannot complete a
  Turn, blocked Stop remains running, and a real PTY exit stops the active Round.
- Runtime Coordinator changes: run `runtime-coordinator-service.test.ts` and
  verify fresh and resumable task-scoped tool Sessions are reconciled without a
  frontend trigger.
- CCR model integration change: run `ccr-gateway-adapter.test.ts`,
  `ccr-integration-service.test.ts`, `ccr-api-key-helper.test.ts`,
  `claude-adapter.test.ts`, `claude-transcript-service.test.ts`,
  `session-registry.test.ts`, and `ccr-integration.e2e.test.ts`; verify isolated
  CCR configuration/transcript paths, native environment cleanup, same-provider
  Resume, and provider switching through Restart. Run the complete backend E2E
  suite when changing Session launch wiring.
- Task usage analytics change: run `usage-analytics-service.test.ts`,
  `usage-analytics-modal.test.ts`, `api-client.test.ts`,
  `usage-analytics.e2e.test.ts`, and `ccr-integration.e2e.test.ts`. Verify
  retried OTLP batches are deduplicated, concurrent batches do not lose data,
  all seven roles aggregate across launches and sessions, CCR/GPT processes do
  not export usage, and no raw event files are retained.
- Task workflow-state changes: run `task-workflow-service.test.ts`,
  `message-service.test.ts`, `session-service.test.ts`, and
  `task-routes.test.ts`; verify corrupt or unavailable state remains
  non-blocking.
- `src/frontend/**` change: L0 + the affected `tests/unit/frontend/**` files; add
  L3 (`npm run e2e`) when changing a core user journey (connect repo, create task,
  start/resume a role session, send a message, translation panel).
- `src/backend/templates/harness/**` change: L0 + `npm test` (harness template
  sync and harness service/route tests guard these), because output ships into
  downstream repos.
- Auto Memory or Task Harness Retrospective sequencing change: run
  `auto-memory-service.test.ts`, `runtime-coordinator-service.test.ts`, and
  `harness-routes.test.ts`, then `npm run test:e2e:backend`. These tests cover
  current Final Acceptance hashing, automatic and manual readiness enforcement,
  workflow-role proposal Round tracking, and Harness Engineer exclusion from the
  Round.
- `.ai/tools/**` or `scripts/harness-tools/**` change: run
  `tests/unit/backend/harness-tools.test.ts` and `vcm-bash-guard.test.ts`.
- Durable-doc template or audit change: run
  `tests/unit/backend/harness-tools.test.ts`,
  `tests/unit/backend/harness-templates-sync.test.ts`, and
  `tests/unit/backend/harness-service.test.ts`. The audit tests cover clean
  current-state docs and representative history, plan, and generated-context
  drift failures.
- Pre-publish / release: L4 (`npm run build` + `npm run verify:package`).

## Long-Running Validation

Use the `vcm-long-running-validation` skill (`.ai/tools/run-long-check` +
`.ai/tools/watch-job`) for any command that may exceed ~2 minutes (notably
`npm run e2e` and full builds). Never run validation as a detached/background
process; the job guard denies it. Pass the validation executable directly:
`run-long-check` rejects shell command-string wrappers because pipelines or
trailing commands can mask the validation exit code. Honor the 60-minute
per-job ceiling.

## Release Gate (L4)

Run this gate for any version release before `npm publish`. The release is
architect-owned (see root `CLAUDE.md` "Release Process"); the tester runs the
gate and reports results.

1. `npm run typecheck`
2. `npm run build` (must run before `npm test`: `harness-templates-sync` needs the compiled `dist/main.js`)
3. `npm test`
4. `npm run verify:package`
5. `npm pack --dry-run`, then verify tarball contents:
   - tarball name/version matches the bumped version (e.g. `vibe-coding-master-<version>.tgz`);
   - only whitelisted paths are present (`dist`, `dist-frontend`, `scripts`, `README.md`, `package.json`, plus npm's auto-included `LICENSE`); note `docs/` is intentionally NOT shipped as of 0.5.1;
   - no leak of `src/`, `tests/`, `.ai/`, `.claude/worktrees/`, or local runtime state.

Notes:

- `npm run verify:package` asserts that required files are **present** and that
  `package.json` `files`/`bin` are correct, but it does not assert the **negative**
  (that non-whitelisted paths are absent). Step 5's `npm pack --dry-run` content
  review is what currently covers that negative-leak check — do not skip it.
- Publish (`npm publish`) is foreground, irreversible, and may prompt for an
  interactive OTP/2FA. Run it directly in the foreground, never through the
  detached `run-long-check`/`watch-job` tooling. When the user has explicitly
  requested the release, proceed without a redundant re-confirmation step.

## Test Layout

```
tests/
  unit/
    backend/   # services, routes, runtime, adapters, gateway, harness, tools
    frontend/  # api-client, stores, components (message timeline, harness panel, translation panel)
    shared/    # pure validators (artifact-check, language-detect, slug-check)
  integration/ # reserved by vitest config: api/**, runtime/** (not yet present)
  e2e/
    backend/   # mock Claude Code/Gateway backend journeys run by Vitest
    # browser Playwright specs may be added here later
```

- Place unit tests next to their layer under `tests/unit/<layer>/` named
  `<subject>.test.ts`.
- Place integration tests under `tests/integration/api/**` or
  `tests/integration/runtime/**` so the existing Vitest `include` picks them up.
- Place backend E2E tests under `tests/e2e/backend/` named
  `<journey>.e2e.test.ts`.
- Place future Playwright specs under `tests/e2e/` using Playwright's spec
  naming convention so they remain separate from the Vitest backend suite.

## Integration / E2E Case List

### Integration (reserved: `tests/integration/api/**`, `tests/integration/runtime/**`)

| ID | Scenario | Entry point | Proves | Key assertions | When to run | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| INT-API-001 | Project + task lifecycle over HTTP | Fastify app via `project-routes` / `task-routes` | Routes + services persist task state correctly | Create project, create task, read back task, status transitions | L2, on backend api/service change | No dedicated integration spec; exercised by backend E2E journeys |
| INT-API-002 | Message bus round trip | `message-routes` / `message-service` | Route-file dispatch and history persistence | Posted message is persisted and retrievable in order | L2, on messaging change | No dedicated integration spec; exercised by backend E2E routing journeys |
| INT-RT-001 | Session start/resume lifecycle | `runtime-coordinator-service` + `session-registry` | PTY session can start, persist id, and resume | Session id persisted; resume reuses id; stop cleans registry | L2, on runtime change | Covered with the mock Claude runtime; live PTY coverage remains absent |
| INT-RT-002 | Post-task memory and harness review order | Final Acceptance + Review Task Harness + `runtime-coordinator-service` + Harness route | A normally stopped complete flow collects optional Auto Memory proposals before one Task Harness Retrospective | With Auto Memory on, workflow-role proposal hooks start and stop a normal Round, then one Harness Engineer turn reviews every proposal item and pending feedback, writes an item-level memory report and matching reviewed memory, and applies memory; with Auto Memory off, that prompt omits every memory path | L2, on Auto Memory or retrospective change | Covered by backend E2E with mock role sessions |
| INT-GATE-003 | Tester-owned test-infrastructure repair | Test report contract + PM flow rules + validation/code-diff Gate contracts | A defect confined to tests, fixtures, test-only helpers, or `docs/TESTING.md` stays Tester-owned inside a code-producing flow | Unresolved repair status cannot enter validation review; repaired evidence records boundary, class sweep, commit, and rerun; code-diff findings classify `test-only` versus `implementation` for deterministic PM routing | L2, on Tester or Gate workflow change | Covered by artifact, harness-template, Gate service, and backend E2E tests |
| INT-RT-003 | Manual Harness Feedback delivery | Harness Studio + `POST /api/projects/harness/feedback/send` | A user can send one pending report to the active task's Harness Engineer without automatic queue processing | Only a path still present in the pending Inbox is accepted; the exact absolute path is submitted; the report remains pending | L1, on Harness Feedback changes | Covered by service and route unit tests; live PTY coverage remains absent |

### Backend E2E (implemented: `tests/e2e/backend/`)

The backend suite currently covers these journeys through real routes and
services with controlled runtime doubles:

- PM-to-role routing, round completion, retryable failures, and manual
  interruption without retry.
- Session ID persistence, restart/close behavior, backend restart recovery, and
  resuming a recovered Claude session.
- Complete architecture, code, test, Gate Review callback, Final Acceptance,
  and automatic Task Harness Retrospective orchestration.
- Architecture, validation, and code-diff rejection/correction loops, including
  corrected commit source chains and unchanged-input suppression.
- Tester `incomplete` report validation and backend refusal to start
  Validation Adequacy Gate before remaining validation completes.
- Role-scoped translation feeds and Gateway input/output translation without
  duplicate translation work.
- Auto Memory proposal collection followed by memory review inside the same
  Task Harness Retrospective, plus direct retrospective execution when Auto
  Memory is disabled. The Auto Memory journey also proves that workflow-role
  proposals produce a running then stopped Round while Harness Engineer remains
  excluded. Unit coverage verifies strict proposal fields and rejects
  missing necessity, absence-impact, durable-document, and existing-memory
  retention analysis before apply. Architect restart coverage verifies
  that Auto Memory assigns and preserves a planning-session candidate, blocks
  replacement when that candidate is missing, and supplies its run snapshot to
  the final Architect proposal and Harness Engineer review.
- PM-declared task workflow state persistence, workspace aggregation, and PM
  session restoration.
- CCR settings redaction, authenticated model availability, native-vs-CCR
  command behavior, GPT-only settings overrides, global CCR takeover cleanup,
  blocked unavailable launches, and shared CCR child environment across
  workflow, Reviewer, Translator, and Harness Engineer Session paths.
- Native Claude OpenTelemetry ingestion into the active task worktree, including
  task, role, and model aggregation; deduplication and concurrent-write behavior
  are covered by service tests, while CCR exclusion is covered by the CCR
  journey.
- Workflow-role launch-template normalization remains separate from tool Session
  defaults. Route tests verify that explicit tool Start and Restart persist the
  successful options while Resume and automatic startup do not.

Run all backend journeys with `npm run test:e2e:backend`.

### Browser E2E (reserved: `tests/e2e/`)

| ID | Scenario | Entry point | Proves | Key assertions | When to run | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| E2E-001 | Connect repository and create a task | GUI at `http://127.0.0.1:5173` | Core onboarding journey works end to end | Repo connects, branch/status render, task appears in list | L3, before release / on shell or routing change | Not yet implemented; requires a real `claude` binary for live sessions |
| E2E-002 | Start a role session and observe terminal output | Task workspace role tabs | Embedded terminal streams PTY output over `/ws` | Session starts, xterm receives output, status badge updates | L3, on runtime/terminal change | Not yet implemented; environment-dependent |
| E2E-003 | Translation panel renders translated transcript | Translation panel | Translator session reads transcript JSONL and renders | Panel shows translated entries without mutating handoffs | L3, on translation change | Not yet implemented |
| E2E-004 | Auto-orchestration journey (one-click → auto-follow → flow-pause) | GUI task workspace, auto mode | The relocated backend-owned orchestration drives the GUI end to end | One-click starts the roster via `POST /api/tasks/:slug/one-click-start`; the role tab follows `roundState.activeRole`; a stopped round with no next turn raises the `roundState.flowPause` notice | L3, on one-click/round/role-follow change | Not yet implemented; needs a Playwright harness + live `claude`/pty. Until then the three contracts are covered at integration level: task-routes inject + gateway inbound (P1), active-role-follow + app wiring (P2), round-service flowPause matrix + flow-pause-alert (P3) |
| E2E-005 | Flow-pause alert (a Round stops with no next Turn → blocking modal + optional alarm sound) | GUI task workspace; backend `roundState.flowPause` (reason `stopped-no-next-turn`) via workspace-state | A normally stopped Round opens the standard blocking flow-pause modal; sound is independent and repeats while enabled; Gateway does not suppress the modal, and successfully submitted Gateway input dismisses it | `selectFlowPauseAlertMessage` uses the backend pause signal; sound mode is `strong` whenever the preference is enabled; the latest successful Gateway-to-PM input ID is deduplicated before requesting dismissal | L3, on Round / flow-pause-alert change | Not yet implemented as a browser spec; covered below L3 by `flow-pause-alert.test.ts` and Gateway backend E2E status assertions |
| E2E-006 | Gateway runtime connection switch arms/disarms the channel | Project dashboard `GatewayPanel` Connection switch | The desktop toggle gates channel connection (default off each session) end to end | Connection switch is disabled until an account is configured; arming it sets `connectionEnabled`/`running` and the phone can drive the gateway; disarming stops polling; it stays visually distinct from the `Gateway` (command-scope) switch | L3, on gateway connection/dashboard change | Not yet implemented; needs a Playwright harness + a channel double. Until then PP1–PP6 (default-disarmed, arm/connect, disarm/stop, disarmed-outbound-gate-with-cache, self-heal-cannot-bypass, expose orthogonality) are covered at unit level in `gateway-service.test.ts` / `gateway-settings-service.test.ts`; the live UI arm/disarm is verified by static wiring review + manual desktop check |

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

New entries require the user's explicit approval after the applicable
Architect Debug and Architecture Diagnosis work has failed to resolve the
required validation gap. Approval permits the exact gap to remain; it does not
change the factual Tester result.

- No integration tests exist yet; `tests/integration/**` is configured but empty.
- No browser/Playwright E2E specs exist yet. Backend E2E coverage exists under
  `tests/e2e/backend/**` and uses mock Claude Code and Gateway runtimes.
- Live runtime and browser E2E still depend on a real `claude` binary,
  `node-pty`, and browser environment; those paths remain environment-sensitive.
- There is no lint command in `package.json`; L0 is currently typecheck-only.
- Coverage thresholds are not enforced by configuration.
- `tests/unit/backend/harness-templates-sync.test.ts` shells out to
  `scripts/install-vcm-harness.mjs`, which needs the compiled CLI (`dist/main.js`).
  On a clean checkout with no `dist/`, those 5 cases fail with
  "compiled CLI not found. Run npm run build first." Run `npm run build` before
  `npm test` (or treat these specific failures as build-state, not regressions)
  when validating from a clean tree.
- `tests/unit/backend/translation-worker-service.test.ts` can intermittently fail
  with an `ENOTEMPTY` error during a full parallel `npm test` run because its
  per-case temp directories are cleaned up concurrently. It is an environmental
  test-isolation flake, not a product regression: re-run the file on its own
  (`npx vitest run tests/unit/backend/translation-worker-service.test.ts`) to
  confirm 23/23 before treating any `ENOTEMPTY` as a real failure.
- `npm run verify:package` does not assert the negative (that non-whitelisted
  paths such as `src/`/`tests/`/`.ai/` are absent from the published tarball); that
  leak check is currently manual via the Release Gate's `npm pack --dry-run` step.
