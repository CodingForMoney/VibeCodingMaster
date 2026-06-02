# V1 Architecture Design

Last updated: 2026-06-02

This document describes the architecture implemented by the current VCM codebase.

## 1. System Overview

VCM is a local Node.js application with:

- Fastify backend.
- React frontend.
- `node-pty` terminal runtime.
- `xterm.js` terminal view.
- Claude Code role processes.
- File-driven route-file message bus dispatched by VCM from Claude Code `Stop` hooks.
- Claude transcript JSONL tailer for translation.

Runtime shape:

```text
browser
  -> React GUI
  -> HTTP API + terminal WebSocket
  -> Fastify backend
  -> services
  -> node-pty
  -> claude --agent <role>
```

The app is local-first. It writes project control state under `.ai/vcm/`, handoff artifacts under `.ai/vcm/handoffs/` inside the active task worktree, app settings under `~/.vcm/settings.json`, and reads Claude transcript files under `~/.claude/projects/`.

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
- Render settings section with Theme, Round alert, Try alert, Messages, and Events.
- Render harness status/actions.
- Render task creation form with one task-name field, a `Create worktree and branch` checkbox selected by default, and generated branch/path previews when selected.
- Render task list.
- Render Messages and Events modals.

All sections default collapsed. `Repository Path` opens when there is no selected task.

### TaskWorkspace

File:

- `src/frontend/routes/task-workspace.tsx`

Responsibilities:

- Fetch task status, messages, orchestration state, and round state.
- Poll those every three seconds.
- Poll lightweight message/orchestration state more frequently for pre-dispatch auto role switching.
- Render compact header with task title, role tabs, global `Translate`, and red `Close Task`.
- Do not render a task-header `Refresh` button; workspace state refreshes automatically.
- Hold per-role permission mode selection.
- Hold global translation toggle state and pass it to every role console.
- Hold task orchestration state and pass its on/off control to the active role console.
- Detect newly dispatching auto-orchestration messages from VCM dispatch and switch the active role tab to the target role before terminal submission.
- Emit task round state to `App` so completion alerts can be deduplicated and displayed.
- Render one `SessionConsole` per role but only show the active role.
- Emit messages/orchestration/events back to `App` so sidebar stays synchronized.

### SessionConsole

File:

- `src/frontend/components/session-console.tsx`

Responsibilities:

- Render role session controls and embedded terminal.
- Render `Auto orchestration` using compact toggle styling.
- Render the translation split panel when the task-level `Translate` header toggle is enabled.

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
- Start backend transcript listening for the current terminal runtime session id.
- Poll backend translation events with a cursor.
- Render dark translation output panel.
- Render translation status: `ready`, `translating <elapsed>`, or `error`.
- Render preserved tool output as dim one-line rows.
- Render prose source while translating, then translated text after completion, using Markdown rendering for prose.
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

- app settings routes
- project routes
- harness routes
- task routes
- session routes
- artifact routes
- message routes
- translation routes
- terminal WebSocket

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
  -> create ~/.vcm/projects/<project-id>/config.json
  -> ensure .ai/vcm state dirs
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

## 6. Task Worktree Architecture

Task-level worktree management is the default architecture for multi-task parallelism.

Rule:

```text
default VCM task = one branch + one git worktree + one handoff directory + one role-session set
```

Branch name:

```text
feature/<taskSlug>
```

Worktree path:

```text
<baseRepoRoot>/.claude/worktrees/<taskSlug>
```

VCM does not support switching a task to another branch or worktree mode after creation. If the user needs a different branch/worktree choice, they should create a new task.

When `Create worktree and branch` is cleared, the task uses:

```text
branch: current connected-repo branch
runtime repo root: <baseRepoRoot>
worktreePath: undefined
```

VCM does not create worktrees by role. All four role sessions for a task share the same task worktree:

```text
.claude/worktrees/<taskSlug>/
  project-manager session cwd
  architect session cwd
  coder session cwd
  reviewer session cwd
```

### 6.1 Base Repo vs Task Worktree

VCM distinguishes:

- `baseRepoRoot`: repository the user connected.
- `taskRepoRoot`: git worktree path for a specific task.
- `branch`: `feature/<taskSlug>`.
- `worktreePath`: same as `taskRepoRoot`.

