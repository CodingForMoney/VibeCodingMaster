# Known Issues

Durable open issues and accepted limitations for VibeCodingMaster (VCM). This is
a current open-issue snapshot, not a task log. Each entry is architect-owned and
should be removed or rewritten once the underlying gap is resolved.

Issues are grouped by category. Severity reflects architectural/correctness/
security risk, not delivery priority.

---

## Security & Exposure

### KI-001 — Unauthenticated HTTP API and `/ws` terminal surface

- **Status**: Open (accepted limitation by design; needs explicit user/PM decision before any non-loopback use).
- **Category**: Product / security.
- **Affected modules / surfaces**: `src/backend/server.ts` (no auth hook, no CORS/origin policy), all `src/backend/api/*` routes, `src/backend/ws/terminal-ws.ts`, `src/main.ts` (`--host=` flag).
- **Current gap**: The backend registers every `/api/*` route and the `/ws/terminal/:id` WebSocket with no authentication, authorization, or origin/CSRF check. These surfaces can spawn processes (`runtime.createSession`), run `git`, read/write the filesystem and `vcmDataDir`, manage gateway tokens, and write raw bytes directly into role PTYs (`runtime.write` via the terminal WebSocket). The default bind is `127.0.0.1`, but `--host=` lets a user bind to `0.0.0.0`/LAN, and the WS upgrade path performs no `Origin` validation (cross-site WebSocket hijacking is possible if a browser session is open).
- **Impact**: Binding to any non-loopback interface exposes a powerful, fully unauthenticated remote-code-execution-equivalent surface to the local network. Even on loopback, the lack of `Origin` checks means a malicious web page in the user's browser could drive the API/terminal.
- **Mitigation / workaround**: Keep the default `127.0.0.1` bind; do not pass `--host=` with a routable address; do not run VCM on shared/untrusted machines.
- **Resolution condition**: Either (a) document and enforce loopback-only as a hard product constraint, or (b) add an auth/token + `Origin` allowlist before allowing non-loopback binds. Requires a product decision (route through the full code-change flow if a fix is chosen).
- **Related**: KI-002, KI-007.

### KI-002 — Gateway bot token and app secret stored in plaintext at rest

- **Status**: Open (accepted limitation).
- **Category**: Product / security.
- **Affected modules / surfaces**: `src/backend/gateway/gateway-settings-service.ts` (`writeJsonAtomic(settingsPath, cachedSettings)`), gateway channel credentials (`binding.token`, `binding.appSecret`).
- **Current gap**: Gateway channel credentials (Weixin iLink bot token, Lark app secret) are persisted unencrypted as JSON under `vcmDataDir`. Status responses correctly expose only `tokenConfigured`/`appSecretConfigured` booleans, so the leak is at-rest only, not over the status API.
- **Impact**: Anyone with read access to the user's `vcmDataDir` (backups, sync tools, other local users) can recover live chat-platform bot credentials.
- **Mitigation / workaround**: Protect `vcmDataDir` filesystem permissions; rotate tokens if the data dir is exposed.
- **Resolution condition**: Encrypt secrets at rest or delegate to an OS keychain; or formally accept and document the plaintext-at-rest model.
- **Related**: KI-001.

### KI-019 — Gateway `/use-project` connects any local repository path

- **Status**: Open.
- **Category**: Product / security.
- **Affected modules / surfaces**: `src/backend/gateway/gateway-service.ts` (`useProject`, `listProjectOptions`), gateway `/use-project` command.
- **Current gap**: `/use-project <index-or-path>` passes any non-index argument straight to `projectService.connectProject` instead of restricting selection to the current and recent project list.
- **Impact**: When the gateway is enabled, a chat sender can point VCM at any Git repository on the host and then create tasks, install harness commits, and run role sessions with relaxed permissions there. With Lark, any sender in the app's tenant can drive the gateway (accepted design), which widens who can do this.
- **Mitigation / workaround**: Keep the gateway disabled when not in use; restrict Lark app availability to trusted users.
- **Resolution condition**: Accept only an index into the current and recent project list (or an exact match of one of those paths) from the gateway, and reject arbitrary paths.
- **Related**: KI-001, KI-002.

