# VibeCodingMaster Product Design

Last updated: 2026-06-09

This document describes the current product direction and implemented V1 behavior for VCM.

## 1. Product Positioning

VibeCodingMaster is a local GUI task workspace for Claude Code.

It helps a user run one engineering task through several explicit Claude Code role sessions:

- `project-manager`
- `architect`
- `coder`
- `reviewer`

The user should mostly talk to `project-manager`. The project manager coordinates the other roles through VCM messaging and durable handoff files. The user can still switch into any role session to inspect, guide, or interrupt.

VCM is not a hosted SaaS product. It runs locally, connects to a local repository path, starts local Claude Code processes, and writes local task metadata into that repository.

## 2. Product Goals

VCM V1 must make multi-session Claude Code work visible and recoverable:

- Connect a local Git repository.
- Create a named task with its own branch and task-level worktree by default.
- Start, stop, restart, and resume one Claude Code session per role.
- Keep role terminals embedded in one GUI.
- Preserve task state, session state, handoff files, message history, and raw terminal logs.
- Let roles communicate through a PM-mediated message bus.
- Let users choose between manual message approval and auto orchestration.
- Install or update VCM role rules into `CLAUDE.md` and `.claude/agents/*.md`.
- Provide a low-cost translation layer so the user can write Chinese while Claude Code receives English engineering instructions.
- Clean up completed task worktrees and VCM task metadata when the task is done.

## 3. Non-Goals

V1 does not include:

- tmux.
- Worktree isolation per role.
- Switching a task to a different branch or worktree after task creation.
- A separate `Create task worktree` action after the task already exists.
- Concurrent edits across roles as a product workflow.
- Automatic confirmation of Claude Code permission prompts.
- A main-page artifact inspector.
- Raw PTY parsing to infer Claude answer boundaries.
- Automatic writing of translations into repo artifacts.
- Hosted auth, cloud sync, multi-user collaboration, or project indexing.

## 4. Core Workflow

Recommended flow:

```text
project-manager
  -> architect architecture plan
  -> coder implementation and validation
  -> reviewer independent review
  -> architect docs sync / architecture drift check
  -> project-manager final acceptance, commit, and PR
```

### 4.1 Task Worktree Model

Task-level worktree management is the recommended default model for multi-task parallelism:

```text
one task
  -> one branch
  -> one git worktree
  -> one handoff directory
  -> one set of role sessions
```

VCM must not create worktrees per role. `project-manager`, `architect`, `coder`, and `reviewer` for the same task all run in the same task worktree and hand off sequentially.

When the user creates a task, `Create worktree and branch` is selected by default. With that option selected, VCM creates the branch and worktree immediately. If the user clears the option, VCM creates the task in the currently connected repository path and records the current branch.

There is no separate later button named `Create task worktree`, and a task cannot be switched between worktree and non-worktree mode after creation.

Branch naming:

```text
feature/<task-name>
```

Worktree path:

```text
<base-repo>/.claude/worktrees/<task-name>
```

Example:

```text
base repo: /workspace
task: docs-cleanup
branch: feature/docs-cleanup
worktree: /workspace/.claude/worktrees/docs-cleanup
```

The repo's `.gitignore` must ignore `.ai/vcm/` and `.claude/worktrees/`. This is mandatory because the task worktrees live under `.claude/worktrees/`, and the base repository must not see nested worktree files as untracked source files.

Task creation flow:

```text
New Task submit
  -> validate task name
  -> verify .ai/vcm/ is ignored
  -> verify .claude/worktrees/ is ignored
	  -> if Create worktree and branch is selected:
	       -> derive branch feature/<task-name>
	       -> derive worktree path .claude/worktrees/<task-name>
	       -> verify the base repo is clean
	       -> git worktree add -b feature/<task-name> .claude/worktrees/<task-name> <base-ref>
	  -> otherwise:
	       -> use the connected repo path and current branch
	       -> reject if another inline task is already active
  -> create task metadata
  -> create handoff structure inside the task runtime repo
  -> open the task workspace with role session cwd = task runtime repo
```

Task close flow:

```text
user clicks red Close Task
  -> show destructive confirmation
  -> stop VCM-managed running role sessions for the task
  -> explain that VCM deletes the task worktree and task branch
  -> explain that VCM does not check running sessions or uncommitted changes
  -> remove git worktree when the task owns one
  -> delete the task branch by default when the task owns one
  -> remove VCM task metadata from the base repo
  -> remove task runtime metadata from the task runtime repo
```