Base repo state is the task index plus the Claude-compatible container for nested task worktrees:

```text
<baseRepoRoot>/.ai/vcm/tasks/<task>.json
<baseRepoRoot>/.claude/worktrees/<task>/
```

Project configuration is app-local and stored outside the repository:

```text
~/.vcm/projects/<project-id>/config.json
~/.vcm/projects/index.json
```

Task runtime state, source changes, and handoff artifacts live in the task runtime repo. For worktree-backed tasks this is the nested task worktree:

```text
<baseRepoRoot>/.claude/worktrees/<task>/.ai/vcm/sessions/<task>.json
<baseRepoRoot>/.claude/worktrees/<task>/.ai/vcm/messages/<task>.jsonl
<baseRepoRoot>/.claude/worktrees/<task>/.ai/vcm/orchestration/<task>.json
<baseRepoRoot>/.claude/worktrees/<task>/.ai/vcm/translation/<task>/
<baseRepoRoot>/.claude/worktrees/<task>/.ai/vcm/handoffs/
```

For inline tasks, `taskRepoRoot` is the connected base repo, so these same runtime paths resolve under the connected repo's `.ai/vcm/`.

Because the handoff directory is `<taskRepoRoot>/.ai/vcm/handoffs/` without a task slug segment, VCM rejects creating a second active inline task in the same connected repository. Parallel tasks should use the default worktree mode.

This split lets VCM list tasks from the base repo after worktrees are created, while each task's runtime state follows the same root as the role sessions.

### 6.2 Git Ignore Requirement

The base repository must ignore `.ai/vcm/` and `.claude/worktrees/`.

Reason:

- `.claude/worktrees/<task>` is a nested git worktree.
- Without `.claude/worktrees/` in `.gitignore`, the base repo sees worktree files as untracked noise.
- `.ai/vcm` also contains local task/session/message metadata that should not be committed by default.

The VCM harness manages a `.gitignore` block that ignores `.ai/vcm/` and `.claude/worktrees/` before task worktree creation.

### 6.3 Task Creation Flow

```text
POST /api/tasks
  -> validate taskSlug
  -> assert .ai/vcm/ is ignored by Git
  -> if createWorktree is not false:
       -> assert .claude/worktrees/ is ignored by Git
       -> compute branch feature/<taskSlug>
       -> compute worktreePath <baseRepoRoot>/.claude/worktrees/<taskSlug>
       -> assert branch does not already exist
       -> assert worktreePath does not already exist
       -> assert base repo has no uncommitted changes
       -> git worktree add -b feature/<taskSlug> <worktreePath> <baseRef>
	  -> otherwise:
	       -> read current base repo branch
	       -> leave worktreePath undefined
	       -> reject when another inline task is already active
  -> create handoff structure in taskRepoRoot
  -> write central task metadata under baseRepoRoot/.ai/vcm/tasks/<task>.json
```

The default `baseRef` is the connected repo's current `HEAD`.

### 6.4 Task Close Flow

```text
POST /api/tasks/:taskSlug/cleanup
  -> load task metadata
  -> list role sessions for the task
  -> stop each VCM-managed role session whose runtime status is running
  -> stop translation tailers and clear task translation cache
  -> when worktreePath exists, verify it belongs under <baseRepoRoot>/.claude/worktrees/
  -> when worktreePath exists, git worktree remove --force <worktreePath>
  -> when worktreePath exists, delete the task branch by default
  -> delete base task metadata
  -> delete task runtime session/message/orchestration/translation metadata
  -> delete task runtime handoff directory
```

Close Task is intentionally destructive after user confirmation. It actively stops VCM-managed running role sessions, but it does not preflight running sessions or uncommitted worktree changes. Tasks created without a worktree remove VCM metadata only because there is no VCM-owned branch/worktree to delete.

## 7. Task And Artifact Model

File:

- `src/backend/services/task-service.ts`
- `src/backend/services/artifact-service.ts`
- `src/shared/types/task.ts`
- `src/shared/types/artifact.ts`

Task state:

```text
<baseRepoRoot>/.ai/vcm/tasks/<task>.json
```

Each task stores:

