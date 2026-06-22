# VCM Gateway Design

Last updated: 2026-06-10

This document defines the first VCM gateway product behavior and implementation
plan. It is based on the local Tencent iLink smoke test at:

```text
/Users/sheldon/Documents/New project 3/weixin-ilink-gateway-test
```

The first gateway channel is Tencent iLink Bot API / Weixin DM.

## Product Definition

VCM Gateway is a mobile conversation bridge between one Weixin DM and one
desktop VCM instance. It is not a remote terminal, not a group-chat bot, and not
a multi-user collaboration feature.

Product rules:

- Support DM only. Group chat is not a supported product mode.
- Bind one mobile Weixin DM identity to one desktop VCM instance.
- The binding is not project-specific and not task-specific.
- The bound phone can manage every project and task available to that desktop
  VCM instance.
- Gateway user messages talk only to the `project-manager` role.
- Gateway never sends directly to `architect`, `coder`, or `reviewer`.
- When the desktop UI has a current task selected, Gateway should adopt that
  project/task context automatically instead of requiring `/tasks` and
  `/use-task` first.
- After QR binding succeeds, VCM keeps a long-polling Gateway connection even
  when Gateway is disabled. Disabled Gateway accepts only `/help`, `/start`,
  `/status`, `/projects`, and `/tasks`.
- VCM stores the latest PM reply for each task in local Gateway state. When
  `/start` enables Gateway and the current task has a cached PM reply, Gateway
  returns that reply immediately so the phone user sees the current task state.
- When Gateway is enabled, browser Flow pause alert should be forced off because
  Weixin becomes the notification path and browser modal alerts can block the
  workflow.
- Gateway may push PM replies to Weixin whenever it is enabled, even when the PM
  turn was started from the desktop UI rather than from Weixin.
- When translation is enabled, Chinese input is translated to English before it
  is sent to PM.
- The prompt sent to PM does not include the original Chinese text.
- There is no allowed-user list. The security model is one bound DM identity.

The short product sentence is:

```text
One phone DM binds to one desktop VCM; the phone can select project/task context,
pull the connected base repository, create and initialize a task through the
saved launch template, send ordinary messages to the current task's PM, receive
translated PM replies, and close completed tasks while gateway is enabled; when
gateway is disabled, the bound phone can still run `/start` and read-only status
commands.
```

## Binding Model

The binding target is the desktop VCM instance.

```text
Weixin DM identity
  <-> desktop VCM instance
```

The gateway stores the iLink bot account token and the bound Weixin user identity
in app-local state. If the QR login result provides a login user id, VCM stores
that identity. If the channel cannot determine the bound user id at login time,
VCM stores the first inbound DM user id after the user confirms binding from the
desktop UI.

Messages from the bound identity are accepted. Messages from any other identity
are ignored or receive a minimal "not bound" reply. They are not treated as
secondary users.

Changing phones or Weixin accounts is a rebind operation:

```text
desktop settings -> disable gateway or reset binding -> QR login / bind again
```

## Mobile Context

Because the binding is to a desktop VCM instance, gateway needs a current mobile
context:

```text
current project
current task
current role = project-manager
translation enabled/disabled
saved launch template
```

Plain text messages are sent to the PM session of the current task only when
Gateway is enabled. If no project or task is selected, gateway replies with a
short setup hint.

VCM normally runs one project and one task at a time. When Gateway is enabled,
or when `/status` is called, VCM should refresh Gateway context from the
desktop-selected project/task when available.

The desktop UI remains the source of truth. Gateway changes mobile context or
task lifecycle state only through explicit commands.

## Command Surface

MVP commands:

```text
/help
/start
/retry
/status
/projects
/use-project <index-or-path>
/pull-current
/tasks
/use-task <index-or-task-slug>
/create-task <task-slug> [title]
/close-task
/close-task confirm <task-slug>
/translate on
/translate off
```

Plain text that does not start with `/` is treated as a PM message for the
current task only when Gateway is enabled.

