# V1 Message Bus Orchestration Design

## 1. Goal

Replace the current user-clicked `Send Command` handoff with a PM-mediated role message bus.

The desired user experience:

- The user talks primarily with `project-manager`.
- `project-manager` can assign work to `architect`, `coder`, and `reviewer`.
- Other roles can report results, questions, and blockers back to `project-manager`.
- `project-manager` decides whether to continue orchestration or stop and ask the user.
- The user can still inspect every role session, pause orchestration, and intervene manually.

The key product rule:

```text
User <-> Project Manager <-> Other Roles
```

Do not create a fully connected agent chat room.

## 1.1 Orchestration Mode Switch

The message bus and automatic execution must be separate features.

V1 should expose a task-level switch:

```ts
export type VcmOrchestrationMode =
  | "manual"
  | "auto";
```

Default:

```text
manual
```

Meaning:

- `manual`: roles may send messages through VCM, but VCM does not automatically execute them in the target Claude Code terminal.
- `auto`: VCM may deliver approved role messages directly into the target Claude Code terminal according to backend policy.

Manual mode is the safety-first default. It allows PM-led collaboration without hidden agent-to-agent execution.

## 2. Feasibility

This is feasible with the current VCM architecture.

Existing capability:

- `TerminalRuntime.write(sessionId, data)` can programmatically write to a role terminal.
- `SessionService` can locate role sessions by `taskSlug` and `role`.
- `NodePtyTerminalRuntime` already persists terminal output to role logs.
- The backend already owns task metadata, canonical handoff paths, and role session state.
- The frontend already has role tabs and event log surfaces.

Missing pieces:

- A persistent message model.
- A message service that validates sender, target, task, and delivery policy.
- Role-facing commands or skills so Claude Code roles can ask VCM to send/reply.
- UI state for message history, pause/resume, queued messages, and failures.
- Guardrails against loops, hidden automation, and terminal injection during unsafe moments.

## 3. Recommended Model

Use a backend-mediated message bus.

Roles should not write directly to other PTYs. Roles call VCM, and VCM decides whether to deliver.

```text
project-manager Claude Code session
  -> vcmctl send --to coder --type task --body-file ...
  -> VCM backend MessageService
  -> persist message
  -> policy check
  -> manual mode: wait for user approval
  -> auto mode: write message envelope to coder terminal

coder Claude Code session
  -> vcmctl reply --type blocked --body-file ...
  -> VCM backend MessageService
  -> persist message
  -> policy check
  -> manual mode: wait for user approval
  -> auto mode: write message envelope to project-manager terminal
```

## 4. Role Permissions

V1 should enforce these rules in backend code, not only in prompts.

| Sender | Allowed target | Allowed message types |
| --- | --- | --- |
| user | project-manager | user-request |
| project-manager | architect / coder / reviewer | task, question, review-request, revise, cancel |
| architect | project-manager | result, question, blocked |
| coder | project-manager | result, question, blocked |
| reviewer | project-manager | result, finding, blocked |

Disallowed:

- `coder -> architect`
- `architect -> coder`
- `reviewer -> coder`
- any role creating a new task identity
- any role sending messages for a different `taskSlug`

If a role needs another role, it must ask PM.

## 5. Message Data Model

Add shared type `VcmRoleMessage`.

```ts
export type VcmMessageType =
  | "user-request"
  | "task"
  | "question"
  | "blocked"
  | "result"
  | "finding"
  | "review-request"
  | "revise"
  | "cancel";

export type VcmMessageStatus =
  | "pending_approval"
  | "queued"
  | "staged"
  | "delivered"
  | "acknowledged"
  | "failed"
  | "rejected"
  | "cancelled";

export interface VcmRoleMessage {
  id: string;
  taskSlug: string;
  fromRole: RoleName | "user";
  toRole: RoleName;
  type: VcmMessageType;
  body: string;
  artifactRefs: string[];
  parentMessageId?: string;
  status: VcmMessageStatus;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  stagedAt?: string;
  failureReason?: string;
}
```

Persistence:

```text
.vcm/messages/<task-slug>.jsonl
```

For long bodies:

```text
.ai/handoffs/<task-slug>/messages/<message-id>.md
```

The JSONL record should keep a short preview and a body path when needed.

Orchestration state persistence:

```text
.vcm/orchestration/<task-slug>.json
```

If the file is missing, VCM must treat the task as `manual` mode and `paused: false`.

## 6. Delivery Envelope

VCM should write a clear envelope into the target terminal.

In `auto` mode, VCM may write the full envelope and submit it to the target role.

```text

[VCM MESSAGE]
id: msg_...
task: demo-task
from: project-manager
to: coder
type: task

<message body>

Artifact refs:
- .ai/handoffs/demo-task/architecture-plan.md

Instructions:
- Read the message and execute only within this VCM task.
- Reply to project-manager with vcmctl reply when complete, blocked, or unclear.
[/VCM MESSAGE]

```

