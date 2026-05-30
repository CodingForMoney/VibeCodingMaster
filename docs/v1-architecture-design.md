# V1 Architecture Design

Last updated: 2026-05-30

This document describes the architecture implemented by the current VCM codebase.

## 1. System Overview

VCM is a local Node.js application with:

- Fastify backend.
- React frontend.
- `node-pty` terminal runtime.
- `xterm.js` terminal view.
- Claude Code role processes.
- API-driven message bus.
- Claude transcript JSONL tailer for translation.

Runtime shape:

```text
browser
  -> React GUI
  -> HTTP API + WebSocket
  -> Fastify backend
  -> services
  -> node-pty
  -> claude --agent <role>
```

The app is local-first. It writes repository task state under `.vcm/`, handoff artifacts under `.ai/handoffs/`, app settings under `~/.vcm/settings.json`, and reads Claude transcript files under `~/.claude/projects/`.

## 2. Processes And Ports

Default ports:

- backend / production GUI: `4173`
- Vite dev GUI: `5173`

Development:

```text
npm run dev
  -> backend at http://127.0.0.1:4173
  -> Vite dev server at http://127.0.0.1:5173
```

Production / npm package:

```text
vcm
  -> backend serves dist-frontend at http://127.0.0.1:4173
```

`src/main.ts` starts the backend and optionally starts Vite when `--dev` is passed.

## 3. Frontend Architecture

Entry:

- `src/frontend/main.tsx`
- `src/frontend/app.tsx`

Main state lives in `App`:

- connected project
- recent repository paths
- harness status
- task list
- active task
- active role
- active workflow report
- active messages
- active orchestration state
- task-local event list

Layout:

```text
AppShell
  sidebar: ProjectDashboard
  main: TaskWorkspace or EmptyWorkspace
```

### ProjectDashboard

File:

- `src/frontend/routes/project-dashboard.tsx`

Responsibilities:

- Render collapsible sidebar sections.
- Render repository connect form.
- Render repository summary.
- Render workflow panel.
- Render settings section with Messages, Events, Auto orchestration.
- Render harness status/actions.
- Render one-field task creation form.
- Render task list.
- Render Messages and Events modals.

All sections default collapsed. `Repository Path` opens when there is no selected task.

### TaskWorkspace

File:

- `src/frontend/routes/task-workspace.tsx`

Responsibilities:

- Fetch task status, messages, and orchestration state.
- Poll those every three seconds.
- Render compact header with task title, branch, role tabs, and Refresh.
- Hold per-role permission mode selection.
- Render one `SessionConsole` per role but only show the active role.
- Emit workflow/messages/orchestration/events back to `App` so sidebar stays synchronized.

### SessionConsole

File:

- `src/frontend/components/session-console.tsx`

Responsibilities:

- Render role toolbar.
- Render embedded terminal for running sessions.
- Render empty/resume state for stopped sessions.
- Toggle translation panel.
- Split terminal and translation into two equal columns when translation is on.

### TranslationPanel

File:

- `src/frontend/components/translation-panel.tsx`

Responsibilities:

- Load translation settings and prompt previews.
- Open translation WebSocket for the current terminal runtime session id.
- Render dark translation output panel.
- Render translation status: `ready`, `translating <elapsed>`, or `error`.
- Render preserved tool output as dim one-line rows.
- Render prose source while translating, then translated text after completion.
- Render user composer.
- Translate on `Enter`; newline on `Shift+Enter`.
- Replace Chinese input with English draft after translation.
- Send English draft to the active terminal.
- Provide panel-level `Auto-send`, `Settings`, and `Clear`.

## 4. Backend Architecture

Entry:

- `src/backend/server.ts`

`createDefaultServerDeps()` wires:

- filesystem adapter
- command runner
- git adapter
- Claude adapter
- app settings service
- node-pty runtime
- session registry
- artifact service
- harness service
- project service
- task service
- session service
- command dispatcher
- status service
- message service
- translation service

Fastify registers:

- project routes
- harness routes
- task routes
- session routes
- artifact routes
- message routes
- translation routes
- terminal WebSocket
- translation WebSocket

## 5. Repository Connection

File:

- `src/backend/services/project-service.ts`
- `src/backend/adapters/git-adapter.ts`