When Gateway is disabled but still bound, only this subset is accepted:

```text
/help
/start
/status
/projects
/tasks
```

`/start` enables Gateway from the bound Weixin DM. If there is a current task
and VCM has cached a latest PM reply for that task, `/start` includes that reply
in the command response. All plain text, task-changing commands,
project-changing commands, translation toggles, and repository pull commands
require Gateway to be enabled.

When Gateway output translation is enabled, PM replies are translated before
being sent to Weixin. If translation fails or times out, Gateway sends a
translation failure notice instead of the English source. The latest failed
output translation is kept in memory only, and `/retry` retries that source
content. Successful retry clears the memory item; failed retry keeps it for a
later `/retry`.

Task lifecycle commands:

- `/pull-current` calls `POST /api/projects/current/pull` for the selected
  desktop VCM project. It runs the same connected-repository fast-forward-only
  pull as the desktop button. It must fail if the base repo has uncommitted
  changes or if the branch has no upstream.
- `/create-task <task-slug> [title]` creates a task worktree,
  selects it as the mobile current task, applies the saved launch template, and
  starts the four role sessions (`project-manager`, `architect`, `coder`,
  `reviewer`) using the saved desktop launch-template values. The saved template
  controls permission mode, model, effort, and auto orchestration.
  If no template has been saved, VCM uses the default launch template.
- `/close-task` starts a destructive confirmation flow for the current task.
  Gateway replies with the exact confirmation command.
- `/close-task confirm <task-slug>` calls VCM Close Task cleanup for that task:
  stop VCM-managed role sessions, remove the task worktree and task branch when
  the task owns them, and remove VCM task/runtime metadata.

Commands intentionally not in MVP:

```text
/approve
/reject
/pause
/resume
/stop-session
```

The first version should not expose arbitrary terminal controls, role-specific
start/stop controls, approve/reject gates, or shell execution. The state-changing
commands are limited to the VCM task lifecycle primitives needed to run a task
end to end from mobile.

## Inbound Message Flow

```text
Tencent iLink getupdates
  -> weixin-ilink channel
  -> verify bound DM identity
  -> dedupe message id
  -> parse text / command
  -> if command: execute gateway command and reply
  -> if plain text:
       -> require current project + current task
       -> require current task PM session running and hook-idle
       -> translate Chinese to English when enabled
       -> submit English prompt to PM
       -> reply with accepted / busy / error status
```

PM prompt shape when translation is enabled:

```text
[VCM Gateway]
<translated English instruction>
```

The original Chinese is not included in the PM prompt.

If translation is disabled, the plain user text is submitted as-is with the same
`[VCM Gateway]` marker.

Gateway should use the same bracketed-paste terminal submission path as the VCM
desktop input path. A terminal write only proves the text was written to the PTY;
Claude Code `UserPromptSubmit` remains the acceptance signal.

## Task Lifecycle Command Flows

### Pull Current Base Repository

```text
/pull-current
  -> require current project
  -> call POST /api/projects/current/pull
  -> backend runs git pull --ff-only on connected base repo
  -> refresh current project status
  -> reply with branch, upstream, ahead/behind, and short commit
```

Rules:

- Pull only the connected base repository, never a task worktree.
- Use the same backend guard as desktop Connected Repository Pull.
- Do not stash, merge, or continue after divergence.
- If pull fails, reply with the VCM error message and hint.

### Create And Initialize Task

```text
/create-task <task-slug> [title]
  -> require current project
  -> create a task branch and worktree through existing task service/API
  -> select it as gateway current task
  -> load saved launch template from app preferences
  -> set orchestration from template
  -> start four role sessions with template permission/model/effort
  -> switch mobile current role to project-manager
  -> reply with task slug, branch, worktree, template summary, and session status
```

Rules:

- Use the same task creation validation as desktop VCM.
- Use the same one-click-start semantics as desktop VCM: only start from a newly
  created task with no existing role sessions.
