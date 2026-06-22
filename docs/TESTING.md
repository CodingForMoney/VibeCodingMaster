# Testing

Validation strategy for `vibe-coding-master` (TypeScript/Node app). Reviewer-owned.

## Validation Levels & Commands

| Level | Scope | Command |
| --- | --- | --- |
| L0 | format / typecheck | `npm run typecheck` (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.node.json --noEmit`) |
| L1/L2 | unit + module/integration tests | `npm run test` (vitest, runs `tests/unit/**` and `tests/integration/**`) |
| L3 | smoke / E2E (browser) | `npm run e2e` (Playwright) |
| L4 | full regression / release | `npm run prepack` (build + `verify:package`) + full `npm run test` + `npm run e2e` |

Targeted run: `npx vitest run <path/to/test.ts>`.

### Test environment note

`vitest.config.ts` runs in `environment: "node"` (no jsdom). Frontend tests are
therefore either pure-helper tests or component tests rendered with
`react-dom/server` `renderToStaticMarkup` (static HTML assertions), not DOM/event
tests. Component modules that load browser globals at import time (e.g. the
xterm-backed `terminal/xterm-view`) must be stubbed with `vi.mock` before the
component under test is imported.

## Required prerequisite: build before full `npm run test`

`tests/unit/backend/harness-templates-sync.test.ts` spawns the real harness
installer (`scripts/install-vcm-harness.mjs`), which runs the compiled CLI at
`dist/backend/cli/install-vcm-harness.js`, falling back to the TypeScript source
only when the `tsx` binary is present. In a clean checkout with no `dist/` and no
`node_modules/.bin/tsx`, the installer exits with
`compiled CLI not found. Run npm run build first.` and this single test fails.

**Run `npm run build` before a full `npm run test`** (or before final acceptance).
All other unit tests run without a build. This is a documented prerequisite, not a
product defect or known issue.

## Final-validation cleanup

`npm run build` first runs `npm run clean` (`scripts/clean-build.mjs`), removing
`dist/` and `dist-frontend/`. Final acceptance therefore runs from a clean state via:

```
npm run build && npm run test
```

Do not treat any pre-cleanup test result as final acceptance evidence.

## Harness "Fixed install" three-state UI cases

Backend derivation — `tests/unit/backend/harness-service.test.ts`:

| ID | Scenario | Proves |
| --- | --- | --- |
| B1 | fresh repo, all harness files missing | `initialized === false`, `needsApply === true` |
| B2 | after `applyHarness` | `initialized === true`, `needsApply === false` |
| B3 | pre-existing non-VCM `CLAUDE.md` (action `insert`) | `initialized === false` |
| B4 | pre-existing `.claude/settings.json` without VCM hooks (action `update`) | `initialized === false` |
| B5 | drifted managed block (version 0) | `initialized === true`, `needsApply === true` |

Frontend render — `tests/unit/frontend/harness-panel.test.ts`
(entry: `HarnessPanel`, rendered via `renderToStaticMarkup`, `xterm-view` mocked):

| ID | State | Entry / input | Key assertions |
| --- | --- | --- | --- |
| F1 | A — not initialized | `initialized:false, needsApply:true` | subtitle "Not initialized"; only `Initialize` button; no Refresh/Update; no "Files to update" list |
| F2 | B — has updates | `initialized:true, needsApply:true, plannedChanges:[..]` | subtitle "N pending updates"; "Files to update" list with paths; `Update` + `Refresh`; no `Initialize` |
| F3 | C — up to date | `initialized:true, needsApply:false` | subtitle "Up to date"; `Refresh` only; no `Update`/`Initialize`; no list |
| F4 | busy | each state with `busy:true` | every fixed-install action button rendered `disabled` |

Run: `npx vitest run tests/unit/backend/harness-service.test.ts tests/unit/frontend/harness-panel.test.ts`.

## Known testing gaps

- No DOM/interaction (click) tests for the frontend: the node test environment uses
  static-markup rendering, so button `onClick` wiring is verified by code review and
  by the backend status-reload behavior, not by simulated events. A jsdom +
  `@testing-library/react` setup would be needed for true interaction coverage and is
  not currently configured.
- No L3 Playwright smoke was run for this task (UI conditional-rendering change with
  full backend + frontend unit coverage). Reserve E2E for release-level or
  cross-cutting flow changes.