Tasks created without a worktree do not own a separate branch/worktree, so Close Task stops VCM-managed running role sessions and removes only VCM metadata for those tasks.

## 5. Roles

### Project Manager

The project manager owns:

- user communication
- task clarification
- role routing
- message dispatch
- handoff verification
- final acceptance
- commit and PR preparation after gates pass

The project manager must not become the architect, coder, and reviewer for non-trivial work.

### Architect

The architect owns:

- architecture plan
- module boundaries
- file responsibilities
- public contracts
- verifiable behavior and behavior/contract proof points
- Replan triggers
- post-review docs sync and architecture drift checks

Outputs:

- `.ai/vcm/handoffs/architecture-plan.md`
- `.ai/vcm/handoffs/docs-sync-report.md`

### Coder

The coder owns:

- implementation within the approved plan
- direct unit/contract/regression tests
- validation evidence

Outputs:

- `.ai/vcm/handoffs/known-issues.md`

### Reviewer

The reviewer owns:

- independent review
- test adequacy
- scope and architecture compliance
- docs gap detection
- risk findings

Output:

- `.ai/vcm/handoffs/review-report.md`
- `.ai/vcm/handoffs/known-issues.md`

## 6. Information Architecture

The app has two primary areas:

```text
┌───────────────────────────────┬─────────────────────────────────────────────┐
│ Sidebar                       │ Task Workspace                              │
│ collapsible sections          │ header + active role console                │
└───────────────────────────────┴─────────────────────────────────────────────┘
```

### Sidebar

All sidebar groups are collapsible and default to collapsed. When no task is selected, `Repository Path` opens by default.

Sections:

- `Repository Path`
- `Repository`
- `Settings`
- `VCM Harness`
- `New Task`
- `Tasks`

The connected active task also has a bottom status dock. It is not a collapsible sidebar section. It stays at the bottom of the sidebar and shows the active task title, task status, task start time, total elapsed time, total flow-round count, and Claude Code active runtime. When the current round is active or settling, it also shows that round's start time and Claude Code active runtime.

`Repository Path` layout:

```text
Repository Path
[ /path/to/repo                         ]
[ Recent v                  ] [ Connect ]
```

`Repository` shows:

- path
- branch
- working tree state

The old `Dirty: yes/no` label is not used. The UI uses `Working tree: clean` or `Working tree: uncommitted changes`.

`Settings` contains:

- `Theme` button, cycling through `System`, `Light`, and `Dark`.
- `Flow pause alert` button, on by default, controlling weak and strong pause reminders.
- `Try alert` button, firing the strong pause alert dialog and sound for local verification.
- `Messages` button, opening a modal list of role messages.
- `Events` button, opening a modal list of runtime UI events for the current task.

The default theme mode is `System`, which follows the OS/browser color-scheme preference. The entire application chrome, sidebar, forms, modals, status badges, and workspace panels must support both light and dark rendering. Embedded terminals keep their terminal-native dark styling.

When `Flow pause alert` is on, VCM plays a short, soft, two-note local chime after a role flow stops advancing. If the flow lasted less than 10 minutes, the chime plays 3 times, 1.4 seconds apart, and stops. If the flow lasted 10 minutes or longer, VCM shows an in-app alert dialog and repeats the chime until the user confirms the dialog.
`Try alert` must work even when no flow has just paused so the user can verify browser sound and notification behavior.

There is no separate `Pause orchestration` or `Resume orchestration` control in the GUI. The current product model is one on/off toggle in the role console toolbar.

`VCM Harness` shows whether VCM managed blocks are installed/up to date in the project rules files and `.gitignore`.

`New Task` contains:

- `task name`
- a `Create worktree and branch` checkbox, selected by default
- generated branch preview when selected: `feature/<task-name>`
- generated worktree preview when selected: `.claude/worktrees/<task-name>`
- current repository/current branch note when cleared

There is no optional title input in the current UI.

The worktree/branch path is the recommended VCM task model, but the user may clear the checkbox for an inline task. VCM should not require a separate worktree creation action later.

### Task Workspace

The task workspace header is one compact row:

```text
<task>  [Project Manager] [Architect] [Coder] [Reviewer]  [Translate] [Close Task]
```

The header does not show `TASK WORKSPACE`, branch, or worktree path. Task branch/worktree details remain task metadata, but they are not first-row chrome.