The envelope is intentionally visible. Hidden agent-to-agent work should not happen.

In `manual` mode, VCM should not write the full message into the target PTY automatically. Instead:

1. Persist the message.
2. Show the message in the GUI as `pending_approval`.
3. Let the user inspect, approve, reject, or edit.
4. On approval, stage a short one-line terminal input without a trailing carriage return:

```text
Read and handle VCM message msg_123 at .ai/handoffs/demo-task/messages/msg_123.md
```

The user must press Enter in the target embedded terminal for the role to execute it.

This avoids accidental execution while still removing copy/paste burden.

## 7. Role Skill / Command Design

Provide a VCM role skill backed by a local CLI.

The skill text should teach roles when to use VCM messaging. The actual action should be a command, because Claude Code can execute shell commands but VCM should enforce policy in backend.

CLI shape:

```bash
vcmctl send --to coder --type task --body-file /tmp/vcm-message.md
vcmctl reply --type blocked --body "Need clarification on test scope."
vcmctl result --body-file /tmp/vcm-result.md --artifact .ai/handoffs/demo-task/implementation-log.md
vcmctl inbox
vcmctl ready
```

CLI behavior:

- In `manual` mode, `vcmctl send/reply/result` returns `pending_approval` and tells the sender that the user must approve delivery.
- In `auto` mode, `vcmctl send/reply/result` may deliver immediately if policy checks pass.
- Roles must not assume that a sent message has been executed by the target role.
- Roles should wait for a reply message, not for terminal side effects.

Injected environment per role session:

```bash
VCM_API_URL=http://127.0.0.1:<backend-port>
VCM_TASK_SLUG=demo-task
VCM_ROLE=project-manager
VCM_SESSION_ID=session_...
VCM_MESSAGE_TOKEN=<local-session-token>
```

Backend must verify token, task, role, and session before accepting a message.

Skill files:

```text
.vcm/skills/project-manager-messaging.md
.vcm/skills/role-reply.md
```

Or generated role context injected at session start:

- PM gets `send_to_role` rules.
- Other roles get `reply_to_pm` rules.
- All roles get the canonical `taskSlug` and `handoffDir`.

## 8. Backend Components

New files:

```text
src/shared/types/message.ts
src/backend/services/message-service.ts
src/backend/api/message-routes.ts
src/backend/templates/message-envelope.ts
src/backend/templates/role-messaging-context.ts
src/cli/vcmctl.ts
tests/unit/backend/message-service.test.ts
tests/unit/backend/message-envelope.test.ts
```

Existing files to change:

```text
src/backend/server.ts
src/backend/services/session-service.ts
src/backend/runtime/terminal-runtime.ts
src/frontend/routes/task-workspace.tsx
src/frontend/components/event-log.tsx
src/frontend/state/api-client.ts
src/shared/types/api.ts
package.json
```

## 9. Backend API

```http
GET /api/tasks/:taskSlug/messages
POST /api/tasks/:taskSlug/messages
POST /api/tasks/:taskSlug/messages/:messageId/ack
GET /api/tasks/:taskSlug/orchestration
PUT /api/tasks/:taskSlug/orchestration
POST /api/tasks/:taskSlug/messages/:messageId/stage
POST /api/tasks/:taskSlug/messages/:messageId/approve
POST /api/tasks/:taskSlug/messages/:messageId/reject
POST /api/tasks/:taskSlug/orchestration/pause
POST /api/tasks/:taskSlug/orchestration/resume
```

Request:

```ts
export interface SendRoleMessageRequest {
  fromRole: RoleName | "user";
  toRole: RoleName;
  type: VcmMessageType;
  body: string;
  artifactRefs?: string[];
  parentMessageId?: string;
}
```

Response:

```ts
export interface SendRoleMessageResult {
  message: VcmRoleMessage;
  delivered: boolean;
  requiresUserApproval: boolean;
}
```

Task-level orchestration state:

```ts
export interface VcmOrchestrationState {
  taskSlug: string;
  mode: VcmOrchestrationMode;
  paused: boolean;
  updatedAt: string;
}
```

## 10. Delivery Policy

V1 should be conservative.

Recommended V1 behavior:

- Message bus is always available.
- `manual` mode is the default.
- In `manual` mode, role messages become `pending_approval`; VCM does not write to target PTY automatically.
- In `manual` mode, user approval can stage a one-line input into the target terminal, but VCM must not append `\r`.
- In `manual` mode, the user presses Enter to execute the staged message.
- In `auto` mode, VCM may write the visible message envelope and append `\r` after policy checks.
- If target session is not running, queue message and show it in UI.
- If target session is running and mode is `auto`, deliver immediately unless orchestration is paused.
- Prefix delivery with a newline so it does not merge with existing terminal input.
- Persist every attempted delivery.
- Do not auto-confirm Claude Code prompts.
- Do not send more than one queued message to a role at a time.