- If one role session fails to start, reply with the role that failed and leave
  the partially created task visible in desktop VCM for manual recovery.
- Do not send the task request as a PM prompt. Task creation is a VCM control
  command, not natural-language work for Claude.

### Close Task

```text
/close-task
  -> require current task
  -> reply with destructive confirmation text

/close-task confirm <task-slug>
  -> require current task slug matches confirmation slug
  -> call VCM Close Task cleanup
  -> clear mobile current task if cleanup succeeds
  -> reply with removed worktree, deleted branch, and cleaned state paths
```

Rules:

- Close Task is destructive, so mobile requires explicit confirmation with the
  task slug.
- Use the same cleanup path as desktop Close Task.
- Do not preflight or preserve uncommitted work beyond the existing desktop
  Close Task behavior.
- After cleanup, gateway should ask the user to run `/tasks` or
  `/create-task <task-slug>` for the next task.

## PM Reply Push Flow

Gateway push is not limited to gateway-originated turns. If gateway is enabled,
VCM should push PM replies to Weixin after PM completes a turn.

```text
PM Claude Code Stop hook
  -> load PM session transcript
  -> extract new assistant text since last pushed transcript cursor
  -> ignore tool logs, raw terminal output, and non-PM roles
  -> translate English reply to Chinese when enabled
  -> send Weixin DM through iLink sendmessage
  -> persist last pushed transcript cursor
```

Rules:

- Push only PM assistant replies.
- Do not push token-by-token terminal output.
- Do not push raw tool logs.
- Do not push architect/coder/reviewer replies directly.
- Deduplicate by PM session id and transcript event id or timestamp.
- If translation fails, send the PM original text with a short translation
  failure note.

This keeps the mobile side readable and avoids exposing the embedded terminal as
a chat stream.

## Busy And Error Behavior

The MVP should be conservative.

If the PM session is busy, do not queue arbitrary mobile prompts. Reply:

```text
PM is still working on the current turn. Please wait and send again later.
```

If PM is not running:

```text
The current task's PM session is not running. Start it from desktop VCM first.
```

If no task is selected:

```text
No task is selected. Use /tasks and /use-task first.
```

If `/pull-current` cannot run because the base repo is dirty or has no upstream,
reply with the same VCM reason shown in the desktop Connected Repository section.

If `/create-task` fails task validation, reply with the VCM error and hint.
Common examples are invalid task slug, dirty base repo, existing task branch, or
missing harness ignore rules for `.ai/vcm/` / `.claude/worktrees/`.

If `/create-task` creates the task but one of the four role sessions fails to
start, do not hide the partial state. Reply with:

```text
Task was created, but <role> failed to start. Open desktop VCM to recover or retry.
```

If `/close-task confirm <task-slug>` does not match the current task, do not
clean up anything. Reply with the current task slug and the exact confirmation
command.

If gateway translation fails before sending to PM, do not send the original
Chinese. Reply with a translation failure message and ask the user to retry.

## Tencent iLink Feasibility

The local smoke test proves the required channel primitives:

- QR login with `ilink/bot/get_bot_qrcode`.
- QR status polling with `ilink/bot/get_qrcode_status`.
- Long-poll DM receive with `ilink/bot/getupdates`.
- Text reply with `ilink/bot/sendmessage`.
- Token and cursor persistence outside a repository.
- Handling session expiration through iLink error code `-14`.

Observed request details from the smoke test:

```text
base URL: https://ilinkai.weixin.qq.com
default bot_type: 3
default channel_version: 2.4.3
```

Common headers:

```text
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <token>
X-WECHAT-UIN: <random base64 uin>
iLink-App-Id: bot
iLink-App-ClientVersion: <encoded client version>
SKRouteTag: <optional route tag>
```

QR login:

```text
POST ilink/bot/get_bot_qrcode?bot_type=<bot_type>
body:
{
  "local_token_list": ["<saved token>"]
}

GET ilink/bot/get_qrcode_status?qrcode=<qrcode>
GET ilink/bot/get_qrcode_status?qrcode=<qrcode>&verify_code=<code>
```

