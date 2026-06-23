# VibeCodingMaster Product Design

Last updated: 2026-06-21

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

### 1.1 VCM Statistics Terminology

VCM statistics use a task-level hierarchy:

```text
Session = n x Round = m x Turn
```

- `Session`: one VCM task. It is the statistics container for the whole task, from task creation until Close Task.
- `Round`: one VCM conversation cycle. It starts with an accepted user prompt or VCM-delivered prompt, continues through sequential role orchestration, and ends when the final role turn stops and no next turn starts inside the 10 second stop window. In the normal orchestrated workflow, the final visible result comes back from `project-manager`.
- `Turn`: one role-level Claude Code conversation. It starts when a prompt is submitted to one role session and ends when that role's Claude Code process emits `Stop` or `StopFailure`.

Turns inside one Round are strictly sequential. VCM should finish one role Turn before starting the next role Turn in that Round.

Session state is intentionally small: `created` means no Round has started yet, `running` means there is a current running Round, and `stopped` means there is no current running Round after at least one Round has stopped. Starting Claude Code role sessions does not make the VCM Session `running`.

Round state is only `running` or `stopped`. After a turn-end hook, the 10 second stop window still counts as `running`; the Round becomes `stopped` only when the timer expires without another `UserPromptSubmit`.

This `Session` term is only for VCM statistics. It must not be confused with a Claude Code role session, terminal runtime session, or Claude transcript session id. VCM still runs one Claude Code role session per role inside one task-level VCM Session.

## 2. Product Goals

VCM V1 must make multi-session Claude Code work visible and recoverable:

- Connect a local Git repository.
- Create a named task with its own branch and task-level worktree.
- Start, stop, restart, and resume one Claude Code session per role.
- Keep role terminals embedded in one GUI.
- Preserve task state, session state, handoff files, and message history.
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
  -> architect architecture plan, Scaffold Manifest, and code scaffolding
  -> coder implementation and baseline unit checks
  -> reviewer independent validation
  -> architect docs sync / architecture drift check
  -> project-manager final acceptance, commit, and PR
```

### 4.1 Gate Review Gates

For complex tasks, VCM supports optional Gate Review Gates through a
`gate-reviewer` Claude Code role. Gate Reviewer is a VCM flow role with the same
hook, Round, terminal, and translation behavior as the core roles. Its session
is project-scoped and reusable across tasks, but each gate turn is bound to the
current task and task worktree so task evidence stays explicit.

```text
architect architecture plan
  -> Gate Reviewer checks plan quality before coder starts

reviewer review-report
  -> Gate Reviewer checks validation adequacy before final acceptance

final task diff
  -> Gate Reviewer checks code and PR readiness before PR preparation
```

Each gate returns `approve` or `request_changes`. PM triggers gates through the
`vcm-gate-review` skill at the three workflow points; VCM owns the sidebar
toggles, gate state, Gate Reviewer session, report polling, and PM callback.
Reports are task-scoped under `.ai/vcm/gate-reviews/`. All three gate toggles
default to off.

When any gate is on, or when a Gate Reviewer session already exists, the task
workspace shows `Gate Reviewer` as a fifth terminal role. VCM sends a short gate
prompt into that project session and binds the session to the current task for
hooks, Round state, translation, and report polling. The role remains outside PM
route-file dispatch.
Architecture-plan findings return to architect, validation-adequacy findings
return to reviewer, and final-diff findings go to architect first for
assessment. Gate Reviewer role rules live in `.claude/agents/gate-reviewer.md`.

The detailed design lives in `docs/gate-review-gates.md`.

### 4.2 Task Worktree Model

Task-level worktree management is the required model for all tasks:

```text
one task
  -> one branch
  -> one git worktree
  -> one handoff directory
  -> one set of role sessions
```

VCM must not create worktrees per role. `project-manager`, `architect`, `coder`, and `reviewer` for the same task all run in the same task worktree and hand off sequentially.

When the user creates a task, VCM always creates the branch and worktree immediately. Tasks never run directly in the connected base repository, and there is no separate later button named `Create task worktree`.

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
  -> derive branch feature/<task-name>
  -> derive worktree path .claude/worktrees/<task-name>
  -> verify the base repo is clean
  -> git worktree add -b feature/<task-name> .claude/worktrees/<task-name> <base-ref>
  -> create task metadata
  -> create handoff structure inside the task worktree
  -> open the task workspace with role session cwd = task worktree
```