Known limitation:

VCM currently cannot reliably know whether Claude Code is idle, thinking, or waiting for a permission prompt. This means terminal injection can still arrive at an awkward time.

Mitigation:

- Keep `manual` mode as the default.
- Add `vcmctl ready` as an explicit role readiness signal.
- Phase 1 can use manual approval and staging.
- Phase 2 can add auto delivery only to roles marked ready.

## 11. Loop Prevention

Required guardrails:

- Only PM can send tasks to non-PM roles.
- Non-PM roles can only reply to PM.
- Add `maxMessagesPerTaskRun`, default 20.
- Add `maxConsecutiveAutoTurns`, default 6.
- Add `orchestrationPaused` state.
- Add explicit `orchestrationMode`, default `manual`.
- Add `blocked` message type that stops automation until PM handles it.
- PM must ask user for high-risk decisions.

High-risk blockers:

- destructive file deletion
- database/schema migration
- auth, permission, billing, payment, security
- public API contract changes
- uncertainty about user intent
- repeated role failure

## 12. GUI Changes

Keep role terminals visible, but make PM the user-facing default.

Task workspace:

- PM terminal remains primary.
- Role tabs remain available for inspection.
- Add an `Auto orchestration` toggle, default off.
- Add message timeline below or beside terminal.
- In manual mode, show incoming role messages as approval cards.
- Approval card actions: `Stage`, `Reject`, `Edit`, `Open target role`.
- `Stage` writes a one-line prompt to the target terminal without pressing Enter.
- Add pause/resume orchestration button.
- Show queued/delivered/failed message badges.
- Replace `Send Command` with message-aware actions later.

Possible controls:

```text
[Auto orchestration: Off] [Pause] [Messages: 2 pending / 3 queued / 12 delivered]
```

The user should never need to copy role commands manually.

## 13. Migration From Current Send Command

Current mode:

```text
User clicks Send Command
-> backend sends "read file at role-commands/<role>.md"
```

New mode:

```text
PM calls vcmctl send --to coder
-> backend persists the message
-> if manual mode: GUI asks user to approve/stage
-> if auto mode: backend sends the message envelope directly to coder
```

Role command files can remain useful for long-form handoffs, but they should not be the only dispatch mechanism.

Recommended transition:

1. Keep current `Send Command` temporarily.
2. Add MessageService and message APIs.
3. Add task-level orchestration mode, default `manual`.
4. Add `vcmctl send/reply`.
5. Inject role messaging context into sessions.
6. Update PM instructions to use `vcmctl send`.
7. Replace `Send Command` button with message timeline approval actions.
8. Remove old role-command dispatch once message bus is stable.

## 14. Implementation Phases

### Phase 1: Message Bus MVP

- Add message types.
- Add `MessageService`.
- Persist `.vcm/messages/<task>.jsonl`.
- Add API routes.
- Add `manual` orchestration mode as the default.
- Add user approval and stage APIs.
- Add terminal staging through `TerminalRuntime.write` without trailing `\r`.
- Add backend policy checks.
- Add unit tests.

Acceptance:

- PM can send a message to coder through API.
- Message appears as pending approval in GUI.
- User can stage the message into coder terminal.
- Coder does not execute until user presses Enter.
- Coder can reply to PM through API.
- All messages persist and appear in API.

### Phase 2: Role CLI / Skill

- Add `vcmctl`.
- Inject `VCM_*` env vars into role sessions.
- Add role messaging context templates.
- Add PM skill text and non-PM reply skill text.

Acceptance:

- PM can run `vcmctl send --to coder`.
- Coder can run `vcmctl reply --type blocked`.
- Backend rejects disallowed role-to-role messages.

### Phase 3: GUI Orchestration View

- Add message timeline.
- Add queue/failed badges.
- Add `Auto orchestration` toggle.
- Add pause/resume button for auto mode.
- Add approval cards for manual mode.
- Replace old `Send Command` button.

Acceptance:

- User can understand what PM sent and what roles replied.
- User can keep auto orchestration off and approve each staged delivery.
- User can pause automation when auto orchestration is on.
- Failed deliveries are visible.

### Phase 4: Auto Mode, Readiness, and Queues

- Add `vcmctl ready`.
- Queue messages when target is not ready.
- Deliver one queued message at a time.
- Add max turn limits.
- Enable auto delivery only when task mode is `auto`, orchestration is not paused, target role is ready, and policy checks pass.

Acceptance:

- VCM no longer injects messages into busy role terminals by default.
- Loops stop automatically and surface to PM/user.

## 15. Key Design Decision

Do PM-mediated orchestration, not free multi-agent chat.

This preserves the product promise:

- user talks to PM
- PM coordinates
- roles execute
- blockers return to PM
- PM asks user only when needed

It also keeps auditability and control. The message bus becomes the product spine; embedded terminals remain the execution surface.