- `taskSlug`
- optional `title`
- timestamps
- `repoRoot`, which is the connected base repository
- optional `worktreePath`, which is the task runtime repo when present
- branch, always `feature/<taskSlug>` for VCM-created tasks
- handoff directory
- status
- optional spec path

Task creation:

```text
POST /api/tasks
  -> validate slug
  -> create branch and worktree
  -> create handoff directories
  -> create artifact templates
  -> write base .ai/vcm/tasks/<task>.json
```

Task cleanup is orchestrated by `src/backend/api/task-routes.ts` because it coordinates session stopping, translation tailer stopping, and `TaskService.cleanupTask`.

Handoff directory:

```text
<taskRepoRoot>/.ai/vcm/handoffs/
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

They are used for missing/incomplete artifact warnings, not content quality judgment.

## 8. Task Status Report

File:

- `src/backend/services/status-service.ts`

Endpoint:

```text
GET /api/tasks/:taskSlug/status
```

The status report returns the task record, role sessions, artifact checks, and warnings. VCM no longer computes or renders a Workflow panel; role sequencing is guided by the injected Claude rules and PM-mediated messages.

## 9. Session Runtime

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
<taskRepoRoot>/.ai/vcm/sessions/<task>.json
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

In task-worktree mode, `cwd` must be the immutable task worktree path. Role sessions must not start in the base repo when a task worktree exists.

## 10. Terminal Runtime

File:

- `src/backend/runtime/node-pty-runtime.ts`

The runtime:

- spawns `node-pty`
- sets `TERM=xterm-256color`
- sets color-friendly env vars
- appends raw PTY output to `<taskRepoRoot>/.ai/vcm/handoffs/logs/<role>.log`
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

## 11. Message Bus

Files:

- `src/backend/services/message-service.ts`
- `src/backend/templates/message-envelope.ts`

State:

```text
<taskRepoRoot>/.ai/vcm/messages/<task>.jsonl
<taskRepoRoot>/.ai/vcm/orchestration/<task>.json
<taskRepoRoot>/.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
```

Policy:

- Roles never call a VCM CLI to send messages.
- A role writes or updates exactly one route file for each directed target role.
- File name format is `<from-role>-<to-role>.md`; the filename is the authoritative route.
- Blank route files are not pending.
- Non-empty route files are pending and are dispatched only by VCM.
- Optional YAML frontmatter may provide message type and metadata, but cannot override the route.
- PM-to-role and role-to-PM routes are the default policy. Peer route files are supported only when the task design explicitly allows them.

Manual mode:

```text
role writes route file -> Stop hook -> route file remains pending -> Messages modal -> Copy/manual action
```

The current GUI shows message history sequence, timestamp, route file path, body preview, `Copy`, and `Mark All Done`. VCM leaves the route file non-empty until the user confirms the pending content was handled or auto mode later dispatches it.

Auto mode:

```text
role writes route file
Stop hook -> VCM scans pending route files
target idle and running -> dispatchingAt snapshot -> GUI switches target role tab
brief pre-dispatch delay -> VCM writes envelope + Enter -> delivered history snapshot
UserPromptSubmit hook -> VCM records acceptedAt
acceptedAt -> VCM clears source route file if it still contains the same message
target busy/unavailable/failure -> source route file remains non-empty
target Stop hook -> VCM scans again and may deliver next pending route file
```

The backend records a `dispatchingAt` snapshot before terminal submission. The frontend polls message history frequently enough to switch to the target role during the short pre-dispatch delay. The backend then pastes a `[VCM MESSAGE]` envelope into the target terminal and sends Enter as a separate terminal input event. A successful terminal write creates a delivered message-history snapshot. Claude Code `UserPromptSubmit` is the acceptance confirmation that stores `acceptedAt`. VCM snapshots the message body before clearing the source route file so the message history remains auditable. Delivery is serialized by hook state; VCM does not send to a target role that is still running from an accepted prompt.

VCM Harness owns Claude Code hook injection through `.claude/settings.json`. The target design injects `UserPromptSubmit` and `Stop`. Hooks post directly to a local VCM backend endpoint and do not use `vcmctl`. `UserPromptSubmit` confirms accepted prompts and switches the role activity badge to `running`; `Stop` switches the role activity badge to `idle` and triggers a pending route-file scan. VCM also marks a role `running` immediately after it submits user input or a VCM message to that embedded terminal. VCM does not use Claude Code Subagent hooks for role delegation.

`Mark All Done` is a manual recovery action for stuck orchestration. After user confirmation, it clears pending route files that the user already handled manually. `Delete All` rewrites message history to remove all delivered/accepted records while preserving pending route files.

The message service also serializes message mutations per task inside the VCM process so concurrent hook/API calls cannot race route-file dispatch and acceptance confirmation.

The backend should not keep compatibility-only message command paths after this migration. Removing `vcmctl` is part of the target simplification.

Messages and orchestration snapshots are task runtime state under `taskRepoRoot/.ai/vcm`. Pending route files live in the task worktree handoff directory and are cleared after successful VCM submission.

## 12. Round Completion Architecture

Files:

- `src/backend/services/round-service.ts`
- `src/backend/api/round-routes.ts`
- `src/shared/types/round.ts`

API:

```text
GET /api/tasks/:taskSlug/round
```

The round service reads hook-driven role activity from `RoleSessionRecord`. It does not use transcript tailing as the source of truth for round completion.

- `unknown`
- `idle`
- `answering`

Mapping:

- VCM terminal submit updates the session to `activityStatus: "running"` and the round role state to `answering`
- `Stop` updates the session to `activityStatus: "idle"`, records `lastStopAt`, and the round role state becomes `idle`

Task-level completion:

- Role hook state defines completion. Message history does not define the completed role.
- If any role is `answering`, `using_tools`, `waiting_user`, or `abnormal`, the round remains active.
- When no role is active, the latest role with `lastStopAt` is the completion source.
- In a PM -> role -> PM chain, completion therefore happens after PM emits hook `Stop` for the final response.
- Pending route files prevent completion because more routing/recovery work is waiting.

Frontend behavior:

- `TaskWorkspace` polls the round endpoint with the other task state.
- `App` stores the sidebar `Round alert` preference in `~/.vcm/settings.json`.
- `Try alert` is frontend-only and calls the same round completion notice/sound path without persisting any setting.
- `App` deduplicates `completionId`, then shows a small `Round complete` prompt and plays a short two-note Web Audio chime when alerts are enabled.

## 13. Role Command Compatibility

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
5. Pastes `Please read and execute the role command at: <path>` to the target terminal, then sends Enter as a separate terminal input event.

This is a backend compatibility path only. The current GUI does not expose a visible `Send Command` action, and V1 orchestration does not rely on role-command dispatch. The preferred V1 coordination path is VCM-dispatched route files under `.ai/vcm/handoffs/messages/`.

## 14. Harness Service

File:

- `src/backend/services/harness-service.ts`

Harness files:

```text
CLAUDE.md
.gitignore
.claude/settings.json
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