Task close flow:

```text
user clicks red Close Task
  -> show destructive confirmation
  -> stop VCM-managed running role sessions for the task
  -> explain that VCM deletes the task worktree and task branch
  -> explain that VCM does not check running sessions or uncommitted changes
  -> remove git worktree
  -> delete the task branch
  -> remove VCM task metadata from the base repo
  -> remove task runtime metadata from the task worktree
```

## 5. Roles

### Project Manager

The project manager owns:

- user communication
- task clarification
- role routing
- Debug Mode routing for bugs, failing checks, build/runtime errors, unclear defects, and reviewer failure evidence
- message dispatch
- handoff verification
- final acceptance
- commit and PR preparation after gates pass

The project manager must not become the architect, coder, reviewer, or debugger for non-trivial work. PM routes debug evidence to architect and resumes normal gates after architect reports the debug disposition.

### Architect

The architect owns:

- architecture plan
- Scaffold Manifest with stable row IDs for task-specific file context and coder guidance
- module boundaries
- file responsibilities
- cross-file callable surfaces and contract comments
- code scaffolding with `VCM:CODE <ID>` placeholders
- public contracts
- verifiable behavior and behavior/contract proof points
- Replan triggers
- Debug Mode for routed bug/build/test/runtime investigations
- post-review docs sync and architecture drift checks

Outputs:

- `.ai/vcm/handoffs/architecture-plan.md`
- `.ai/vcm/handoffs/docs-sync-report.md`

### Coder

The coder owns:

- implementation within the approved plan
- completion of architect-defined `VCM:CODE` placeholders and Scaffold Completion handoff by ID
- baseline unit/contract/regression tests
- general coding standards and code documentation consistency

Outputs:

- `.ai/vcm/handoffs/known-issues.md`

### Reviewer

The reviewer owns:

- independent review
- test adequacy
- final validation confidence
- integration and E2E case definitions in `docs/TESTING.md`
- validation strategy, selection rules, and final-validation cleanup
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

All sidebar groups are collapsible and default to collapsed. When no task is selected, `Repository Path` opens by default. The sidebar is a single-open accordion: opening one group closes the previous group, and clicking the open group collapses it.

Sections:

- `Repository Path`
- `Connected Repository`
- `Settings`
- `Translation`
- `Gate Review Gates`
- `Gateway`
- `VCM Harness`
- `New Task`
- `Tasks`

The connected active task also has a bottom status dock. It is not a collapsible sidebar section. It stays at the bottom of the sidebar and shows the active VCM Session title, task status, Session start time, total elapsed time, total Round count, and role active runtime. It also shows the Current Round while a Round is running, or the Last Round after a flow pause, including start time, total elapsed time, role active runtime, Turn count, and Round status.

`Repository Path` layout:

```text
Repository Path
[ /path/to/repo                         ]
[ Recent v                  ] [ Connect ]
```

`Connected Repository` shows the connected base repository, not the active task
worktree:

- base repo path
- current branch
- upstream branch when configured
- ahead/behind status relative to upstream
- current commit hash
- base repo working tree state
- last checked time
- a `Pull` button

Opening this section refreshes the connected repository status through
`GET /api/projects/current`. VCM does not poll this state at high frequency.

The `Pull` button runs `git pull --ff-only` only against the connected base
repository. It is disabled when the base repository has uncommitted changes,
or when the branch has no upstream. VCM does not stash, merge, or mutate task
worktrees from this button.

The old `Dirty: yes/no` label is not used. The UI uses `Working tree: clean` or
`Working tree: uncommitted changes`.

`Settings` contains:

- `Theme` button, cycling through `System`, `Light`, and `Dark`.
- `Flow pause alert` button, on by default, controlling weak and strong pause reminders.
- `Try alert` button, firing the strong pause alert dialog and sound for local verification.
- `Messages` button, opening a modal list of role messages.
- `Events` button, opening a modal list of runtime UI events for the current task.

