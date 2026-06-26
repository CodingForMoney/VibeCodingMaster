# Sub-Area Architecture: `src/backend/gateway`

Detailed design for the VCM **mobile gateway** — the backend sub-area that lets a
user drive a VCM task from a phone chat app (Weixin iLink or Lark/Feishu) and
that pushes project-manager (PM) replies back to that chat. It is part of the
single workspace module `vibe-coding-master`; for the module-wide overview see
[`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md) and
[`../../../docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md).

## Boundary

Files in this sub-area:

| File | Responsibility |
| --- | --- |
| `gateway-service.ts` | Orchestrator. Poll lifecycle, inbound command handling, outbound PM push, onboarding (QR/registration), translation integration, status. |
| `gateway-channel.ts` | `GatewayChannelAdapter` contract + `GatewayChannelRegistry` (multi-channel abstraction; first registered channel is the default). |
| `channels/weixin-ilink-channel.ts` | Weixin iLink adapter over HTTP long-poll (`getupdates`/`sendmessage`) + bot QR login. |
| `channels/lark-channel.ts` | Lark/Feishu adapter over the `@larksuiteoapi/node-sdk` WebSocket event stream + `im.message` send. |
| `channels/lark-registration.ts` | Lark "register app via QR" device-code client used during onboarding to mint app credentials. |
| `gateway-command-parser.ts` | Pure parser: chat text → `GatewayCommand` discriminated union. |
| `gateway-settings-service.ts` | Durable settings file (`vcmDataDir/gateway/settings.json`): load/normalize/save, `expose()` to the safe `GatewayStatus`, binding reset. |
| `gateway-audit-log.ts` | Append-only, secret-redacted JSONL audit (`vcmDataDir/gateway/audit.jsonl`). |
| `../api/gateway-routes.ts` | Thin Fastify routes under `/api/gateway/*` that delegate to `GatewayService`. |

External boundaries: outbound HTTPS/WebSocket to the chat platforms; the
`/api/gateway/*` HTTP surface consumed by the desktop GUI; and durable state
under `vcmDataDir/gateway/`.

## Responsibilities (owned) and Non-Responsibilities

Owned:

- Connect/onboard a chat account (QR login for Weixin; QR app-registration or
  manual App ID/Secret bind for Lark) and persist the binding.
- Run a single resilient poll loop per process that pulls inbound messages,
  de-duplicates them, authorizes the sender, parses a command, executes it, and
  replies.
- Push PM turn-final replies to the bound chat when a PM session's `Stop` hook
  fires.