The task workspace does not show a manual `Refresh` button. Task status, role status, messages, orchestration state, and flow pause state refresh automatically. The only remaining `Refresh` control is inside the sidebar `VCM Harness` section, where it rechecks managed project files.

Role tabs show the session status for each role.

The main task workspace only renders the active role console. Messages and Events are opened from the sidebar.

## 7. Role Console

The role console owns a single role session.

Controls:

- Permission mode select.
- `Start`.
- `Resume`.
- `Restart`.
- `Stop`.

Permission modes:

- `default`
- `bypassPermissions`

The permission mode applies on the next start/resume/restart. If a session is already running, changing the select does not mutate that live process.

When translation is off, the console shows one embedded terminal.

When translation is on, the console splits horizontally:

```text
┌────────────────────────────┬────────────────────────────┐
│ embedded Claude terminal   │ Translation panel           │
└────────────────────────────┴────────────────────────────┘
```

The split should stay close to 50/50 width. Both panes expand vertically to fill the remaining workspace height.

## 8. Flow Pause Detection

VCM detects flow pauses from Claude Code hook events, not from terminal silence, message history, or pending route files.

Backend role state:

- VCM terminal submit: role becomes `running`.
- `Stop`: role becomes `idle` and records `lastStopAt`.
- The role tab and flow pause state both react to Claude Code hook events.

Task-level round state:

- The first `UserPromptSubmit` starts a flow round.
- Each later `UserPromptSubmit` inside the same flow increments `promptSubmitCount`.
- `Stop` moves the round into a 10 second settling window.
- A new `UserPromptSubmit` inside the window continues the same round.
- If no new prompt is accepted before the deadline, the round becomes `paused`.
- The normal pause transition is timer-driven from the `Stop` event. Round-state reads also settle expired deadlines as a recovery fallback after restarts, sleep, or missed timers.
- The same round state stores total round count, prompt-submit count, stop count, and Claude Code active runtime. Active runtime is measured only between `UserPromptSubmit` and `Stop`, not during the settling window.

The frontend polls this task-level round state and deduplicates `pauseId`. Flow duration is measured from the first `UserPromptSubmit` to the last `Stop`; the 10 second settle window is not counted. Pauses under 10 minutes trigger the weak 3-chime reminder at 1.4 second intervals. Pauses at or above 10 minutes trigger the strong alert dialog and repeating sound until confirmation.

## 9. Session Lifecycle

Buttons:

- `Start`: creates a new Claude session id and starts a fresh role process.
- `Resume`: reuses the persisted Claude session id and starts Claude Code with resume.
- `Restart`: stops the current process and starts a fresh Claude session id.
- `Stop`: stops the current embedded terminal process.

Current command shapes:

```text
claude --agent <role> --session-id <uuid>
claude --agent <role> --resume <uuid>
claude --agent <role> --session-id <uuid> --permission-mode bypassPermissions
```

VCM persists:

- terminal runtime session id
- Claude session id
- transcript path
- role status
- permission mode
- display command
- cwd
- pid when running
- log path

Raw terminal output is appended to the role log path for recovery and debugging. The embedded terminal UI is bounded: xterm keeps a finite scrollback buffer, and reconnect/replay sends only the tail of the raw log, capped at 2 MB. The product must not replay an unbounded terminal log into the browser after a long-running session reconnects.

## 10. Harness Installation

On repository connect, VCM checks:

```text
CLAUDE.md
.gitignore
.claude/agents/project-manager.md
.claude/agents/architect.md
.claude/agents/coder.md
.claude/agents/reviewer.md
```

If a file is missing, VCM can create a recommended default.

If a file already exists, VCM only inserts or replaces the managed block:

```md
<!-- VCM:BEGIN version=1 -->
...
<!-- VCM:END -->
```

For `.gitignore`, VCM uses hash comments:

```gitignore
# VCM:BEGIN version=1
.ai/vcm/
.claude/worktrees/
# VCM:END
```

`.ai/vcm/` is the active VCM local control area, and `.claude/worktrees/` is the Claude-compatible task worktree area. The base repo keeps the task index; each task runtime repo keeps its own session, message, orchestration, and translation state.

VCM must preserve all user-authored content outside the managed block.

After applying harness changes, the UI tells the user what changed and recommends reviewing and committing those files.

Role sessions get VCM behavior from `CLAUDE.md` and `.claude/agents/*.md`, not from a pasted startup context.

