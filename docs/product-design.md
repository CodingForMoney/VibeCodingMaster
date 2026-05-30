# VibeCodingMaster Product Design

Last updated: 2026-05-30

This document describes the product that the current code implements. It intentionally removes older CLI-first, tmux, raw-PTY-translation, and main-page artifact-panel designs that are no longer part of V1.

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
- Create a named task.
- Start, stop, restart, and resume one Claude Code session per role.
- Keep role terminals embedded in one GUI.
- Preserve task state, session state, handoff files, message history, and raw terminal logs.
- Let roles communicate through a PM-mediated message bus.
- Let users choose between manual message approval and auto orchestration.
- Install or update VCM role rules into `CLAUDE.md` and `.claude/agents/*.md`.
- Provide a low-cost translation layer so the user can write Chinese while Claude Code receives English engineering instructions.

## 3. Non-Goals

V1 does not include:

- tmux.
- Worktree isolation per role.
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

The workflow is a soft guide in V1. VCM computes readiness from handoff artifact checks and session state, then shows the result in the sidebar. It does not block the user from manually starting a role out of order.

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
- test contracts
- Replan triggers
- post-review docs sync and architecture drift checks

Outputs:

- `.ai/handoffs/<task>/architecture-plan.md`
- `.ai/handoffs/<task>/docs-sync-report.md`

### Coder

The coder owns:

- implementation within the approved plan
- direct unit/contract/regression tests
- validation evidence
- implementation log

Outputs:

- `.ai/handoffs/<task>/implementation-log.md`
- `.ai/handoffs/<task>/validation-log.md`

### Reviewer

The reviewer owns:

- independent review
- test adequacy
- scope and architecture compliance
- docs gap detection
- risk findings

Output:

- `.ai/handoffs/<task>/review-report.md`

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
- `Workflow`
- `Settings`
- `VCM Harness`
- `New Task`
- `Tasks`

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

`Workflow` shows the five soft workflow gates:

- Architecture
- Implementation
- Review
- Docs Sync
- PM Final

`Settings` contains:

- `Messages` button, opening a modal list of role messages.
- `Events` button, opening a modal list of runtime UI events for the current task.
- `Auto orchestration` on/off toggle.

There is no separate `Pause orchestration` or `Resume orchestration` control in the GUI. The current product model is one on/off toggle.

`VCM Harness` shows whether VCM managed blocks are installed/up to date in the project rules files.

`New Task` contains one input:

- `task name`

There is no optional title input in the current UI.

### Task Workspace

The task workspace header is one compact row:

```text
TASK WORKSPACE  <task>  <branch>   [Project Manager] [Architect] [Coder] [Reviewer] [Refresh]
```

Role tabs show the session status for each role.

The main task workspace only renders the active role console. Messages, Events, and Workflow are in the sidebar.

## 7. Role Console

The role console owns a single role session.

Controls:

- Permission mode select.
- `Start`.
- `Resume`.
- `Restart`.
- `Stop`.
- `Translate` toggle.

Permission modes:

- `default`
- `bypassPermissions`
- `--dangerously-skip-permissions`

The permission mode applies on the next start/resume/restart. If a session is already running, changing the select does not mutate that live process.

When translation is off, the console shows one embedded terminal.

When translation is on, the console splits horizontally:

```text
┌────────────────────────────┬────────────────────────────┐
│ embedded Claude terminal   │ Translation panel           │
└────────────────────────────┴────────────────────────────┘
```

The split should stay close to 50/50 width. Both panes expand vertically to fill the remaining workspace height.

## 8. Session Lifecycle

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
claude --agent <role> --session-id <uuid> --dangerously-skip-permissions
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

## 9. Harness Installation

On repository connect, VCM checks:

```text
CLAUDE.md
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

VCM must preserve all user-authored content outside the managed block.

After applying harness changes, the UI tells the user what changed and recommends reviewing and committing those files.

Role sessions get VCM behavior from `CLAUDE.md` and `.claude/agents/*.md`, not from a pasted startup context.

## 10. Handoff Files

Each task creates:

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
    <message-id>.md
```

The product treats handoff files as durable facts. The terminal is useful for live interaction, but handoff files and message history are what survive task handoffs cleanly.

The main UI no longer has a dedicated artifact panel. Artifact APIs still exist for status checks, role command compatibility, and future UI work.

## 11. Message Bus

VCM messaging is API-driven.

```text
role terminal
  -> vcmctl
  -> VCM backend API
  -> policy validation
  -> durable message snapshots
  -> target terminal write when allowed
```

Allowed message routes:

- `project-manager` to `architect` / `coder` / `reviewer`: `task`, `question`, `review-request`, `revise`, `cancel`
- `architect` / `coder` / `reviewer` to `project-manager`: `result`, `question`, `blocked`, `finding`
- `user` to `project-manager`: `user-request`

Manual mode:

- message status becomes `pending_approval` when the target role is running
- user opens `Messages`
- user clicks `Stage`
- VCM writes a short prompt into the target terminal
- VCM does not submit Enter

Auto mode:

- if target role is running, VCM writes a `[VCM MESSAGE]` envelope and submits it
- PM remains the routing hub
- non-PM roles reply to PM

The backend still has a `paused` state field and pause/resume API routes for compatibility. The current GUI exposes only manual/auto.

## 12. Translation

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

The settings modal shows the default prompt for each slot and allows a user override. Empty override means use the default prompt.

### Claude Output Translation

Output translation does not read raw PTY text.

VCM tails Claude Code transcript JSONL files under:

```text
~/.claude/projects/<project-hash>/<claude-session-id>.jsonl
```

The transcript path is persisted in the role session record. If that path is missing, VCM falls back to resolving by current working directory and then scanning `~/.claude/projects` for the newest file with the session id.

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
- when translation fails, panel status shows `error` and the entry keeps the visible source plus an error.
- `tool-output` is dim, one-line, truncated by CSS, and not translated.

There is no keyword classifier that drops assistant text. A previous design skipped permission-looking or log-looking text; that is removed.

### User Input Translation

The composer has one textarea and one `Send English` button.

Keyboard behavior:

- `Enter`: translate current Chinese text, or send the current English draft.
- `Shift+Enter`: insert newline.

After translation succeeds, the English draft replaces the original Chinese text in the same textarea.

`Send English` writes the current English text to the active role terminal and submits Enter.

Translation panel `Auto-send` is separate from task `Auto orchestration`:

- `Auto-send` on: translate and send if there is no translation warning.
- `Auto-send` off: translate to English draft and wait for user send.

## 13. Local State

App-level settings:

```text
~/.vcm/settings.json
```

Repository-level VCM state:

```text
.vcm/config.json
.vcm/tasks/<task>.json
.vcm/sessions/<task>.json
.vcm/messages/<task>.jsonl
.vcm/orchestration/<task>.json
```

Repo handoff artifacts:

```text
.ai/handoffs/<task>/
```

External Claude transcripts:

```text
~/.claude/projects/<project-hash>/<claude-session-id>.jsonl
```

## 14. Packaging Expectations

Published npm packages must include built output:

- `dist/main.js`
- `dist/cli/vcmctl.js`
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

## 15. Success Criteria

VCM V1 is successful when:

- A user can connect a repo without global Git safe-directory setup.
- A user can create a task and start all four role sessions.
- Switching roles never loses the embedded terminal.
- Restart creates a fresh Claude session; Resume reconnects to the persisted one.
- Permission modes are reflected in the Claude command.
- PM can route messages through `vcmctl`.
- Manual orchestration lets the user inspect and stage messages without auto-submitting Enter.
- Auto orchestration can deliver PM-approved work to running target roles.
- Translation settings save to `~/.vcm/settings.json`.
- Translation reads Claude transcript JSONL reliably after start, resume, and restart.
- Terminal and translation panel have equal, stable reading space.
- Harness install/update preserves user content outside VCM managed blocks.