### KI-020 — Hook session matching skips the runtime token when `vcm_runtime_session_id` is present

- **Status**: Open.
- **Category**: Product / security.
- **Affected modules / surfaces**: `src/backend/services/session-service.ts` (`matchesRoleHookSession`), `src/backend/services/claude-hook-service.ts` (hook identity checks).
- **Current gap**: When a hook payload carries `vcm_runtime_session_id`, matching compares only the session record ID and never checks `runtimeSessionToken`. Installed hooks never send this field, and no test uses it.
- **Impact**: A caller that knows a session record ID (exposed in API responses and session files) can post Stop or UserPromptSubmit hooks as another role, ending turns or triggering route dispatch.
- **Mitigation / workaround**: Keep the default loopback bind (KI-001).
- **Resolution condition**: Remove the `vcm_runtime_session_id` branch, or require the matching runtime token on that branch as well.
- **Related**: KI-001.

---

## Correctness & Robustness

### KI-003 — Spawn failures are indistinguishable from real `git` exit code 1

- **Status**: Open.
- **Category**: Product / correctness.
- **Affected modules / surfaces**: `src/backend/adapters/command-runner.ts` (catch branch returns `{ exitCode: 1, stderr: error.message }`), `src/backend/adapters/git-adapter.ts` (`isIgnored`, `branchExists` treat `exitCode === 1` as a definitive "false").
- **Current gap**: `command-runner.run` collapses every `execa` failure — including a spawn error such as `git` not being installed/launchable (ENOENT) — into `exitCode: 1`. Several git-adapter methods (`isIgnored`, `branchExists`) interpret `exitCode === 1` as a meaningful negative result ("not ignored" / "branch does not exist"). A missing or unspawnable `git` therefore returns a confident wrong answer instead of surfacing the real failure.
- **Impact**: Downstream logic (worktree creation, ignore checks, branch existence gating) can silently make wrong decisions when `git` is absent or the spawn fails, masking the root cause and producing confusing secondary errors.
- **Mitigation / workaround**: Ensure `git` is installed and on `PATH` before use.
- **Resolution condition**: Distinguish spawn/launch errors from non-zero process exits in `command-runner` (e.g., a sentinel exit code or a typed `spawnFailed` flag) and have git-adapter treat spawn failure as an error rather than a `false` result. Requires a cross-file contract change → route through the full code-change flow.
- **Related**: none.

### KI-004 — Claude transcript project-directory hashing does not match Claude Code's encoding