## 11. Handoff Files

Each task creates:

```text
.ai/vcm/handoffs/
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
  known-issues.md
  review-report.md
  docs-sync-report.md
  messages/
    project-manager-architect.md
    project-manager-coder.md
    project-manager-reviewer.md
    architect-project-manager.md
    coder-project-manager.md
    reviewer-project-manager.md
    <optional-peer-route>.md
```

The product treats handoff files as task-local coordination facts. The terminal is useful for live interaction, but handoff files and message history are the source of truth during a task. They live under `.ai/vcm/`, are ignored by Git, and are removed by `Close Task`; final decisions that should survive must be copied into normal project docs, source, commit messages, or PR text.

The main UI no longer has a dedicated artifact panel. Artifact APIs still exist for status checks and future UI work.

## 12. Message Bus

VCM messaging is file-driven and dispatched by VCM after Claude Code turn completion. Roles do not call a VCM CLI to send messages.

```text
role terminal
  -> writes/updates one route file under .ai/vcm/handoffs/messages/
  -> ends the Claude Code turn
  -> Claude Code Stop hook calls VCM backend directly
  -> VCM scans pending route files
  -> VCM validates, snapshots, and dispatches one allowed message per idle target role
```

Route files:

- File name format is `<from-role>-<to-role>.md`.
- Role names use VCM role slugs, for example `project-manager-coder.md`.
- The file path determines `from` and `to`; frontmatter cannot override the route.
- The file body is Markdown.
- Optional YAML frontmatter may provide `type`, `severity`, `title`, or `related_artifact`.
- Blank or whitespace-only files mean "no pending message".
- Non-empty files mean "pending message waiting for VCM dispatch".

The important product rule is one file per directed route. If role A decides several times during one turn that it needs to call role B, it must edit the same `A-B.md` file instead of creating multiple messages. This turns duplicate sends into a single latest pending instruction.

Default route policy:

- `project-manager` may send to `architect`, `coder`, and `reviewer`.
- `architect`, `coder`, and `reviewer` may send to `project-manager`.
- Peer routes such as `coder-reviewer.md` may exist for explicit task designs, but VCM still serializes delivery per target role.
- `user` talks to `project-manager` through the normal active terminal or translation composer, not through a route file.

Stop-triggered scan:

- VCM injects Claude Code `UserPromptSubmit` and `Stop` hooks into `.claude/settings.json`.
- The hooks do not call `vcmctl`; they POST directly to the local VCM backend.
- When any role stops, VCM marks that role idle, then scans pending route files.
- VCM scans the stopped role's outgoing files and also any pending files targeting newly idle roles, so messages that were blocked by a busy target can be delivered after that target stops.
- VCM reads only stable, non-empty files and ignores blank files.
- VCM delivers at most one message to a target role per scan.
- If multiple pending files target the same idle role, VCM chooses deterministically by oldest modified time, then route name.

Manual mode:

- role route files stay non-empty as pending handoffs
- user opens `Messages`
- message rows show newest delivered history first with stable increasing sequence, timestamp, body preview, path, and `Copy`
- `Mark All Done` clears pending route files after the user manually handled stuck handoff content
- `Delete All` removes message history without touching pending route files
- user decides whether to copy or manually act on the message
- VCM does not write to the target terminal or submit Enter
- VCM does not clear the source route file until the user marks it done or VCM later dispatches it in auto mode

Auto mode:

- if the target role is running and hook-idle, VCM writes a `[VCM MESSAGE]` envelope to that role's embedded terminal and submits Enter
- before writing to the terminal, VCM stores `dispatchingAt` and waits briefly so the GUI can switch to the target role tab first
- terminal write success stores a durable delivered message snapshot
- Claude Code `UserPromptSubmit` confirms the accepted prompt, stores `acceptedAt`, and clears the source route file if it still contains that same message
- if the target role is not running, is busy, or terminal submission fails, VCM leaves the route file non-empty so it remains pending
- when VCM records `dispatchingAt`, the GUI switches to the target role tab so the user can watch the terminal receive and execute the message
- the target role answers by writing its own route file back to the next role and then ending its turn
- `Mark All Done` is a manual recovery action for stuck orchestration. It clears route files only after the user confirms the pending file contents were manually handled.

VCM Harness injects Claude Code hooks into `.claude/settings.json`:

- `UserPromptSubmit`: posts directly to the VCM backend, marks the role running, and confirms any matching VCM message by recording `acceptedAt`
- `Stop`: posts directly to the VCM backend, marks the role idle, and triggers pending route-file dispatch

VCM uses `UserPromptSubmit` as the Claude Code acceptance signal. A successful PTY write only proves VCM delivered text to the embedded terminal; `UserPromptSubmit` proves Claude Code accepted the prompt.

The injected role rules require asynchronous file messaging: after writing or updating a route file, the role must end the current Claude Code turn and wait for VCM to deliver a later reply. Roles should use `.claude/skills/vcm-route-message/SKILL.md` to author route files. Roles must not poll files, start shell loops, keep the turn open waiting for another role to answer, paste directly into another role terminal, or use Claude Code Task/Subagent for VCM role delegation.

There is no `vcmctl` in the target design. Hook entrypoints are direct HTTP from Claude Code hooks to the local VCM backend.

## 13. Translation

Translation is a local assistant layer beside the role terminal.

### Provider Settings

Settings are saved in:

```text
~/.vcm/settings.json
```

The settings file stores:

- translation provider settings
- translation API key
- recent repository paths

The API key input is a normal text input. The file is local to the user's machine/runtime.

Provider type:

- OpenAI-compatible chat completions

Prompt slots:

- `zh-to-en`
- `zh-to-en-with-context`
- `en-to-zh`

The settings modal shows all three prompt slots as direct editors. `Reset prompts` restores every prompt to its built-in default. The modal does not include separate enable/output/input-mode switches; opening the task header `Translate` panel is the translation on/off control, and the panel-level `Auto-send` toggle controls whether translated user input is submitted automatically.

### Claude Output Translation

Output translation does not read raw PTY text.

VCM tails Claude Code transcript JSONL files under:

```text
~/.claude/projects/<project-hash>/<claude-session-id>.jsonl
```

The transcript path is persisted in the role session record. If that path is missing, VCM falls back to resolving by current working directory and then scanning `~/.claude/projects` for the newest file with the session id.

VCM owns transcript listening in the backend. Opening the translation panel starts or confirms the backend tailer for the active role session. Closing the panel does not stop that tailer; it keeps collecting Claude output until the role session is stopped/restarted or the task is closed. This keeps translation capture independent from frontend rendering.

Backend translation cache lives under:

```text
<taskRepoRoot>/.ai/vcm/translation/<task>/<role>/<session-id>.jsonl
```

The frontend does not subscribe through WebSocket. It polls the backend with a cursor and receives new cached events. The cursor means "next expected seq": `after=18` confirms that seq `1..17` have already been displayed, so the backend can remove those cached events and return seq `18` and later. If the cursor is older than the retained cache, VCM still returns whatever newer events remain; it does not use a snapshot error mode.

Transcript event handling:

- assistant text -> `prose` -> translated
- AskUserQuestion tool -> formatted `prose` -> translated
- TodoWrite tool -> formatted `prose` -> translated
- Agent/Task tool -> formatted `prose` -> translated
- normal tool_use -> `tool-output` -> preserved
- tool_result -> `tool-output` -> preserved

Display behavior:

- `prose` starts by showing the English source.
- while translating, panel status shows `translating <elapsed>`.
- when translation succeeds, the English source is replaced by Chinese translated text.
- `prose` content is rendered as Markdown, including headings, lists, code fences, tables, and links.
- when translation fails, panel status shows `error` and the entry keeps the visible source plus an error.
- `tool-output` is dim, one-line, truncated by CSS, and not translated.

Long translations do not block capture. Prose entries are pushed to the panel before provider translation starts. `tool_use` and `tool_result` entries are never added to the translation queue; they are displayed immediately.

There is no keyword classifier that drops assistant text. A previous design skipped permission-looking or log-looking text; that is removed.

### Translation Retention And Retry

Translation display state is bounded for long sessions. VCM retains the most recent 500 translation entries per role session in frontend/backend memory. Older entries are pruned from the live panel state and from the backend event cache so reconnects do not replay unbounded translation history. Entries that are currently `queued` or `translating` are protected from pruning.

Translation failures are tracked as a backend failure list, separate from the rendered entry list. The panel shows `Ignore N` and `Retry N` only when that list is non-empty.

Failure behavior:

- provider failure for Claude output `prose` adds a `TranslationFailureItem`.
- `Retry N` retries the failure list and reuses the original translation entry id, so the existing failed row becomes `translating` and then `translated` on success.
- `Ignore N` clears the failure list without deleting visible entries.
- if retention pruning removes an old failed entry, VCM also removes the matching failure-list item so retry never targets a deleted entry.
- `tool-output`, conversation boundary rows, and user-input translation failures are not part of the output retry list.

### User Input Translation

The composer has one textarea and one `Send English` button.

Keyboard behavior:

- `Enter`: translate current Chinese text, or send the current English draft.
- `Shift+Enter`: insert newline.

After translation succeeds, the English draft replaces the original Chinese text in the same textarea.

The translated user input is also shown in the translation panel as a conversation boundary. User-input entries have a thick divider and larger top spacing so the next Claude output reads as the answer to that prompt.

`Send English` pastes the current English text into the active role terminal, then sends Enter as a separate terminal input event.

Translation panel `Auto-send` is separate from task `Auto orchestration`:

- `Auto-send` on: translate and send if there is no translation warning.
- `Auto-send` off: translate to English draft and wait for user send.

Task `Auto orchestration` is a compact selected/unselected button in the role console toolbar. `Translate` is a global task header toggle next to `Close Task`; it opens/closes the translation split for all role consoles, so switching roles keeps the same translation setting.

## 14. Local State

App-level settings:

```text
~/.vcm/settings.json
```

Stored app-level settings include:

- UI theme mode: `system`, `light`, or `dark`
- translation provider settings and API key
- recent repository paths

Repository-level VCM state:

```text
.ai/vcm/tasks/<task>.json
.claude/worktrees/<task>/
```

Project config:

```text
~/.vcm/projects/<project-id>/config.json
~/.vcm/projects/index.json
```

The base repository's `.ai/vcm/` directory stores the task index, while `.claude/worktrees/` stores nested task worktrees. Long-lived project config is stored under `~/.vcm` so it survives outside Git-ignored repo state.

Task worktree local files:

```text
.claude/worktrees/<task>/.ai/vcm/sessions/<task>.json
.claude/worktrees/<task>/.ai/vcm/messages/<task>.jsonl
.claude/worktrees/<task>/.ai/vcm/orchestration/<task>.json
.claude/worktrees/<task>/.ai/vcm/translation/<task>/
.claude/worktrees/<task>/.ai/vcm/handoffs/
.claude/worktrees/<task>/.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
```

For tasks created without a worktree, the task runtime repo is the connected base repo, so the runtime state resolves under the base repo's `.ai/vcm/`. Because `.ai/vcm/handoffs/` has no task-name segment, VCM allows only one active inline task in a connected repo.

External Claude transcripts:

```text
~/.claude/projects/<project-hash>/<claude-session-id>.jsonl
```

## 15. Packaging Expectations

Published npm packages must include built output:

- `dist/main.js`
- backend route/service/template output in `dist/`
- frontend static assets in `dist-frontend/`
- `README.md`
- `docs/`
- `scripts/`

`prepack` runs:

```text
npm run build && npm run verify:package
```

This protects against publishing raw TypeScript bin files or missing frontend assets.

## 16. Success Criteria

VCM V1 is successful when:

- A user can connect a repo without global Git safe-directory setup.
- A user can create a default task, which creates `feature/<task>` and `.claude/worktrees/<task>`.
- A user can clear `Create worktree and branch` and create a task in the connected repo/current branch.
- A user can start all four role sessions in the task runtime repo.
- Switching roles never loses the embedded terminal.
- Restart creates a fresh Claude session; Resume reconnects to the persisted one.
- Permission modes are reflected in the Claude command.
- Roles can route messages by writing fixed route files under `.ai/vcm/handoffs/messages/`.
- Manual orchestration lets the user inspect pending route-file messages without auto-submitting Enter.
- Auto orchestration can deliver pending route-file messages to idle running target roles.
- Auto orchestration switches to the target role tab when VCM records `dispatchingAt`, before VCM submits the route-file message.
- Round completion detection waits for the final role in a chained conversation and can alert with prompt plus sound.
- Translation settings save to `~/.vcm/settings.json`.
- Translation reads Claude transcript JSONL reliably after start, resume, and restart.
- Terminal and translation panel have equal, stable reading space.
- Harness install/update preserves user content outside VCM managed blocks.
- Completed tasks can cleanly remove their worktree and VCM task metadata without affecting other tasks.
