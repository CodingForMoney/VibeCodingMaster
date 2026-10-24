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

### KI-017 — Harness Python tools require Python 3.10+ without declaring or checking it

- **Status**: Planned.
- **Category**: Harness / dev-environment.
- **Affected modules / surfaces**: `scripts/harness-tools/*` and installed `.ai/tools/{check-durable-docs,check-scaffold-ledger,generate-module-index,generate-public-surface,request-gate-review,run-long-check,watch-job}`; README Requirements.
- **Current gap**: These tools use PEP 604 annotations (`X | None`) without `from __future__ import annotations`, so they raise `TypeError` at import time on Python 3.9 (the macOS system `python3`). The README lists only `python3`, and nothing checks the interpreter version at harness install or role launch. `vcm-bash-guard` and `vcm-subagent-guard` currently happen to run on 3.9.
- **Impact**: On such hosts, Gate Review requests, long-running validation jobs, durable-doc checks, scaffold-ledger checks, and generated-context refresh fail with a Python traceback instead of a clear prerequisite error, blocking the VCM workflow.
- **Mitigation / workaround**: Put Python 3.10+ first on `PATH` as `python3` for VCM and its role sessions.
- **Resolution condition**: Decided direction: rewrite the harness tools in Node and remove the Python runtime dependency from the harness, since VCM and its hooks already require Node. Until then, the README must state the Python 3.10+ requirement.
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
- **Related**: KI-006.

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
- **Related**: None.

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
- **Related**: KI-013.

---

## Test Infrastructure

### KI-027 — Backend E2E helper duplicates the server composition root

- **Status**: Open.
- **Category**: Test-infra.
- **Affected modules / surfaces**: `tests/e2e/backend/helpers/e2e-app.ts` (builds every backend service itself), `src/backend/server.ts` (production service wiring).
- **Current gap**: The backend E2E helper constructs and wires every service by hand instead of reusing the production composition in `src/backend/server.ts`. A dependency added to one wiring is not present in the other.
- **Impact**: Backend E2E journeys do not prove production wiring. A service dependency wired only in `server.ts` is absent from E2E runs, and one wired only in the helper passes E2E while missing in production.
- **Mitigation / workaround**: Update both wiring sites together when adding or changing a service dependency.
- **Resolution condition**: Expose the production composition from `server.ts` with injectable runtime, adapters, and timers, and build the E2E app from it so both share one wiring.
- **Related**: None.