The default theme mode is `System`, which follows the OS/browser color-scheme preference. The entire application chrome, sidebar, forms, modals, status badges, and workspace panels must support both light and dark rendering. Embedded terminals keep their terminal-native dark styling.

When `Flow pause alert` is on, VCM plays a short, soft, two-note local chime after a role flow stops advancing. If the flow lasted less than 2 minutes, the chime plays 3 times, 1.4 seconds apart, and stops. If the flow lasted 2 minutes or longer, VCM shows an in-app alert dialog and repeats the chime until the user confirms the dialog. The alert sound must reuse one browser audio context after user activation instead of creating a fresh context for each repeat, because Safari can block repeated timer-driven playback when every repeat looks like a new autoplay attempt.
`Try alert` must work even when no flow has just stopped advancing so the user can verify browser sound and notification behavior.
Safari may still require the user to manually set `Safari > Website Settings > Auto-Play > Allow All Auto-Play`; Chrome is the recommended browser for reliable repeated alert sound.

There is no separate `Pause orchestration` or `Resume orchestration` control in the GUI. The current product model is one on/off toggle in the role console toolbar.

`Translation` contains:

- `Conversation translation`
- `Auto-send`
- `Language`
- `Reply scope`
- `File translation`
- `Bootstrap`
- `Update memory`
- `Session status`
- `Open Session`

`Gate Review Gates` contains three independent switches:

- `Architecture plan`
- `Validation adequacy`
- `Final diff`

`VCM Harness` shows whether VCM managed blocks are installed/up to date in the project rules files and `.gitignore`.

`New Task` contains:

- `task name`
- generated branch preview: `feature/<task-name>`
- generated worktree preview: `.claude/worktrees/<task-name>`

There is no optional title input in the current UI.

### Task Workspace

The task workspace header is one compact row:

```text
<task>  [Project Manager] [Architect] [Coder] [Reviewer] [Gate Reviewer?]  [Auto orchestration] [Close Task]
```

The header does not show `TASK WORKSPACE`, branch, or worktree path. Task branch/worktree details remain task metadata, but they are not first-row chrome.

The task workspace does not show a manual `Refresh` button. Task status, role status, messages, orchestration state, and flow pause state refresh automatically. The only remaining `Refresh` control is inside the sidebar `VCM Harness` section, where it rechecks managed project files.

Role tabs show the session status for each visible role. `Gate Reviewer` appears
only when a Gate Review switch is enabled or a Gate Reviewer session already
exists.

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

- `bypassPermissions`
- `plan`
- `default`

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

VCM detects flow pauses from role hook events, not from terminal silence, message history, or pending route files. Claude Code VCM flow roles report through `.claude/settings.json`; Gate Reviewer follows the same hook path while VCM separately validates the assigned gate report.

Backend role state:

- VCM terminal submit: role becomes `running`.
- `Stop`: role becomes `idle` and records `lastTurnEndedAt`.
- `PostCompact`: refreshes role session metadata and records `lastCompactAt` without changing `running`/`idle`.
- `StopFailure`: first checks completion evidence. If the role already wrote an outgoing route file, VCM marks the role idle and dispatches normally. If not, VCM sends a recovery prompt to the same role without marking it idle.
- The role tab and flow pause state react to Claude Code hook events for all VCM flow roles, including Gate Reviewer.

Task-level Round state:

- The first `UserPromptSubmit` starts a Round for the current VCM Session.
- Each accepted `UserPromptSubmit` is the start of one Turn.
- `Stop` ends the current Turn and starts a 10 second stop timer; during that timer, the Round is still `running`.
- `StopFailure` ends the Turn only after VCM decides the role completed or recovery is unavailable. When recovery is sent, the existing Turn stays running.
- A new `UserPromptSubmit` inside the window continues the same Round and starts the next Turn.
- If no new prompt is accepted before the deadline, the Round becomes `stopped`.
- The stop transition is timer-driven from the turn-end event. Round-state reads do not end a Round.
- Before stopping, VCM checks `.ai/vcm/handoffs/messages`; if a pending route message exists and can be delivered, VCM retries delivery and extends the stop window instead of alerting.
- The same Round state stores total Round count, Turn count, completed Turn count, and role active runtime. Active runtime is measured only between `UserPromptSubmit` and the turn-end event, not during the stop window.
- The Round dock shows both wall-clock Round duration and role active runtime. For a running Round, `Total` is `now - Round.startedAt`; for a stopped Round, it is `stoppedAt - Round.startedAt`. `Role runtime` is the accumulated active runtime across Turns in that Round; `Turn count` is the number of accepted prompts in the Round.