- Mediate translation of inbound user text (to English for the PM session) and
  outbound PM text (to the user's language), with a `/retry` path on failure.

Not owned (delegated through injected services):

- Project/task/session/round lifecycle (`projectService`, `taskService`,
  `sessionService`, `taskLaunchService`, `roundService`).
- Translation itself (`translationService`), transcript parsing
  (`claude-transcript-service`), and terminal input (`runtime`/`submitTerminalInput`).
- The decision to call `handlePmStop` (owned by `claude-hook-service`).

## Channel Abstraction

`GatewayChannelAdapter` is the seam that hides per-platform protocol differences
behind one shape: `getUpdates`, `sendText`, optional `startQrLogin`/`checkQrLogin`,
and optional `isSessionExpiredError`. Two concrete adapters with very different
transports both satisfy it:

- **Weixin iLink** — stateless HTTP. `getUpdates` is a long-poll that returns a
  `get_updates_buf` cursor advanced each round; auth is a bearer bot token.
- **Lark** — stateful. A persistent WSClient (auto-reconnect) receives
  `im.message.receive_v1` events into an in-memory queue; `getUpdates` drains the
  queue (or waits up to the long-poll timeout); the returned "cursor" is just a
  timestamp (Lark has no server cursor). Auth is App ID/Secret; only DMs or
  @-mention group messages are accepted, and mention tokens are stripped.

The registry resolves `settings.channel` to an adapter and falls back to the
default channel if unknown.

## Runtime Flows

### Lifecycle / polling

- `start()`/`stop()` (called from the server `onReady`/`onClose` hooks) wrap
  `ensurePolling()`/`stopPolling()`.
- `ensurePolling()` is idempotent and race-guarded (`pollStartingPromise`,
  `pollAbort`, `pollLoopPromise`): it starts a single `pollLoop` only when an
  account is configured (`toAccount` returns a credentialed account).
- `getStatus()` and `runtime-coordinator-service.reconcileProject()` both call
  `getStatus()`, which **auto-starts polling** as a side effect when an account
  exists — so polling self-heals without an explicit start.
- `pollLoop` is `AbortSignal`-driven: on success it advances the cursor and
  records `lastPollStatus: running`; on error it backs off
  (`POLL_ERROR_BACKOFF_MS`, escalating to `POLL_LONG_BACKOFF_MS` after
  `MAX_FAILURES_BEFORE_LONG_BACKOFF`); on a session-expired error it disables the
  gateway, clears the token + cursor, records `expired`, and returns.

### Onboarding / binding

- **Weixin**: `startQrLogin` → channel `get_bot_qrcode`; `checkQrLogin` polls
  `get_qrcode_status`, follows a `scaned_but_redirect` host change, and on
  `confirmed`/`binded_redirect` persists `{accountId, baseUrl, loginUserId,
  boundUserId, token}` then `ensurePolling()`.
- **Lark**: `startLarkRegistration`/`checkLarkRegistration` use the device-code
  registration client to mint App ID/Secret; or `bindLarkApp` validates a
  user-supplied App ID/Secret with a 1ms `getUpdates` probe. Either path persists
  Lark binding fields and `ensurePolling()`.
- `resetBinding()` stops polling, clears in-memory onboarding/translation state,
  and resets the durable binding (preserving Lark app identity fields and
  `latestPmReplies`).

### Inbound message handling (`handleInbound`)

1. **Dedupe**: skip + audit `ignored` if `messageId` is in the bounded recent-id
   ring (`MAX_DEDUPE_IDS`).
2. **Bind/identity**: persist sender metadata via `saveInboundMetadata`. Weixin
   binds the sender only if no `boundUserId` exists yet (`if-missing`); Lark binds
   the sender on every message (`always`) and also records `contextToken`/`chatId`
   per user.
3. **Authorize**: for non-Lark channels, reject (and audit) a sender that is not
   the bound user. (Lark intentionally skips this single-user lock — see
   Security.)
4. **Parse + execute**: `parseGatewayCommand` → `executeCommand`. When the
   gateway is connected but **off**, only `COMMANDS_ALLOWED_WHEN_DISABLED`
   (`/help /start /status /projects /tasks`) run; everything else returns an
   "off" hint.
5. **Reply + audit**: send the command output back to the sender and record
   message status + an audit event (`ok`/`error`). Command execution is wrapped
   so a thrown `VcmError` becomes an `Error: <message>` reply rather than killing
   the loop.

Command set (when enabled): `/help /start /retry /status /projects
/use-project /pull-current /tasks /use-task /create-task /close-task
[/close-task confirm <slug>] /translate on|off`, plus any non-slash text as a
**plain message to PM**.

- `/create-task` reuses `taskLaunchService.startTaskRoleSessions` (shared with the
  GUI one-click start) and maps a partial start to `GATEWAY_TASK_PARTIAL_START`.
- `/close-task` is a two-step confirm with a TTL (`CLOSE_CONFIRM_TTL_MS`);
  `confirm` stops role sessions, parks the project-tool sessions on a safe cwd,
  stops translation + round tracking, then force-cleans the task worktree/branch.
- Plain text → `sendPlainTextToPm`: requires a running, idle PM session;
  optionally translates the user text to English first; then writes it into the
  PM terminal.

### Outbound PM push (`handlePmStop`)

Triggered by `claude-hook-service` on a PM `Stop` (turn-end) hook
(`notifyGateway: true`, project-manager only):

1. Resolve the PM transcript and parse assistant **text** events.
2. `saveLatestPmReply` — store the latest turn's final text (bounded to
   `MAX_LATEST_PM_REPLY_CHARS`) keyed by `(repoRoot, taskSlug)`, so `/start` can
   replay it even when the gateway was off.
3. If enabled + account + bound user: select transcript text events **after the
   per-`(task, claudeSessionId)` cursor** that are turn-final (`stop_reason ===
   end_turn`), render them (translate unless disabled — failure yields a
   user-facing failure notice + a buffered `/retry`), send to the bound chat, and
   advance the cursor + audit.

## State and Persistence

Durable (`GatewaySettingsFile`, normalized on every load/save, atomic writes):
`enabled`, `channel`, `translationEnabled`, `currentProjectId/Slug`, `binding`
(account/token/app creds/Lark identity/`getUpdatesBuf` cursor/per-user
`contextTokens`+`chatIds`), `dedupe.recentInboundMessageIds`,
`pendingConfirmations.closeTask`, `pushCursors`, `latestPmReplies`,
`lastPollStatus`, `lastMessageStatus`. `expose()` projects this to the
GUI-facing `GatewayStatus` with **only** `tokenConfigured`/`appSecretConfigured`
booleans (never the secrets).

In-memory only (lost on restart): the active `pollAbort`, `qrLogin`,
`larkRegistrationState`, and `lastFailedTranslation` (`/retry` buffer), plus the
Lark WS connection.