`.gitignore` uses the same VCM managed-block concept with hash comments:

```gitignore
# VCM:BEGIN version=1
.ai/vcm/
.claude/worktrees/
# VCM:END
```

`.claude/settings.json` is JSON-merged by the harness. VCM preserves existing settings and adds `UserPromptSubmit` and `Stop` hooks that post directly to the local VCM backend using the session-provided VCM API URL, task slug, role, and Claude session id. The hooks must not call `vcmctl`.

The service:

- checks whether files exist
- checks whether a managed block exists
- compares the managed block with the current template
- plans `create`, `insert`, `update`, or `ok`
- applies only the planned managed-block change

It must not overwrite user content outside the VCM block.

## 15. Translation Architecture

Files:

- `src/backend/services/translation-service.ts`
- `src/backend/services/translation-queue.ts`
- `src/backend/services/translation-prompts.ts`
- `src/backend/services/claude-transcript-service.ts`
- `src/backend/adapters/translation-provider.ts`
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

- UI theme preference: `system`, `light`, or `dark`
- translation settings
- translation secrets
- recent repository paths, max 5

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
- also polls every 200ms
- parses only complete newline-delimited JSON records
- is owned by the backend translation service, not the frontend panel
- stays running after the panel closes
- stops only when the role session is stopped/restarted or the task is closed

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
- queues provider translation per runtime session id
- pushes prose entries before provider translation starts
- pushes tool_use/tool_result immediately without entering the translation queue
- writes translation events to `<taskRepoRoot>/.ai/vcm/translation/<task>/<role>/<session-id>.jsonl`
- exposes HTTP polling for frontend rendering

