# VibeCodingMaster

VibeCodingMaster is a local GUI workspace for running complex coding tasks with
Claude Code role sessions.

VCM helps you keep one task organized across dedicated roles:

- Project Manager
- Architect
- Coder
- Reviewer
- optional Gate Reviewer

It runs locally, connects to a local Git repository, creates a task branch and
worktree, starts embedded Claude Code terminals, and manages handoffs,
orchestration, translation, harness setup, and mobile gateway control.

## Requirements

- Node.js 20 LTS or 22+
- npm
- Git
- Claude Code installed and available as `claude`
- Claude Code authenticated in the same environment where VCM runs

For Linux containers, make sure common native build/runtime tools are available:

```bash
python3 make g++ git bash
```

## Install

Install from npm:

```bash
npm install -g vibe-coding-master
vcm --version
vcm
```

By default, open:

```text
http://127.0.0.1:4173/
```

Useful flags:

```bash
vcm --help
vcm --version
vcm --host=127.0.0.1 --port=5000
```

## Run From Source

```bash
npm install
npm run dev
```

Open the development UI:

```text
http://127.0.0.1:5173/
```

The backend runs at:

```text
http://127.0.0.1:4173/
```

Production-style local run:

```bash
npm run build
npm start
```

Then open:

```text
http://127.0.0.1:4173/
```

## Recommended Sandbox

VCM can run Claude Code with relaxed local permissions. The recommended setup is
to run VCM and the target repository inside a Dev Container, VM, or other local
sandbox boundary.

For VS Code Dev Containers, forward the UI ports:

```json
{
  "forwardPorts": [4173, 5173],
  "portsAttributes": {
    "4173": {
      "label": "VCM backend / production UI"
    },
    "5173": {
      "label": "VCM dev UI"
    }
  }
}
```

Use repository paths as seen inside the container, for example `/workspace`.

If you want VCM app state to survive container rebuilds, set:

```json
{
  "containerEnv": {
    "VCM_DATA_DIR": "/workspace/.ai/vcm"
  }
}
```

## Quick Start

1. Start VCM with `vcm`.
2. Open the GUI.
3. In `Repository`, enter a local Git repository path and click `Connect`.
4. Create or select a task in the `Task` section. VCM creates a task branch and
   worktree immediately.
5. In `VCM Harness`, initialize or update fixed harness files if VCM reports
   pending changes. Harness changes are written to the active task worktree.
6. If bootstrap is incomplete, open Harness Studio and run bootstrap through
   Harness Engineer.
7. Review the harness/bootstrap commit diff.
8. Start the role sessions, or use the saved launch template / one-click start.
9. Talk mostly to Project Manager.
10. Let PM route work to Architect, Coder, Reviewer, and Gate Reviewer when
    enabled.
11. Review the final result and close the task when finished.

## Repository Setup

VCM works with normal local Git repositories.

After you create or select a task, VCM can install or update harness files in
the active task worktree:

- root `CLAUDE.md` managed block
- `.claude/agents/**`
- `.claude/skills/**`
- `.claude/settings.json` hooks
- `.ai/tools/**`
- `.gitignore` entries for VCM runtime state and task worktrees
- generated-context tooling
- pull request template

VCM preserves user-authored content outside VCM managed blocks.

The fixed harness install is deterministic and creates a commit in the active
task worktree. Bootstrap is AI-assisted and is run through the Harness Engineer
role. Bootstrap fills project-specific docs and generated context such as:

- `docs/ARCHITECTURE.md`
- module-level `ARCHITECTURE.md`
- `docs/TESTING.md`
- `.ai/generated/module-index.json`
- `.ai/generated/public-surface.json`

## Task Workflow

VCM uses one branch and one worktree for each task:

```text
one task = one branch + one task worktree + one role-session set
```

By default:

- branch: `feature/<task-name>`
- worktree: `<repo>/.claude/worktrees/<task-name>`

Roles for the same task share the same task worktree. VCM does not create one
worktree per role.

Typical flow:

```text
Project Manager
  -> Architect
  -> Coder
  -> Reviewer
  -> Architect docs sync
  -> Project Manager final acceptance
```

For complex tasks, ask PM to use managed mode. PM will keep the task moving and
ask the user only when user intent, authorization, external access, real cost,
production permission, sensitive data, or a proven outcome change requires a
human decision.

## Role Sessions

Each role runs in an embedded Claude Code terminal.

Controls:

- `Start`: start a new Claude Code role session
- `Resume`: resume a saved Claude Code session
- `Restart`: stop current process and start fresh
- `Stop`: stop the embedded terminal process

Permission modes:

```text
bypassPermissions
plan
default
```

`bypassPermissions` is the default because VCM expects a local sandbox boundary
such as a Dev Container or VM.

Model and effort can be selected before start/resume/restart. Changes affect the
next launched process, not a currently running Claude Code process.