QR statuses handled by the smoke test:

```text
wait
scaned
need_verifycode
verify_code_blocked
expired
scaned_but_redirect
binded_redirect
confirmed
```

Long poll receive:

```text
POST ilink/bot/getupdates
body:
{
  "get_updates_buf": "<cursor>",
  "base_info": {
    "channel_version": "2.4.3",
    "bot_agent": "vcm-gateway/<version>"
  }
}
```

The response may include:

```text
ret / errcode
errmsg
longpolling_timeout_ms
get_updates_buf
msgs[]
```

Send text DM:

```text
POST ilink/bot/sendmessage
body:
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<bound user id>",
    "client_id": "<unique client id>",
    "message_type": 2,
    "message_state": 2,
    "item_list": [
      {
        "type": 1,
        "text_item": {
          "text": "<reply text>"
        }
      }
    ],
    "context_token": "<optional latest context token>"
  },
  "base_info": {
    "channel_version": "2.4.3",
    "bot_agent": "vcm-gateway/<version>"
  }
}
```

Inbound message handling:

- Ignore bot messages where `message_type` is bot.
- Accept user messages where `message_type` is user or absent.
- Extract text from `item_list[].text_item.text`.
- Voice text can be read from `item_list[].voice_item.text` if iLink supplies
  it, but MVP should treat non-text input as unsupported unless text is present.
- Use `message_id`, then `client_id`, then sender/time fallback for dedupe.
- Persist `get_updates_buf` after each successful poll response.
- Persist latest `context_token` per bound user and reuse it for replies.

## Local State

Gateway state must live outside connected repositories.

Recommended files:

```text
<vcmDataDir>/gateway/settings.json
<vcmDataDir>/gateway/audit.jsonl
```

VCM resolves `vcmDataDir` from `VCM_DATA_DIR`; when it is unset or empty, VCM
uses `~/.vcm`.

Settings shape:

```json
{
  "version": 1,
  "enabled": false,
  "channel": "weixin-ilink",
  "translationEnabled": true,
  "currentProjectId": null,
  "currentTaskSlug": null,
  "binding": {
    "accountId": null,
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "boundUserId": null,
    "loginUserId": null,
    "token": null,
    "getUpdatesBuf": "",
    "contextTokens": {}
  },
  "dedupe": {
    "recentInboundMessageIds": []
  },
  "pendingConfirmations": {
    "closeTask": {
      "taskSlug": null,
      "createdAt": null,
      "expiresAt": null
    }
  },
  "pushCursors": {
    "<taskSlug>:project-manager:<claudeSessionId>": {
      "lastTranscriptEventId": null,
      "lastTranscriptTimestamp": null
    }
  },
  "updatedAt": "..."
}
```

The token is sensitive. The settings file should be written with user-only file
permissions where the platform supports it.

Audit log rules:

- Record state transitions, command names, message ids, result codes, and error
  classes.
- Redact token, Authorization header, QR URL, and full message bodies by default.
- Store short message previews only when needed for debugging.
- Never write gateway credentials to connected repositories, terminal logs,
  `.ai/vcm/**`, PR descriptions, or generated harness files.

## Backend Architecture

Implemented files:

```text
src/shared/types/gateway.ts

src/backend/gateway/
  gateway-service.ts
  gateway-settings-service.ts
  gateway-command-parser.ts
  gateway-audit-log.ts
  channels/
    weixin-ilink-channel.ts

src/backend/api/gateway-routes.ts
```

Responsibilities:

- `gateway-settings-service`: load/save app-local gateway settings and secrets.
- `weixin-ilink-channel`: QR login, long polling, send text, token expiration.
- `gateway-command-parser`: parse `/help`, `/status`, `/projects`,
  `/use-project`, `/pull-current`, `/tasks`, `/use-task`, `/create-task`,
  `/close-task`, and `/translate`.