The frontend polls this task-level Round state and deduplicates each stopped Round so the same stopped state does not alert on every poll. Flow duration is measured from the first `UserPromptSubmit` to `stoppedAt`, falling back to the last turn-end timestamp when needed. Runs under 2 minutes trigger the weak 3-chime reminder at 1.4 second intervals. Runs at or above 2 minutes trigger the strong alert dialog and repeating sound until confirmation.

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

`.ai/vcm/` is the active VCM local control area, and `.claude/worktrees/` is the Claude-compatible task worktree area. The base repo keeps project-scoped runtime state outside Git; each task runtime repo keeps its own session, message, orchestration, and translation state.

VCM must preserve all user-authored content outside the managed block.

Harness changes are applied only in the active task worktree. For deterministic fixed-harness updates, VCM refuses to run when that worktree has Git-visible changes, writes the harness update, stages the changed harness files, and immediately creates a harness commit. For AI bootstrap work, Harness Engineer runs in the active task worktree and creates its own commit; VCM tracks status and shows the latest active task commit diff for review.

Role sessions get VCM behavior from `CLAUDE.md` and `.claude/agents/*.md`, not from a pasted startup context.

## 11. Handoff Files

Each task creates:

```text
.ai/vcm/handoffs/
  role-commands/
    architect.md
    coder.md
    reviewer.md
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

Claude turn-end scan:

- VCM injects Claude Code `UserPromptSubmit`, `Stop`, `StopFailure`, `PostCompact`, and `PermissionRequest` hooks into `.claude/settings.json`.
- The hooks do not call `vcmctl`; they POST directly to the local VCM backend.
- When a Claude Code role stops, VCM marks that role idle, then scans pending route files.
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
- `StopFailure`: posts directly to the VCM backend; VCM checks for outgoing route-file completion evidence before marking idle. If no evidence exists, VCM sends a same-role recovery prompt and keeps the Turn running.
- `PostCompact`: posts directly to the VCM backend, refreshes `session_id`/`transcript_path`/`cwd`, and records `lastCompactAt`
- `PermissionRequest`: posts directly to the VCM backend and prints the backend response to stdout so Claude Code can consume an allow decision when the local VCM setting is enabled

VCM uses `UserPromptSubmit` as the Claude Code acceptance signal. A successful PTY write only proves VCM delivered text to the embedded terminal; `UserPromptSubmit` proves Claude Code accepted the prompt.

Gate Reviewer does not dispatch route files. PM receives Gate Review completion through the Gate Review callback managed by VCM.

The injected role rules require asynchronous file messaging: after writing or updating a route file, the role must end the current Claude Code turn and wait for VCM to deliver a later reply. Roles should use `.claude/skills/vcm-route-message/SKILL.md` to author route files. Roles must not poll files, start shell loops, keep the turn open waiting for another role to answer, paste directly into another role terminal, or use Claude Code Task/Subagent for VCM role delegation.

Roles must not run background Bash; a `PreToolUse` hook (`.ai/tools/vcm-bash-guard`) denies `run_in_background`, `nohup`, `setsid`, `disown`, and trailing `&`. The only sanctioned long-running mechanism is `.ai/tools/run-long-check` plus `.ai/tools/watch-job` through `vcm-long-running-validation`: the detached job worker enforces the 60 minute ceiling and a supervision lease that kills unwatched jobs, `watch-job` renews the lease in foreground windows of up to 8 minutes (exit `125` means call it again in the same turn), and the VCM backend blocks a role's turn-end while one of its validation jobs is still running.

There is no `vcmctl` in the target design. Hook entrypoints are direct HTTP from Claude Code hooks to the local VCM backend.

## 13. Translation

Translation is a local assistant layer beside the role terminal.

### Translation Controls

Settings are saved in:

```text
<vcmDataDir>/settings.json
```

The settings file stores:

- global translation enablement
- global translation auto-send preference
- global translation target language
- recent repository paths

Translation work is routed through the long-lived Translator session. VCM no longer exposes API-key, provider, or prompt-slot settings for the old API-backed translation path.

Sidebar controls:

- Conversation translation on/off
- Auto-send on/off
- Target language
- Output mode: final summary or all output
- File translation
- Bootstrap
- Update memory

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

- assistant text with `stopReason=end_turn` -> `prose` -> translated
- assistant text with other stop reasons -> `prose` -> preserved by default, translated only in `all output` mode
- AskUserQuestion tool -> formatted `prose` -> preserved by default, translated only in `all output` mode
- TodoWrite tool -> formatted `prose` -> preserved by default, translated only in `all output` mode
- Agent/Task tool -> formatted `prose` -> preserved by default, translated only in `all output` mode
- normal tool_use -> `tool-output` -> preserved
- tool_result -> `tool-output` -> preserved

Display behavior:

- `prose` starts by showing the English source as queued.
- while translating, panel status shows `translating <elapsed>`.
- when translation succeeds, the English source is replaced by Chinese translated text.
- when new translation events arrive, the active panel scrolls to the bottom after render so the latest entry, retry result, or conversation boundary is visible.
- `prose` content is rendered as Markdown, including headings, lists, code fences, tables, and links.
- when translation fails, panel status shows `error` and the entry keeps the visible source plus an error.
- `tool-output` is dim, one-line, truncated by CSS, and not translated.

Long translations do not block capture. Translatable prose entries are pushed to the panel before translation starts. Claude Code prose output waits up to 10 seconds so adjacent entries can be batched into one Claude Code Translator prompt and one temporary result file. When an `end_turn` assistant text arrives, VCM adds it to the current batch and flushes the batch immediately. The default output mode is `PM final reply`, which translates only Project Manager `end_turn` assistant text to reduce translation work. In `all output` mode, intermediate assistant text and structured question/todo/agent events are also translated. `tool_use` and `tool_result` entries are never added to the translation queue; they are displayed immediately.

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

After translation succeeds, the English draft is appended after the original Chinese text in the same textarea.

The translated user input is also shown in the translation panel as a conversation boundary. User-input entries have a thick divider and larger top spacing so the next Claude output reads as the answer to that prompt.

`Send English` pastes the current English text into the active role terminal, then sends Enter as a separate terminal input event.

Translation panel `Auto-send` is separate from task `Auto orchestration`:

- `Auto-send` on: translate and send if there is no translation warning.
- `Auto-send` off: translate to English draft and wait for user send.

Task `Auto orchestration` is a compact selected/unselected button in the task
workspace header next to `Close Task`. New tasks default to auto orchestration.
Conversation translation is controlled by the sidebar `Translation` group; when
enabled, each running core VCM role console shows the translation split, so
switching roles keeps the same global translation setting.

## 14. Mobile Gateway

VCM Gateway is a mobile Weixin DM bridge to the local desktop VCM instance.

Gateway product rules:

- DM only; group chat is not supported.
- One mobile Weixin DM identity binds to one desktop VCM instance.
- Binding is not tied to one project or one task.
- The bound phone can select among the projects and tasks available to the
  desktop VCM instance.
- After QR binding succeeds, VCM keeps a Gateway long-polling connection even
  when Gateway is off; only `/help`, `/start`, `/status`, `/projects`, and
  `/tasks` are accepted in that state. `/start` turns Gateway on from Weixin.
- VCM caches the latest PM reply per task locally. When `/start` turns Gateway
  on and the current task has a cached PM reply, the response includes that
  latest PM reply so the mobile user can resume with context.
- Plain mobile text is sent only to the current task's `project-manager`.
- Gateway never sends directly to `architect`, `coder`, or `reviewer`.
- Gateway can push PM assistant replies to Weixin whenever gateway is enabled,
  even if that PM turn was started from desktop VCM.
- When gateway translation is enabled, mobile Chinese input is translated to
  English before PM receives it, and PM English replies are translated to
  Chinese before Weixin receives them.
- If PM reply translation fails or times out, Gateway sends a translation
  failure notice instead of the English source. The bound phone can send
  `/retry` to retry the latest failed output translation kept in memory.
- The PM prompt does not include the original Chinese text.
- There is no multi-user allowlist. The security model is one bound DM identity.

The first channel is Tencent iLink Bot API / Weixin DM. VCM uses QR login,
`getupdates` long polling, and `sendmessage` text replies. Gateway details and
implementation plan live in `docs/gateway-design.md`.

## 15. Local State

App-level settings:

```text
<vcmDataDir>/settings.json
```

Stored app-level settings include:

- UI theme mode: `system`, `light`, or `dark`
- flow pause alert preference
- Claude Code permission request handling preference
- global translation preferences
- recent repository paths

Gateway state and audit logs:

```text
<vcmDataDir>/gateway/settings.json
<vcmDataDir>/gateway/audit.jsonl
```

Gateway credentials, iLink tokens, DM binding identity, cursors, context tokens,
and audit logs live under `vcmDataDir`. VCM resolves `vcmDataDir` from
`VCM_DATA_DIR`; if it is unset or empty, VCM uses `~/.vcm`.

Repository-level VCM state:

```text
.claude/worktrees/<task>/
```

Project config:

```text
<vcmDataDir>/projects/<project-id>/config.json
<vcmDataDir>/projects/index.json
```

The base repository's `.ai/vcm/` directory stores task-local runtime state, while `.claude/worktrees/` stores nested task worktrees. Long-lived project config is stored under `vcmDataDir`. In Dev Containers, set `VCM_DATA_DIR=/workspace/.ai/vcm` through `containerEnv` so VCM app state survives container rebuilds.

Task worktree local files:

```text
.claude/worktrees/<task>/.ai/vcm/sessions/<task>.json
.claude/worktrees/<task>/.ai/vcm/messages/<task>.jsonl
.claude/worktrees/<task>/.ai/vcm/orchestration/<task>.json
.claude/worktrees/<task>/.ai/vcm/translation/<task>/
.claude/worktrees/<task>/.ai/vcm/gate-reviews/
.claude/worktrees/<task>/.ai/vcm/handoffs/
.claude/worktrees/<task>/.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
```

Project-scoped local files:

```text
.ai/vcm/gate-reviewer/session.json
.ai/vcm/harness-engineer/session.json
.ai/vcm/translations/
.ai/vcm/bootstrap/session.json
```

Project-scoped tool sessions keep their durable state in the base repository,
but their execution cwd is the active task worktree.

External Claude transcripts:

```text
~/.claude/projects/<project-hash>/<claude-session-id>.jsonl
```

## 16. Packaging Expectations

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

## 17. Success Criteria

VCM V1 is successful when:

- A user can connect a repo without global Git safe-directory setup.
- A user can create a task, which creates `feature/<task>` and `.claude/worktrees/<task>`.
- A user can start all four role sessions in the task worktree.
- Switching roles never loses the embedded terminal.
- Restart creates a fresh Claude session; Resume reconnects to the persisted one.
- Permission modes are reflected in the Claude command.
- Sidebar settings include Claude Code permission request handling with `off` and `allow all`; `off` is the default.
- Roles can route messages by writing fixed route files under `.ai/vcm/handoffs/messages/`.
- Manual orchestration lets the user inspect pending route-file messages without auto-submitting Enter.
- Auto orchestration can deliver pending route-file messages to idle running target roles.
- Auto orchestration switches to the target role tab when VCM records `dispatchingAt`, before VCM submits the route-file message.
- Auto orchestration treats `UserPromptSubmit` as the reliable acceptance confirmation; if confirmation does not arrive, backend PTY retries Enter and records a message `failureReason` after retry exhaustion.
- Round completion detection waits for the final role in a chained conversation and can alert with prompt plus sound.
- Translation settings save to `<vcmDataDir>/settings.json`.
- Translation reads Claude transcript JSONL reliably after start, resume, and restart.
- Gateway can bind one Weixin DM identity to the desktop VCM instance, send
  translated plain text to PM, and push translated PM replies back to Weixin.
- Terminal and translation panel have equal, stable reading space.
- Harness install/update preserves user content outside VCM managed blocks.
- Completed tasks can cleanly remove their worktree and VCM task metadata without affecting other tasks.