Connect flow:

```text
POST /api/projects/connect
  -> resolve path
  -> check path exists
  -> check .git marker directly
  -> create .vcm/config.json
  -> ensure .ai/handoffs and .vcm state dirs
  -> read branch and dirty state
  -> record recent repo path in ~/.vcm/settings.json
```

Git repository detection:

- `.git` directory with `HEAD` is accepted.
- `.git` file with `gitdir:` pointer and target `HEAD` is accepted.
- This supports normal repositories and worktrees.

Git metadata commands use:

```text
git -c safe.directory=<repoRoot> -c safe.directory=<realpath(repoRoot)> ...
```

VCM does not require global `safe.directory` configuration.

## 6. Task And Artifact Model

File:

- `src/backend/services/task-service.ts`
- `src/backend/services/artifact-service.ts`
- `src/shared/types/task.ts`
- `src/shared/types/artifact.ts`

Task state:

```text
.vcm/tasks/<task>.json
```

Each task stores:

- `taskSlug`
- optional `title`
- timestamps
- repo root
- branch at task creation
- handoff directory
- status
- optional spec path

Task creation:

```text
POST /api/tasks
  -> validate slug
  -> create handoff directories
  -> create artifact templates
  -> write .vcm/tasks/<task>.json
```

Handoff directory:

```text
.ai/handoffs/<task>/
  role-commands/
    architect.md
    coder.md
    reviewer.md
  logs/
    project-manager.log
    architect.log
    coder.log
    reviewer.log
  architecture-plan.md
  implementation-log.md
  validation-log.md
  review-report.md
  docs-sync-report.md
  messages/
```

Artifact checks are simple V1 checks:

- missing
- placeholder / incomplete
- ok

They are used for workflow readiness, not content quality judgment.

## 7. Workflow Computation

File:

- `src/backend/services/status-service.ts`

Endpoint:

```text
GET /api/tasks/:taskSlug/status
```

The workflow has five steps:

```text
architecture-plan -> implementation -> review -> docs-sync -> final-acceptance
```

Step readiness:

- Architecture is ready until `architecture-plan.md` is ok.
- Implementation is blocked until architecture is ok.
- Review is blocked until `implementation-log.md` and `validation-log.md` are ok.
- Docs Sync is blocked until `review-report.md` is ok.
- PM Final is blocked until `docs-sync-report.md` is ok.

The report is displayed in the sidebar `Workflow` section.

## 8. Session Runtime

Files:

- `src/backend/services/session-service.ts`
- `src/backend/adapters/claude-adapter.ts`
- `src/backend/runtime/node-pty-runtime.ts`
- `src/backend/runtime/session-registry.ts`

Session service owns role session lifecycle:

- start
- resume
- restart
- stop
- list
- get

Runtime session id and Claude session id are different:

- runtime session id identifies the local `node-pty` process in VCM.
- Claude session id identifies the Claude Code conversation for resume/transcript lookup.

Start:

```text
claude --agent <role> --session-id <uuid>
```

Resume:

```text
claude --agent <role> --resume <uuid>
```

Permission flags:

```text
--permission-mode bypassPermissions
--dangerously-skip-permissions
```

Session persistence:

```text
.vcm/sessions/<task>.json
```

The persisted record includes:

- runtime session id
- Claude session id
- transcript path
- role
- status
- command display
- permission mode
- cwd
- pid
- raw log path
- role command path
- handoff artifact path

If a runtime process is gone but the role has a Claude session id, `getRoleSession` returns a recoverable `resumable` status.

## 9. Terminal Runtime

File:

- `src/backend/runtime/node-pty-runtime.ts`

The runtime:

- spawns `node-pty`
- sets `TERM=xterm-256color`
- sets color-friendly env vars
- appends raw PTY output to `.ai/handoffs/<task>/logs/<role>.log`
- emits terminal output/input/exit events to WebSocket subscribers
- replays the log on terminal WebSocket subscribe

Terminal WebSocket:

```text
GET /ws/terminal/:sessionId
```

Client messages:

- input
- resize

Server messages:

- output
- exit
- error

## 10. Message Bus

Files:

- `src/backend/services/message-service.ts`
- `src/backend/templates/message-envelope.ts`
- `src/cli/vcmctl.ts`

State:

```text
.vcm/messages/<task>.jsonl
.vcm/orchestration/<task>.json
.ai/handoffs/<task>/messages/<message-id>.md
```

Policy:

- User can only send `user-request` to `project-manager`.
- PM can send `task`, `question`, `review-request`, `revise`, `cancel` to non-PM roles.
- Non-PM roles can send `result`, `question`, `blocked`, `finding` to PM.

Manual mode:

```text
send -> pending_approval -> Stage -> staged
```

`Stage` writes:

```text
Read and handle VCM message <id> at <bodyPath>
```

It does not append Enter.

Auto mode:

```text
send -> delivered
```

The backend writes a `[VCM MESSAGE]` envelope to the target terminal and appends Enter.

The backend still exposes pause/resume orchestration API routes and stores `paused` for compatibility. The current GUI only toggles `mode` between `manual` and `auto`.

## 11. Role Command Compatibility

Files:

- `src/backend/services/command-dispatcher.ts`
- `src/backend/api/session-routes.ts`
- `src/backend/api/artifact-routes.ts`

Compatibility endpoint:

```text
POST /api/tasks/:taskSlug/sessions/:role/dispatch
```

Dispatchable roles:

- `architect`
- `coder`
- `reviewer`

The dispatcher:

1. Loads the task.
2. Reads the role command artifact.
3. Rejects missing, empty, or placeholder role commands.
4. Resolves primary command path `role-commands/<role>.md`, with legacy fallback `<role>-command.md`.
5. Writes `Please read and execute the role command at: <path>` to the target terminal and submits Enter.

This is a compatibility path. The preferred V1 coordination path is `vcmctl` message bus.

## 12. Harness Service

File:

- `src/backend/services/harness-service.ts`

Harness files:

```text
CLAUDE.md
.claude/agents/project-manager.md
.claude/agents/architect.md
.claude/agents/coder.md
.claude/agents/reviewer.md
```

Managed block:

```md
<!-- VCM:BEGIN version=1 -->
...
<!-- VCM:END -->
```

The service:

- checks whether files exist
- checks whether a managed block exists
- compares the managed block with the current template
- plans `create`, `insert`, `update`, or `ok`
- applies only the planned managed-block change

It must not overwrite user content outside the VCM block.

## 13. Translation Architecture

Files:

- `src/backend/services/translation-service.ts`
- `src/backend/services/translation-queue.ts`
- `src/backend/services/translation-prompts.ts`
- `src/backend/services/claude-transcript-service.ts`
- `src/backend/adapters/translation-provider.ts`
- `src/backend/ws/translation-ws.ts`
- `src/backend/api/translation-routes.ts`
- `src/frontend/components/translation-panel.tsx`
- `src/frontend/components/translation-settings-modal.tsx`

### Settings

Settings service:

- `src/backend/services/app-settings-service.ts`

Storage:

```text
~/.vcm/settings.json
```

Stored data:

- translation settings
- translation secrets
- recent repository paths, max 5

Legacy migration:

- `~/.vibe-coding-master/settings.json`
- `~/.vibe-coding-master/translation.json`

### Provider

Provider type:

```text
openai-compatible
```

It uses chat completions and builds the URL from `baseUrl`.

Prompt keys:

- `zh-to-en`
- `zh-to-en-with-context`
- `en-to-zh`

### Claude Output Path

Output translation reads Claude transcript JSONL, not terminal raw output.

Resolution order:

1. persisted `RoleSessionRecord.transcriptPath`
2. `claudeTranscriptPath(session.cwd, session.claudeSessionId)`
3. scan `~/.claude/projects/*/<sessionId>.jsonl` and choose newest mtime

Tailer:

- validates file exists
- can replay history since session start minus a grace window
- uses `fs.watch`
- also polls every 500ms
- parses only complete newline-delimited JSON records

Parsed transcript events:

- `text`
- `thinking`
- `question`
- `todo`
- `agent`
- `tool_use`
- `tool_result`

Translation service behavior:

- ignores thinking
- translates text/question/todo/agent as prose
- preserves tool_use/tool_result as tool-output
- queues translation per runtime session id
- emits WebSocket `translation-entry`
- emits WebSocket `translation-status`