Polling protocol:

- `seq` starts at 1 for each translation session cache.
- the frontend calls `GET /api/translation/sessions/:sessionId/events?after=<cursor>`.
- `after` is the next expected seq, not the last displayed seq.
- `after=18` lets the backend delete cached events with `seq < 18` and return events with `seq >= 18`.
- if `after` is older than the retained cache, the backend returns whatever newer events still exist.
- no snapshot mismatch error is used.
- translated prose replacement is a later `entry` event with the same translation entry id and a newer `seq`.

### User Input Path

```text
textarea -> POST translation/input -> provider -> English draft in the same textarea -> optional send
```

Send path:

```text
POST translation/send -> bracketed paste English text -> short delay -> runtime.write(session.id, "\r")
```

The backend strips trailing newlines before pasting and sends Enter separately. This avoids Claude Code TUI cases where a single large PTY write containing both text and `\r` fills the input line but does not submit it.

## 16. API Surface

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
POST /api/tasks/:taskSlug/cleanup
```

There is no task-level "switch worktree" API. Worktree selection happens only at task creation.

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
GET  /api/tasks/:taskSlug/messages/pending-routes
POST /api/tasks/:taskSlug/messages/mark-all-done
DELETE /api/tasks/:taskSlug/messages/history
GET  /api/tasks/:taskSlug/orchestration
PUT  /api/tasks/:taskSlug/orchestration
```

There is no public message scan or dispatch endpoint. Pending route-file dispatch is triggered only by the Claude Code `Stop` hook through the backend hook service.

Claude Code hooks:

```text
POST /api/hooks/claude-code
POST /api/hooks/claude-code/stop
```

Round:

```text
GET  /api/tasks/:taskSlug/round
```

App settings:

```text
GET  /api/settings/preferences
PUT  /api/settings/preferences
```

Translation:

```text
GET  /api/translation/settings
PUT  /api/translation/settings
GET  /api/translation/prompts
POST /api/translation/test
POST /api/tasks/:taskSlug/sessions/:role/translation/start
GET  /api/translation/sessions/:sessionId/events?after=<cursor>&limit=<n>
POST /api/tasks/:taskSlug/sessions/:role/translation/input
POST /api/tasks/:taskSlug/sessions/:role/translation/send
POST /api/translation/sessions/:sessionId/clear
POST /api/translation/sessions/:sessionId/retry/:translationId
```

WebSockets:

```text
/ws/terminal/:sessionId
```

## 17. Error Handling

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

## 18. Packaging Architecture

`package.json` publishes built artifacts:

- `dist`
- `dist-frontend`
- `docs`
- `scripts`
- `README.md`

Bins:

- `vcm` -> `dist/main.js`

Important scripts:

- `build`: clean, TypeScript build, Vite build
- `verify:package`: verifies required dist files and frontend assets
- `prepack`: build and package verification
- `postinstall`: fixes `node-pty` spawn helper when needed

## 19. Security And Safety Boundaries

Current boundaries:

- VCM runs local processes with the user's permissions.
- VCM does not auto-confirm Claude Code permission prompts.
- Relaxed Claude permission modes are user-selected per role launch.
- Translation API key is local in `~/.vcm/settings.json`.
- Translation output is UI/runtime state only unless a user or role copies it into a file.
- `.ai/vcm` is local project control state and must be ignored by Git.
- Task handoff artifacts live under `.ai/vcm/handoffs/` as task-local runtime state and are removed by Close Task. Durable conclusions belong in normal project docs, code comments, commit messages, or PR text.
- Task worktrees are created only during task creation; VCM does not expose branch/worktree switching APIs.
- Sandbox isolation should come from a devContainer, Docker container, VM, or other user-controlled environment.

## 20. Known Implementation Boundaries

- No tmux backend.
- No per-role worktree manager.
- No branch switching for an existing task.
- No main-page artifact inspector.
- No raw PTY output translation.
- No computed Workflow panel or hard gate enforcement.
- No durable backend event log for the sidebar Events modal; current events are frontend runtime events for the active task.
- No hosted multi-user collaboration.