- **Status**: Open.
- **Category**: Product / correctness (external coupling to Claude Code's on-disk format).
- **Affected modules / surfaces**: `src/backend/services/claude-transcript-service.ts` (`projectHash`, `projectsTranscriptDir`, `claudeTranscriptPath`, `resolveExistingClaudeTranscriptPath`), translation panel and question/todo extraction that depend on it.
- **Current gap**: `projectHash` only replaces `[/\s]+` with `-`, which does not reproduce Claude Code's actual project-directory encoding (which also encodes `.` and other path characters). The primary path lookup can therefore miss; correctness currently leans on the fallback full scan `findClaudeTranscriptPathBySessionId`, which picks the most-recently-modified `<sessionId>.jsonl` across all project dirs.
- **Impact**: If Claude changes its encoding, or two project directories produce a colliding hash / share a session-id filename, transcript resolution can attach to the wrong file or fail to find one, breaking translation feed and question/todo surfacing. The fallback masks the brittleness rather than fixing it.
- **Mitigation / workaround**: Rely on the `session.transcriptPath` / `claudeSessionId` resolution path; the mtime-sorted fallback usually recovers the right file.
- **Resolution condition**: Mirror Claude Code's real directory-encoding scheme (or resolve transcript paths via a documented Claude API/contract) instead of an approximate replace. Treat the encoding as an external-contract assumption to re-verify on Claude Code upgrades.
- **Related**: KI-005.

### KI-017 — Harness Python tools require Python 3.10+ without declaring or checking it

- **Status**: Planned.
- **Category**: Harness / dev-environment.
- **Affected modules / surfaces**: `scripts/harness-tools/*` and installed `.ai/tools/{check-durable-docs,check-scaffold-ledger,generate-module-index,generate-public-surface,request-gate-review,run-long-check,watch-job}`; README Requirements.
- **Current gap**: These tools use PEP 604 annotations (`X | None`) without `from __future__ import annotations`, so they raise `TypeError` at import time on Python 3.9 (the macOS system `python3`). The README lists only `python3`, and nothing checks the interpreter version at harness install or role launch. `vcm-bash-guard` and `vcm-subagent-guard` currently happen to run on 3.9.
- **Impact**: On such hosts, Gate Review requests, long-running validation jobs, durable-doc checks, scaffold-ledger checks, and generated-context refresh fail with a Python traceback instead of a clear prerequisite error, blocking the VCM workflow.
- **Mitigation / workaround**: Put Python 3.10+ first on `PATH` as `python3` for VCM and its role sessions.
- **Resolution condition**: Decided direction: rewrite the harness tools in Node and remove the Python runtime dependency from the harness, since VCM and its hooks already require Node. Until then, the README must state the Python 3.10+ requirement.
- **Related**: KI-018.

### KI-018 — Claude Code platform contract is undeclared and partly relies on implementation details

- **Status**: Planned.
- **Category**: Product / external coupling.
- **Affected modules / surfaces**: `src/backend/adapters/claude-adapter.ts` (CLI flags, `--version` availability probe only), `src/backend/services/claude-transcript-service.ts` (transcript directory encoding, JSONL record shape), `src/backend/runtime/terminal-submit.ts` (bracketed paste plus Enter submission), `src/backend/services/session-service.ts` (Claude Code and OTEL environment variables), `src/backend/services/claude-hook-service.ts` (hook event names and payload fields).
- **Current gap**: VCM depends on about ten CLI flags, six hook events, hook payload fields, roughly twenty environment variables, agent frontmatter fields, and undocumented behavior (transcript path encoding and record format, TUI paste submission). These assumptions are spread across services, and VCM enforces no minimum Claude Code version.
- **Impact**: A Claude Code release that changes one of these behaviors can break session tracking, dispatch confirmation, or translation without a clear error. No breakage has been observed so far when tracking the latest Claude Code release.
- **Mitigation / workaround**: Track the latest Claude Code release; KI-004 fallback scan recovers most transcript lookups.
- **Resolution condition**: Decided direction: (1) replace reliance on undocumented behavior with documented inputs where available, such as using the hook payload `transcript_path` instead of recomputing the project-directory encoding; (2) enforce a minimum supported Claude Code version at launch with an explicit error.
- **Related**: KI-004, KI-017.

### KI-021 — A backend restart after terminal submission can redeliver the same PM dispatch

- **Status**: Open.
- **Category**: Product / correctness.
- **Affected modules / surfaces**: `src/backend/services/message-service.ts` (`dispatchRouteFile`, `scanLocked`), `src/backend/services/runtime-recovery-service.ts` (`recoverMessages`), `src/backend/services/workflow-control-service.ts` (`recoverTask`, `wasDispatchDelivered`).
- **Current gap**: The message snapshot with `deliveredAt` is appended only after `dispatchRouteFile` returns, while the route envelope has already been pasted and submitted to the target terminal. Recovery treats a message without `deliveredAt` as undelivered, clears `dispatchingAt`, and returns the workflow approval to `pending`; the PM route file is still non-empty.
- **Impact**: If VCM restarts in that window (at least the Enter delay plus follow-up writes), the next route scan delivers the same task to the target role again, so the role executes it twice.
- **Mitigation / workaround**: Avoid restarting VCM while a PM dispatch is in flight; inspect the target session before allowing redelivery.
- **Resolution condition**: Persist delivery immediately after terminal submission succeeds, or treat a dispatch whose delivery state is ambiguous as possibly delivered and require explicit user confirmation instead of automatic redelivery.
- **Related**: KI-023.

### KI-022 — Gate Review waits indefinitely for a report that the Reviewer never writes

- **Status**: Open.
- **Category**: Product / correctness.
- **Affected modules / surfaces**: `src/backend/services/gate-review-service.ts` (`waitForGateReport`, `runGateReview`, `activeRuns`), `src/backend/services/claude-hook-service.ts` (Reviewer Stop and StopFailure handling), `src/backend/services/task-close-service.ts`.
- **Current gap**: `waitForGateReport` polls the request report path until a report exists or the run is cancelled. A Reviewer Stop, non-retryable StopFailure, or terminal exit without a report does not fail the gate. Task close does not abort active gate runs.
- **Impact**: The gate stays `running`, Project Manager waits for a callback that never arrives, and the workflow stalls until the user cancels the request or restarts VCM. A gate run active at task close keeps polling a removed worktree path for the life of the process.
- **Mitigation / workaround**: Cancel the running gate request in the UI and request it again.
- **Resolution condition**: Fail the current gate request when the Reviewer turn ends or its process exits without a valid report, and abort all active gate runs for a task during task close.
- **Related**: None.

### KI-023 — One malformed line in the task message log breaks dispatch and task recovery

- **Status**: Open.
- **Category**: Product / robustness.
- **Affected modules / surfaces**: `src/backend/services/message-service.ts` (`readLatestMessages`, `appendMessageSnapshot`), `src/backend/services/runtime-recovery-service.ts` (`recoverMessages`, per-task recovery step).
- **Current gap**: Every line of `<stateRoot>/messages/<task>.jsonl` is parsed with `JSON.parse` without error handling. Recovery parses the log the same way and rewrites it with a non-atomic `writeText`. Message recovery runs inside the same per-task recovery step as workflow, Gate Review, and restart recovery.
- **Impact**: A partial line left by a crash or full disk makes every route scan, prompt confirmation, and message listing for the task throw. On the next startup, that task's recovery step fails at message recovery, so workflow, Gate Review, Architect restart, and Restart With Context recovery are skipped for the task. A crash during the recovery rewrite can itself truncate the log.
- **Mitigation / workaround**: Manually remove the malformed trailing line from the message log.
- **Resolution condition**: Tolerate and report an unparsable trailing line instead of failing, write recovery output atomically, and isolate message recovery from the other per-task recovery steps.
- **Related**: KI-021.

### KI-024 — Workflow state reads write files without the workflow lock

- **Status**: Open.
- **Category**: Product / correctness.
- **Affected modules / surfaces**: `src/backend/services/workflow-control-service.ts` (`getState`, `recoverCommitJournal`, `reconstructStateFromProgress`), unlocked callers such as `src/backend/api/runtime-state-routes.ts` and `src/backend/services/claude-hook-service.ts`.
- **Current gap**: `getState` may write the Workflow Progress template, save a reconstructed runtime state, or replay and delete the paired-write commit journal. It runs both inside and outside the workflow lock, including from frequently polled runtime-state requests.
- **Impact**: An unlocked read can replay a journal concurrently with a locked commit. Current interleavings appear idempotent, but correctness relies on timing rather than on the lock; a stale replay overwriting a newer committed state has not been reproduced but is not excluded by design.
- **Mitigation / workaround**: None.
- **Resolution condition**: Make unlocked reads side-effect free and perform journal replay, template creation, and state reconstruction only under the workflow lock.
- **Related**: None.

---

## Performance & Scalability

### KI-005 — Synchronous filesystem I/O and full-file replay on the event loop in `TranscriptTail`

- **Status**: Open.
- **Category**: Product / performance.
- **Affected modules / surfaces**: `src/backend/services/claude-transcript-service.ts` (`TranscriptTail.start/flush/replayHistory/replaySince`), translation worker/feed consumers.
- **Current gap**: Transcript tailing uses synchronous `statSync`/`openSync`/`readSync` on every flush and `readFileSync` for replay, all on the main event-loop thread, with a 1s poll timer per subscribed session. Replay (`replayHistory`/`replaySince`) reads the entire JSONL transcript into memory and parses every line synchronously.
- **Impact**: Long-lived sessions accumulate large transcripts; with multiple concurrent role sessions each tailing + replaying, synchronous reads can stall the event loop and spike memory, degrading API/WS responsiveness.
- **Mitigation / workaround**: Practical session/transcript sizes are usually small; impact is bounded by transcript length and session count.
- **Resolution condition**: Move to async/streamed reads, bound replay (cap bytes/lines read), and/or offload tailing; treat as a scalability hardening item.
- **Related**: KI-004, KI-006.

### KI-006 — O(n)-per-chunk terminal replay buffer recomputation

- **Status**: Open.
- **Category**: Product / performance.
- **Affected modules / surfaces**: `src/backend/runtime/node-pty-runtime.ts` (`appendTerminalReplay`, `tailTerminalReplay`, invoked on every `child.onData`).
- **Current gap**: On every PTY output chunk, `appendTerminalReplay` concatenates the existing buffer with the new data and re-tails to the 2 MB cap, and `tailTerminalReplay` recomputes `Buffer.byteLength` inside a trimming loop. This is O(buffer size) per chunk regardless of chunk size.
- **Impact**: Chatty/high-throughput Claude sessions trigger repeated multi-MB string copies and byte-length scans, a measurable CPU hotspot under sustained output.
- **Mitigation / workaround**: Output bursts are typically short; the 2 MB cap bounds memory.
- **Resolution condition**: Use a chunked/ring buffer or amortized trimming so per-chunk cost is proportional to the new data, not the whole buffer.
- **Related**: KI-005.

---

## Cost & Model Allocation

### KI-016 — Architect worker model and effort are fixed and not configurable

- **Status**: Open.
- **Category**: Product / cost.
- **Affected modules / surfaces**: `src/backend/services/harness-service.ts` (Architect worker frontmatter `model: "opus"`, `effort: "xhigh"`), `src/backend/cli/install-vcm-harness.ts` (duplicate worker frontmatter definitions), installed `.claude/agents/vcm-architect-{evidence,scaffold,validation}-worker.md`, `src/backend/services/session-service.ts` launch options.
- **Current gap**: Role model and effort are selected per Session at launch, but the three Architect workers are hardcoded to `opus` with `xhigh` effort in harness templates. Workers were intended to be cheaper than an Architect running Fable; that relation is relative, while the configuration is absolute. The same values are also defined in two installer code paths.
- **Impact**: When Architect runs Opus or a cheaper model, workers cost the same as or more than their parent. Mechanical workers (validation command execution, exact scaffold execution) pay for the highest effort level without needing judgment. Users cannot tune worker cost without editing installed harness files, which later harness refreshes overwrite.
- **Mitigation / workaround**: Run Architect on Fable so the fixed Opus workers stay cheaper than the parent.
- **Resolution condition**: Make worker model and effort configurable (per worker type, or derived from the parent Architect Session's launch model at launch time), keep a single source of truth for the defaults, and document the model-tier policy in `docs/ARCHITECTURE.md`.
- **Related**: KI-025.

### KI-025 — Gate Review starts and resumes Reviewer with the default model

- **Status**: Open.
- **Category**: Product / cost.
- **Affected modules / surfaces**: `src/backend/services/gate-review-service.ts` (`ensureReviewerSession`), `src/backend/services/session-service.ts` (launch model resolution `input.model ?? persisted.model`).
- **Current gap**: When the Reviewer Session is not running, Gate Review starts or resumes it with an explicit `model: "default"`, which overrides the model saved for that Session.
- **Impact**: Reviewer silently loses the user's model tier choice. When the saved model is a Codex Bridge model, the resume fails because Resume cannot cross providers, and Gate Review falls back to a fresh Session without the previous Reviewer context.
- **Mitigation / workaround**: Start or resume Reviewer manually with the intended model before requesting a gate.
- **Resolution condition**: Omit the model on automatic Reviewer start and resume so the saved Session or tool default applies.
- **Related**: KI-016.

---

## Maintainability

### KI-007 — Non-matching `/ws` upgrade requests leak the socket

- **Status**: Open.
- **Category**: Product / robustness.
- **Affected modules / surfaces**: `src/backend/ws/terminal-ws.ts` (`app.server.on("upgrade", ...)`).
- **Current gap**: When an upgrade request's path does not match `/ws/terminal/:id`, the handler `return`s without calling `socket.destroy()` (or writing a `400`/`426` response). The half-upgraded socket is left hanging until a timeout. There is also no `Origin` check at the upgrade boundary (see KI-001).
- **Impact**: Low — stray/unrelated `/ws` upgrade attempts hold a connection open instead of being cleanly rejected; minor resource pressure, no correct rejection signal to the client.
- **Mitigation / workaround**: Only the intended `/ws/terminal/:id` path is used by the shipped frontend.
- **Resolution condition**: Destroy (or explicitly reject) the socket on non-matching upgrade paths and add an `Origin` allowlist.
- **Related**: KI-001.

### KI-008 — Oversized service modules concentrate orchestration complexity

- **Status**: Open (maintainability hazard, not a defect).
- **Category**: Product / maintainability.
- **Affected modules / surfaces**: `src/backend/services/harness-service.ts` (~2395 lines), `translation-worker-service.ts` (~2245), `translation-service.ts` (~2118), `session-service.ts` (~1933), `gate-review-service.ts` (~1738), `auto-memory-service.ts` (~1076), and `claude-hook-service.ts` (~1002).
- **Current gap**: Several service files greatly exceed comfortable single-file cohesion and bundle orchestration, retry/error handling, and side-effect coordination together. This makes the intended `api -> services -> (runtime | adapters | gateway | templates)` boundary harder to reason about and raises regression risk on edits.
- **Impact**: Higher change cost and review/regression risk in the highest-traffic backend logic; harder to localize behavior and test seams.
- **Mitigation / workaround**: Existing unit tests cover many of these services; keep edits narrowly scoped.
- **Resolution condition**: Incrementally extract cohesive sub-modules (with explicit cross-file contracts captured in module `ARCHITECTURE.md`) when these areas are next changed. No standalone refactor mandated.
- **Related**: none.

### KI-009 — Error responses surface raw subprocess stderr and runtime diagnostics to clients

- **Status**: Open (low risk on loopback; compounds with KI-001).
- **Category**: Product / information exposure.
- **Affected modules / surfaces**: `src/backend/server.ts` global error handler (returns `hint` and `runtime` diagnostics), `src/backend/adapters/git-adapter.ts` (sets `hint: result.stderr`).
- **Current gap**: API error payloads include `hint` (often raw `git` stderr) and `diagnosticsService.getErrorRuntimeInfo()`. On loopback this is acceptable developer feedback, but it leaks local paths/environment detail to any caller — which matters if combined with a non-loopback bind (KI-001).
- **Impact**: Low in the default configuration; an information-exposure amplifier when the API is exposed beyond loopback.
- **Mitigation / workaround**: Keep the loopback bind (KI-001).
- **Resolution condition**: Gate verbose `hint`/`runtime` detail behind a dev flag, or sanitize before returning, if non-loopback exposure is ever supported.
- **Related**: KI-001, KI-007.

### KI-013 — legacy project-level tool session cwd persistence is redundant

- **Status**: Open (legacy path retained; not used by the default task-scoped tool sessions).
- **Category**: Product / maintainability (cleanup).
- **Affected modules / surfaces**: `src/shared/types/session.ts` (`RoleSessionRecord.cwd`, `RoleSessionRecord.previousCwd`) and legacy project-level tool session helpers in `src/backend/services/session-service.ts`.
- **Current gap**: VCM defaults Translator and Harness Engineer to task-scoped sessions. The older project-level helper path is retained for possible future use, and still carries cwd/previousCwd tracking for `/cd` migration.
- **Impact**: None functional in the default task-scoped path.
- **Mitigation / workaround**: None needed.
- **Resolution condition**: If pursued, drop `cwd`/`previousCwd` from `RoleSessionRecord` and migrate the remaining consumers to derive cwd (repoRoot anchor plus active task root). This is a `src/shared` public-contract change and must go through the full `architect plan -> coder -> tester` flow (out of Debug Mode scope).
- **Related**: KI-004.

### KI-015 — Legacy project-level `/cd` correctness depends on unverified Claude Code behaviors

- **Status**: Open (legacy path retained; not used by default task-scoped tool sessions).
- **Category**: Product / maintainability.
- **Affected modules / surfaces**: Legacy project-level helpers in `src/backend/services/session-service.ts` (`formatClaudeCdCommand`, `migrateRunningProjectToolSessionCwd`, and project-level launch/resume cwd tracking).
- **Current gap**: If the retained project-level helpers are re-enabled, their `/cd` migration relies on two Claude Code behaviors that VCM's unit tests cannot verify:
  1. **`/cd` argument parsing**: VCM now emits a **bare, unquoted** path (`/cd <path>`), assuming Claude Code's `/cd` consumes the literal rest-of-line (so spaces are fine and surrounding quotes would be taken literally). Previously VCM emitted `/cd "<path>"` (JSON-quoted); if the literal-rest-of-line assumption is correct, that quoted form was **silently failing** — the quotes became part of the path, the `cd` errored, and project-level sessions **may never have actually switched into the task worktree** (they kept operating in their launch cwd). The de-quote fix is low-risk: if the premise is wrong, the switch simply fails as before — no new breakage.
  2. **`claude --resume` cwd restoration**: VCM now skips `/cd` when the session's tracked (persisted/restored) cwd already equals the target, assuming `claude --resume` restores the session's prior working directory (user-confirmed). If this premise is wrong, a needed `/cd` is skipped and the resumed session stays at the `repoRoot` spawn cwd → the #16 wrong-directory symptom returns for the resume-same-task path. Higher risk than (1).
- **Impact**: None in the default task-scoped path. A future project-scoped mode could operate in the wrong directory if either premise is false.
- **Mitigation / workaround**: Keep tool sessions task-scoped unless the legacy path is restored and verified against a live Claude Code session.
- **Resolution condition**: Remove the legacy project-level helpers, or verify their fresh launch, resume, and task-switch behavior before exposing project-scoped tool sessions again.
- **Related**: KI-004 (Claude transcript directory-encoding external coupling).

---

## Test Infrastructure

### KI-026 — Backend E2E timeouts are too tight for a clean `npm test` run

- **Status**: Open.
- **Category**: Test-infra.
- **Affected modules / surfaces**: `tests/e2e/backend/harness-retrospective.e2e.test.ts` ("keeps the retrospective open until moved memory is committed to durable documentation"), `vitest.config.ts` default test timeout, other backend E2E files under parallel load.
- **Current gap**: The listed test needs about 5.5 seconds even when run alone and exceeds the 5-second default timeout on every run. Under the default parallel run, about nine more backend E2E tests time out; they pass when run serially.
- **Impact**: `npm test` fails on an unmodified checkout, which hides real regressions and weakens the release gate signal.
- **Mitigation / workaround**: Rerun failing backend E2E files with `--no-file-parallelism` or a larger `--testTimeout`.
- **Resolution condition**: Give long backend E2E tests explicit timeouts sized for their workload, or reduce their fixed delays, so a clean `npm test` passes under the default parallel run.
- **Related**: KI-017.