## Launch Template

The launch template stores per-role defaults:

- permission mode
- model
- effort
- auto orchestration

One-click start launches the four core roles. If any Gate Review Gate is enabled,
it also launches Gate Reviewer.

Translator and Harness Engineer are tool roles. They are controlled from their
own panels, not from the main role tab bar.

## Orchestration

VCM supports manual and automatic orchestration.

Manual mode:

- roles write route messages
- messages appear in the Messages panel
- the user decides what to copy, send, or clear

Automatic mode:

- VCM dispatches route messages to idle target roles
- the UI switches to the target role before dispatch
- Claude Code hooks confirm whether the prompt was accepted

If the flow stops, VCM shows a pause alert. The `Pause alert sound` setting only
controls the sound; the stopped-flow state is still shown in the UI.

## Gate Review Gates

Gate Review is optional and off by default.

Available gates:

- Architecture plan
- Validation adequacy
- Final diff

When a gate is enabled, VCM uses Gate Reviewer as an independent review role.
Gate Reviewer reviews artifacts and diffs, writes a gate report, and returns
only:

- `approve`
- `request_changes`

Gate Reviewer does not run tests and does not choose owners or fixes. PM routes
findings back to the responsible role.

## Translation

Conversation translation is controlled from the sidebar `Translation` section.

VCM uses the project-scoped Translator role and Claude transcript JSONL files,
not raw terminal text.

Common controls:

- enable/disable conversation translation
- auto-send translated user input
- target language
- reply scope
- open Translator session
- file translation
- bootstrap translation memory
- update memory

Supported target languages:

- Chinese
- Japanese
- Korean
- French
- German
- Spanish

Reply scope options:

- Round final reply
- PM final reply
- Each role final reply
- All replies

File and conversation translation state lives under:

```text
<baseRepoRoot>/.ai/vcm/translations/
```

## Mobile Gateway

Gateway lets a mobile chat client control the current local VCM instance.

Supported channels:

- Weixin iLink
- Lark

Gateway can:

- show status
- list projects and tasks
- select a project or task
- create a task
- close a task with confirmation
- send plain text to Project Manager
- push PM replies back to the active chat
- translate mobile messages when Gateway translation is enabled

Gateway does not expose the embedded terminal and does not send directly to
Architect, Coder, Reviewer, or Gate Reviewer.

Common commands:

```text
/help
/start
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
/retry
```

Gateway credentials and audit logs are stored in app-local state, not connected
repositories.

## Harness Studio

Harness Studio is the UI for VCM harness maintenance.

Use it to:

- inspect fixed harness status
- run bootstrap
- open Harness Engineer
- review harness files
- copy file paths for discussion
- review task harness after a task completes
- inspect commit diffs for harness changes
- merge task harness commits back to the connected repository branch when
  appropriate

Harness Engineer is project-scoped and resumable. When it performs task work,
VCM runs it from the active task worktree.

## Closing a Task

`Close Task` is destructive.

It stops task-owned VCM role sessions and removes task-owned worktree/branch
state. Commit or preserve anything important before closing.

Project-scoped tool sessions such as Translator and Harness Engineer are not
ordinary task deliverables. VCM may move them to a safe cwd when task context
changes.

## Troubleshooting

### The page does not open

Check the port printed by VCM. If you start with:

```bash
vcm --port=5000
```

open:

```text
http://127.0.0.1:5000/
```

### Claude Code cannot start

Check that `claude` is available in the same shell/container where VCM runs:

```bash
claude --version
```

Also confirm Claude Code authentication works in that environment.

### Repository cannot create a task

Make sure:

- the repository is a Git repository
- the connected base repo is clean
- no other task is currently active for this project
- the derived `feature/<task>` branch does not already exist
- the derived `.claude/worktrees/<task>` directory does not already exist

### Resume fails

Claude Code only resumes conversations it actually saved. VCM records a Claude
session id after the first accepted prompt. If a session never received a prompt,
start a fresh session instead of resuming.

### Translation does not appear

Check that:

- conversation translation is enabled
- Translator session is running
- the target role has an active Claude Code transcript
- reply scope includes the content you expect to translate

### Gateway cannot send messages

Check that:

- Gateway connection is configured
- Gateway is turned on for task-changing commands
- a project and task are selected
- the PM session is running and idle

## Development

Useful commands:

```bash
npm run typecheck
npm test
npm run build
npm run verify:package
```

Development server:

```bash
npm run dev
```

Production-style run:

```bash
npm run build
npm start
```

## Documentation

- `docs/ARCHITECTURE.md`: repository architecture
- `docs/TESTING.md`: validation strategy
- `docs/vcm-cc-best-practices.md`: current VCM Claude Code harness practice
- `docs/v0.5-custom-workflow-plan.md`: future custom workflow plan
- `docs/cc-best-practices.md`: archived generic Claude Code harness notes