### User Input Path

```text
textarea -> POST translation/input -> provider -> English draft in the same textarea -> optional send
```

Send path:

```text
POST translation/send -> runtime.write(session.id, englishText + "\r")
```

The backend strips trailing newlines before appending `\r`.

## 14. API Surface

Project:

```text
GET  /api/health
GET  /api/projects/recent
GET  /api/projects/current
POST /api/projects/connect
```

Harness:

```text
GET  /api/projects/harness
POST /api/projects/harness/apply
```

Tasks:

```text
GET  /api/tasks
POST /api/tasks
GET  /api/tasks/:taskSlug
GET  /api/tasks/:taskSlug/status
```

Sessions:

```text
GET  /api/tasks/:taskSlug/sessions
POST /api/tasks/:taskSlug/sessions/:role/start
POST /api/tasks/:taskSlug/sessions/:role/resume
POST /api/tasks/:taskSlug/sessions/:role/restart
POST /api/tasks/:taskSlug/sessions/:role/stop
POST /api/tasks/:taskSlug/sessions/:role/dispatch
```

Artifacts:

```text
GET /api/tasks/:taskSlug/artifacts
GET /api/tasks/:taskSlug/artifacts/:artifactName
GET /api/tasks/:taskSlug/role-commands/:role
PUT /api/tasks/:taskSlug/role-commands/:role
GET /api/tasks/:taskSlug/logs/:role
```

Messages:

```text
GET  /api/tasks/:taskSlug/messages
POST /api/tasks/:taskSlug/messages
POST /api/tasks/:taskSlug/messages/:messageId/stage
POST /api/tasks/:taskSlug/messages/:messageId/approve
POST /api/tasks/:taskSlug/messages/:messageId/reject
GET  /api/tasks/:taskSlug/orchestration
PUT  /api/tasks/:taskSlug/orchestration
POST /api/tasks/:taskSlug/orchestration/pause
POST /api/tasks/:taskSlug/orchestration/resume
```

Translation:

```text
GET  /api/translation/settings
PUT  /api/translation/settings
GET  /api/translation/prompts
POST /api/translation/test
POST /api/tasks/:taskSlug/sessions/:role/translation/input
POST /api/tasks/:taskSlug/sessions/:role/translation/send
POST /api/translation/sessions/:sessionId/clear
POST /api/translation/sessions/:sessionId/retry/:translationId
```

WebSockets:

```text
/ws/terminal/:sessionId
/ws/translation/:sessionId
```

## 15. Error Handling

File:

- `src/backend/errors.ts`

Backend services throw `VcmError` with:

- code
- message
- status code
- optional hint

Fastify error handler returns:

```json
{
  "error": {
    "code": "CODE",
    "message": "Human-readable message",
    "hint": "Optional hint"
  }
}
```

## 16. Packaging Architecture

`package.json` publishes built artifacts:

- `dist`
- `dist-frontend`
- `docs`
- `scripts`
- `README.md`

Bins:

- `vcm` -> `dist/main.js`
- `vcmctl` -> `dist/cli/vcmctl.js`

Important scripts:

- `build`: clean, TypeScript build, Vite build
- `verify:package`: verifies required dist files and frontend assets
- `prepack`: build and package verification
- `postinstall`: fixes `node-pty` spawn helper when needed

## 17. Security And Safety Boundaries

Current boundaries:

- VCM runs local processes with the user's permissions.
- VCM does not auto-confirm Claude Code permission prompts.
- Relaxed Claude permission modes are user-selected per role launch.
- Translation API key is local in `~/.vcm/settings.json`.
- Translation output is UI/runtime state only unless a user or role copies it into a file.
- Handoff artifacts and `.vcm` state live in the connected repository; users should decide what to commit or ignore.
- Sandbox isolation should come from a devContainer, Docker container, VM, or other user-controlled environment.

## 18. Known Implementation Boundaries

- No tmux backend.
- No per-role worktree manager.
- No main-page artifact inspector.
- No raw PTY output translation.
- No hard workflow gate enforcement.
- No durable backend event log for the sidebar Events modal; current events are frontend runtime events for the active task.
- No hosted multi-user collaboration.