## Dependencies and Direction

The gateway is wired entirely by the composition root (`server.ts`): channels →
registry → settings → audit → `createGatewayService(deps)`. It depends on the
big services **only through injected interfaces** (`Pick<…>` of `SessionService`,
`TaskLaunchService`, `TranslationService`, `RoundService`, `AppSettingsService`,
plus `ProjectService`/`TaskService`), and on a few **stateless helper values**
(`getTaskRuntimeRepoRoot`, `parseAssistantContent`/`resolveExistingClaudeTranscriptPath`,
`submitTerminalInput`, `VcmError`). The reverse references —
`claude-hook-service`, `diagnostics-service`, `runtime-coordinator-service`
holding a `GatewayService` — are **type-only** + DI. There is therefore **no
runtime import cycle**: `task-service` and `claude-transcript-service` (the
service files the gateway imports values from) do not import the gateway. This
matches the module rule `api -> services -> (runtime | adapters | gateway |
templates)`, with the gateway sitting beside runtime/adapters and consuming
service behavior via DI.

## Public Surface

Externally meaningful surface = the `/api/gateway/*` routes (the desktop GUI
contract): `GET /status`, `PUT /settings`, `POST /qr/start`, `POST /qr/check`,
`POST /lark-registration/start|check|bind`, `POST /binding/reset`. The chat
platforms are an outbound integration surface. The gateway's TypeScript exports
are backend-internal — they are intentionally **not** part of
`.ai/generated/public-surface.json` (`project-public` visibility), which is the
authoritative listing.

## Security Model

- **Transport/exposure**: the `/api/gateway/*` routes are unauthenticated like
  the rest of the backend (loopback-only assumption) — see `docs/known-issues.md`
  KI-001.
- **Secrets at rest**: bot token / Lark App Secret are stored unencrypted in
  `settings.json`; status responses expose only `*Configured` booleans — see
  KI-002.
- **Sender authorization asymmetry**: Weixin locks to the first sender
  (`boundUserId`) and rejects others; Lark binds **every** sender and skips the
  single-user lock, so any Lark user who DMs/@-mentions the bot can drive the
  gateway when it is on. This is a **confirmed, intentional design decision**
  (accepted limitation, not a defect): Lark app-level access control is the
  authorization boundary.

## Correctness Review

Verified internally consistent:

- Inbound pipeline (poll → dedupe → bind → authorize → parse → execute → reply →
  audit) is coherent, abort-aware, bounded, and resilient (per-update and
  per-command errors are caught and do not stop the loop).
- Outbound PM push is correctly gated (enabled + account + bound user), pushes
  only turn-final text, advances a durable per-session cursor, and degrades
  gracefully on translation failure.
- Onboarding flows persist the binding before enabling polling; expiry disables
  cleanly and clears the cursor/token.
- Channel registry + the two adapters conform to one contract despite opposite
  transports (HTTP long-poll vs WS push), and `toAccount` correctly withholds an
  account until the required credentials exist.
- Dependency wiring is cycle-free at runtime (see above).

Accepted trade-offs (correct under their design intent, documented for clarity):

- **At-most-once-ish inbound**: the Weixin cursor is saved *before* the batch's
  updates are processed (each best-effort with `catch`), so a crash mid-batch can
  skip unprocessed updates; dedupe + the long-poll re-fetch bound the risk.
- **Non-durable in-memory state**: `/retry` buffer, QR/registration state, and the
  Lark WS connection do not survive a restart.
- **Cursor keyed by `claudeSessionId`**: a PM resume (new session id) can re-push
  the previous turn once.

Confirmed design decisions (reviewed, intentional):

- Lark's "any sender binds" authorization (vs. Weixin's single-user lock) is an
  intentional, accepted design — Lark app-level access control is the
  authorization boundary.

## Risks / Invariants

- Single poll loop per process is an invariant (`ensurePolling` idempotency);
  breaking it would double-consume inbound messages.
- `expose()` must never leak `token`/`appSecret` — only `*Configured` booleans.
- Secret redaction in the audit log (`redactSecrets`/`redactObject`) must cover
  any new credential-bearing field added to events.
- Lark's stateful WS connection is keyed by `domain:appId:appSecret`; credential
  changes must rebuild it (handled by `ensureConnection`).

## Update Triggers

Update this document when: a channel adapter is added/changed; the
`GatewayChannelAdapter` contract or `/api/gateway/*` routes change; the binding /
authorization model changes; the inbound command set or the PM-push trigger
changes; or the `GatewaySettingsFile` shape / persistence changes. After route or
export changes, also regenerate `.ai/generated/public-surface.json`.