- `gateway-audit-log`: append redacted JSONL audit entries.
- `gateway-service`: lifecycle, poll loop, command dispatch, PM terminal
  submission, PM Stop reply push, and error backoff.
- `gateway-routes`: desktop UI settings, QR login start/status, enable/disable,
  rebind, and gateway status.

Service dependencies:

- `ProjectService`: current project, recent project paths, connected-repo
  status, and fast-forward-only pull.
- `TaskService`: task list, task creation, selected task validation, and Close
  Task cleanup.
- `SessionService`: PM session state, Claude session metadata, and role session
  start for launch-template initialization.
- `AppSettingsService`: saved launch template with permission mode, model,
  effort, auto orchestration, plus the global Gateway translation preference.
- `MessageService` / orchestration state service: set the newly created task to
  template auto/manual orchestration mode.
- `TerminalRuntime`: controlled PM terminal submission.
- `ClaudeTranscriptService`: PM assistant output extraction.
- `TranslationService` / Translator: inbound Chinese-to-English and
  outbound target-language translation.
- `ClaudeHookService` or hook event integration: trigger PM reply push after PM
  `Stop`.

## Desktop UI

Add a Gateway section to the sidebar settings area or a dedicated modal:

```text
Gateway: off / on
Channel: Weixin iLink
Binding: not bound / bound
Translation: off / on
Current project
Current task
QR login / Rebind
Last poll status
Last message status
```

The user should be able to:

- enable or disable gateway
- start QR login
- see whether the phone is bound
- reset binding
- inspect the current gateway project/task context
- toggle gateway translation
- inspect recent gateway errors

## Implementation Plan

### Phase 1: Types, Settings, And UI Skeleton

- Add `src/shared/types/gateway.ts`.
- Add app-local gateway settings service under `src/backend/gateway`.
- Add `src/backend/api/gateway-routes.ts`.
- Add desktop UI controls for enable/disable, translation, binding status, and
  current project/task.
- Store settings under `<vcmDataDir>/gateway/settings.json`.

Validation:

- Unit tests for settings normalization and secret redaction.
- API route tests for enable/disable and settings update.

### Phase 2: iLink Channel Adapter

- Port the proven smoke-test behavior into `weixin-ilink-channel.ts`.
- Support QR login and status polling.
- Support token reuse from saved settings.
- Support `getupdates` long polling.
- Support `sendmessage` text DM.
- Persist `get_updates_buf` and context tokens.
- Handle `ret` / `errcode` `-14` as expired login.

Validation:

- Unit tests with mocked fetch for QR statuses, getupdates, sendmessage,
  expiration, redirect host, and retry backoff.
- Manual smoke test with a real Weixin DM before wiring PM submission.

### Phase 3: Inbound Context Commands

- Implement `/help`, `/start`, `/retry`, `/status`, `/projects`,
  `/use-project`, `/tasks`, `/use-task`, `/translate on`, and `/translate off`.
- Implement bound identity check.
- Implement persistent inbound message dedupe.
- Reply with short command results through iLink.

Validation:

- Parser tests for known commands and invalid commands.
- Gateway service tests for ignored unbound users and deduped messages.

### Phase 4: Task Lifecycle Commands

- Implement `/pull-current` by calling the connected repository pull path:
  `POST /api/projects/current/pull` or the equivalent project service method.
- Implement `/create-task <task-slug> [title]` by creating a task worktree
  task, selecting it as mobile current task, applying the saved launch template,
  setting orchestration mode, applying the global Gateway translation state, and
  starting the four core role sessions.
- Implement `/close-task` and `/close-task confirm <task-slug>` as a two-step
  destructive confirmation around the same Close Task cleanup path as desktop
  VCM.
- Persist close-task pending confirmation outside the repository.

Validation:

- Parser tests for `/pull-current`, `/create-task`, `/close-task`, and
  confirmation mismatch.
- Service tests for pull success and pull-blocked reasons.
- Service tests that task creation creates a task worktree and uses launch
  template role settings.
