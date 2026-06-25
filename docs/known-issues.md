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

### KI-010 — Translation queue stuck-head recovery is enqueue-triggered, not continuous

- **Status**: Open (accepted limitation; the primary issue #13 case is resolved).
- **Category**: Product / robustness (operability).
- **Affected modules / surfaces**: `src/backend/services/translation-worker-service.ts` (`dispatchNext` / `reconcileStuckActiveItem` / `STALE_CONVERSATION_ITEM_MS`), `src/backend/services/translation-service.ts` (`waitForConversationResult` poll loop).
- **Current gap**: Recovery of a stuck active queue item (whose Translator `Stop`/`StopFailure` hook was lost) runs only when `dispatchNext` is invoked — i.e. when a new item is enqueued or a hook arrives. The request poll loop (`waitForConversationResult` -> `getState`) does not call `dispatchNext`. The primary case (the result already written to disk, hook lost) self-heals immediately on the next enqueue: conversation output lives in a single shared, self-describing `runtime/conversations/result.json`, and the recovery association key is the in-file `batchId` validated all-or-nothing (`conversationResultAvailable` requires the file to exist, parse, have `batchId` equal to the active item's `batchId`, and contain every expected `batchIndex`). The secondary case (Translator session gone with no result written) is only released after the item passes the 90s `STALE_CONVERSATION_ITEM_MS` window *and* a subsequent enqueue occurs; if the stuck head is still younger than 90s when the next translation is requested, that request can still time out once.
- **Impact**: Low. A narrow window can still produce a single `translation timed out` (HTTP 502) for the "session gone, no result, head <90s old, no further enqueue" case; it self-heals on the next translation attempt after the stale window. No permanent queue block remains, and a backend restart with a pre-existing stuck item recovers immediately (its `updatedAt` is already stale, or the result is on disk).
- **Mitigation / workaround**: Retry the translation once; the retry's enqueue triggers reconciliation.
- **Resolution condition**: Add a periodic / poll-driven reconcile (e.g. reconcile on `getState` or a timer) so stuck heads are released without depending on a new enqueue. Requires a code change → route through the full code-change flow if pursued.
- **Related**: KI-011.

### KI-011 — Conversation result cleanup deletes the shared dir without a batchId guard

- **Status**: Open (accepted limitation; harm effectively unreachable today).
- **Category**: Product / robustness (operability).
- **Affected modules / surfaces**: `src/backend/services/translation-worker-service.ts` (`validateConversationResult` cleanup of the shared `runtime/conversations/` directory holding `result.json`).
- **Current gap**: Because conversation translation now uses one shared `result.json` (KI-010), cleanup after a consumed result removes the shared `conversations/` directory (the `batchResultPath` dirname) rather than a per-batch directory, and it is not guarded by a `batchId` match against the file actually on disk. In principle a delete could race a newly written `result.json` for a later batch.
- **Impact**: Negligible in practice. Cleanup fires on the ~500ms consumer poll, far ahead of when a subsequent batch's Translator (LLM latency ≫ 500ms) could write a new `result.json`; and the all-or-nothing in-file `batchId` validation means the worst case is a recoverable dropped result, never a mis-assignment — within the design's accepted "drop over mis-assign" tolerance.
- **Mitigation / workaround**: None needed; a dropped conversation result self-recovers via re-translate / stale-release.
- **Resolution condition**: Optional hardening — scope the cleanup to delete only when the on-disk `result.json` `batchId` matches the just-consumed batch (or delete the file, not the directory). Requires a small code change → full code-change flow if pursued.
- **Related**: KI-010.

### KI-004 — Claude transcript project-directory hashing does not match Claude Code's encoding

- **Status**: Open.
- **Category**: Product / correctness (external coupling to Claude Code's on-disk format).
- **Affected modules / surfaces**: `src/backend/services/claude-transcript-service.ts` (`projectHash`, `projectsTranscriptDir`, `claudeTranscriptPath`, `resolveExistingClaudeTranscriptPath`), translation panel and question/todo extraction that depend on it.
- **Current gap**: `projectHash` only replaces `[/\s]+` with `-`, which does not reproduce Claude Code's actual project-directory encoding (which also encodes `.` and other path characters). The primary path lookup can therefore miss; correctness currently leans on the fallback full scan `findClaudeTranscriptPathBySessionId`, which picks the most-recently-modified `<sessionId>.jsonl` across all project dirs.
- **Impact**: If Claude changes its encoding, or two project directories produce a colliding hash / share a session-id filename, transcript resolution can attach to the wrong file or fail to find one, breaking translation feed and question/todo surfacing. The fallback masks the brittleness rather than fixing it.
- **Mitigation / workaround**: Rely on the `session.transcriptPath` / `claudeSessionId` resolution path; the mtime-sorted fallback usually recovers the right file.
- **Resolution condition**: Mirror Claude Code's real directory-encoding scheme (or resolve transcript paths via a documented Claude API/contract) instead of an approximate replace. Treat the encoding as an external-contract assumption to re-verify on Claude Code upgrades.
- **Related**: KI-005.

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
- **Affected modules / surfaces**: `src/backend/services/harness-service.ts` (~2160 lines), `translation-worker-service.ts` (~2155), `translation-service.ts` (~1721), `session-service.ts` (~1682), `gate-review-service.ts` (~980), `claude-hook-service.ts` (~769).
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

### KI-013 — `RoleSessionRecord.cwd` / `previousCwd` persistence is redundant for project-level tool sessions

- **Status**: Open (accepted limitation / deferred cleanup; not a defect).
- **Category**: Product / maintainability (cleanup).
- **Affected modules / surfaces**: `src/shared/types/session.ts` (`RoleSessionRecord.cwd`, `RoleSessionRecord.previousCwd`), `src/backend/services/session-service.ts` (project-level tool session launch/resume/`/cd` migrate), and `cwd` consumers `src/backend/services/claude-transcript-service.ts` (`resolveExistingClaudeTranscriptPath`), `translation-service.ts`, `harness-service.ts`.
- **Current gap**: Project-level tool sessions (translator, harness-engineer) now anchor launch/resume cwd and `transcriptPath` at the base `repoRoot` and enter the active task worktree via `/cd`. Both the launch anchor (`repoRoot`) and the `/cd` target (the active task worktree) are derivable, so persisting `cwd`/`previousCwd` for these sessions is no longer load-bearing — `cwd` now only tracks the logical `/cd` target for the redundant-`/cd` skip check. The fields were intentionally retained to keep the underlying fix inside Debug Mode scope, because removing a `src/shared` public type field is a public-surface change.
- **Impact**: None functional. A shared public type carries fields that are derivable for project-level sessions, which can mislead future maintainers about which cwd value is authoritative.
- **Mitigation / workaround**: None needed.
- **Resolution condition**: If pursued, drop `cwd`/`previousCwd` from `RoleSessionRecord` and migrate the remaining consumers to derive cwd (repoRoot anchor plus active task root). This is a `src/shared` public-contract change and must go through the full `architect plan -> coder -> reviewer` flow (out of Debug Mode scope).
- **Related**: KI-004.

### KI-014 — Inert await-user message-capture pipeline on the web surface

- **Status**: Open (accepted limitation / deferred cleanup; not a defect).
- **Category**: Product / maintainability (cleanup).
- **Affected modules / surfaces**: `src/shared/types/round.ts` (`VcmFlowPauseState.message`/`messageTruncated`), `src/backend/services/round-service.ts` (`awaitingUser.message`/`messageTruncated`, `pendingUserReply` stash, `RecordRoundHookEventInput.userFacingReply`), `src/backend/services/claude-hook-service.ts` (best-effort `readLatestRoleTurnReply` capture on a user-facing Stop).
- **Current gap**: issue #17 shipped a persistent web banner that displayed the PM's captured user-facing reply via `flowPause.message`. The banner was removed at the user's request; await-user now reuses the transient flow-pause modal + alarm, whose wording does NOT include `flowPause.message`. The backend still captures, stashes, promotes, and emits that reply text, but no web consumer reads it. (The `claude-transcript-reply` helper itself is NOT dead — the gateway push path still uses it independently.) The sticky `reason`/`role`/`since` and the task-binding guard remain load-bearing; only the message-capture/`message` plumbing is inert on the web.
- **Impact**: None functional. A best-effort transcript read runs on each user-facing Stop and a `src/shared` field (`flowPause.message`) plus round-state fields are produced that no consumer reads — can mislead future maintainers.
- **Mitigation / workaround**: None needed.
- **Resolution condition**: Either re-surface `flowPause.message` (e.g. in the modal or a detail view) or remove the inert plumbing (`userFacingReply`, `pendingUserReply`, `awaitingUser.message`, `flowPause.message`, and the claude-hook-service capture call). Removal touches the `src/shared` public contract → full `architect plan -> coder -> reviewer` flow.
- **Related**: KI-013.