- Service tests for partial role-session start failure reporting.
- Service tests that Close Task calls the existing cleanup path only after exact
  slug confirmation.

### Phase 5: PM Message Submission

- Treat plain DM text as PM input for the current task.
- Require current project, current task, running PM session, and idle PM
  activity.
- If gateway translation is enabled, translate Chinese to English before
  submission.
- Submit only the translated English text to PM with `[VCM Gateway]`.
- Do not include the original Chinese text in the PM prompt.
- Use bracketed paste plus Enter through `submitTerminalInput`.

Validation:

- Tests for no project/task/session/busy/translation failure paths.
- Tests that translated prompts do not include original Chinese.
- Tests that successful submit records a gateway turn audit entry.

### Phase 6: PM Reply Push

- Hook PM `Stop` handling into `gateway-service`.
- Load PM transcript and extract new assistant text since the last push cursor.
- Push PM replies whenever gateway is enabled, regardless of whether the user
  turn started from gateway or desktop.
- Translate PM reply to Chinese when gateway translation is enabled.
- Persist push cursors so restart does not duplicate old PM replies.

Validation:

- Transcript extraction tests with multiple assistant events.
- Deduplication tests across repeated Stop hooks and app restart.
- Translation failure fallback test.

### Phase 7: Audit, Recovery, And Packaging

- Add redacted audit JSONL writer.
- Add gateway lifecycle shutdown on VCM server stop.
- Add status reporting for poll errors, expired login, disabled gateway, and
  last successful message.
- Document manual smoke test steps.

Validation:

- Full unit test pass.
- Build pass.
- Manual iLink smoke test:
  - QR bind
  - `/status`
  - `/pull-current`
  - `/create-task mobile-demo`
  - `/tasks`
  - `/use-task`
  - Chinese plain text to PM
  - PM reply pushed back to Weixin
  - `/close-task` + `/close-task confirm mobile-demo`
  - restart without replaying old messages

## Key Risks And Decisions

PM reply extraction is the main implementation risk. VCM should use Claude
transcript events, not raw PTY output, because terminal output contains tool
logs, redraws, and partial text. The notifier must persist a per-PM-session
cursor.

The second risk is accidental command scope growth. Gateway should support the
small task lifecycle needed to run work end to end from mobile: pull base repo,
create and initialize a task, talk to PM, receive PM replies, and close the
task. It should still avoid arbitrary terminal control, approve/reject gates,
role-specific start/stop controls, shell commands, and direct non-PM prompts.

The third risk is token and message leakage. Gateway credentials and audit logs
must stay under `<vcmDataDir>/gateway`, with secrets redacted from logs and never
written into connected repositories.

The fourth risk is queueing. MVP should not queue multiple arbitrary user
prompts while PM is running. It should return a busy message and let the user
retry after PM stops.

## Acceptance Criteria

Gateway MVP is complete when:

- Desktop VCM can enable/disable Weixin iLink gateway.
- Desktop VCM can QR-bind one Weixin DM identity.
- Bound phone can send `/status` and receive current VCM status.
- Bound phone can list and select current project/task context.
- Bound phone can run `/pull-current` to update the connected base repository
  through VCM's fast-forward-only pull path.
- Bound phone can run `/create-task <task-slug> [title]` to create a task
  worktree, select it, apply the saved launch template, and start
  the four core role sessions.
- Bound phone can send Chinese plain text to current task PM.
- PM receives only the translated English prompt, without original Chinese.
- Gateway can push PM assistant replies to Weixin whenever enabled.
- PM replies are translated to Chinese when gateway translation is enabled.
- Bound phone can close a completed task through `/close-task` plus exact slug
  confirmation, using the same cleanup path as desktop Close Task.
- Duplicate iLink messages and duplicate PM Stop hooks do not produce duplicate
  sends.
- Expired iLink token is reported clearly and requires rebind.
- Gateway credentials and audit logs stay outside connected repositories.
