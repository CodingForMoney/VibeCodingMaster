# VibeCodingMaster

VibeCodingMaster is a local GUI workspace for running complex coding tasks with
Claude Code role sessions.

VCM helps you keep one task organized across dedicated roles:

- Project Manager
- Architect
- Coder
- Tester
- optional Reviewer

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
10. Let PM route work to Architect, Coder, Tester, and Reviewer when
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
- VCM protocol and runtime tools under `.ai/tools/**`
- `.gitignore` entries for VCM runtime state and task worktrees
- initial project-owned generated-context tooling
- pull request template

VCM preserves user-authored content outside VCM managed blocks.
VCM seeds `.ai/tools/generate-module-index` and
`.ai/tools/generate-public-surface` only when missing. After installation these
generators belong to the project and later harness updates do not replace them.

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

Project Manager may record an advisory task checkpoint under
`.ai/vcm/workflow/state.json`. VCM restores and displays this context after a
restart, but it does not infer transitions or choose the next role. Current
artifacts, Gate Review state, Round/Turn state, and the role rules remain
authoritative.

Whenever Project Manager asks the user a question, it first uses
`vcm-ask-user`. VCM records the wait and cancels any pending role dispatch in
one state update. Stop Hook then ends the PM turn without route scanning. Only
a new direct user message clears the wait, and the next role dispatch requires
a fresh Workflow Review.

Typical flow:

```text
Project Manager
  -> Architect
  -> Coder
  -> Tester
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

## Usage Analytics

Open `Usage Analytics` in the sidebar `Task` section to inspect native Claude
Code usage for the active task. The report shows task totals and breakdowns by
role and model for input, output, cache-read, and cache-creation tokens plus
estimated USD cost. It combines every restart and resumed Claude session for
all seven roles. Codex Bridge usage is excluded.

VCM retains only aggregate task data in
`<task-worktree>/.ai/vcm/telemetry/usage.json`. The file is temporary runtime
state and is removed with the task worktree when the task is closed.

### GPT Through Codex Bridge

VCM can launch its normal Claude Code sessions with models provided by a
host-running Codex Bridge. The Bridge must already be installed and running,
and Codex must be logged in on the host. VCM does not manage the Bridge process
or Codex login.

VCM automatically checks the local-host and DevContainer endpoints:

```text
http://127.0.0.1:3456
http://host.docker.internal:3456
```

Configure Codex Bridge to listen on port `3456`. When VCM runs in a
DevContainer, start it with a container-reachable bind address such as
`codex-bridge serve --host 0.0.0.0 --port 3456`. In the VCM `Settings` section:

1. enter and save the Codex Bridge API key;
2. enable `Codex Bridge models`;
3. confirm the status is `available`;
4. select any discovered Codex Bridge model in a Session model control.

The key is stored in global VCM state (`~/.vcm/settings.json`) with owner-only
permissions and is never returned by the settings API. It is used for Bridge
checks, model discovery, and the Bridge-only `apiKeyHelper`. Bridge sessions receive a
child-only `--settings` override and use the isolated Claude configuration root
`~/.vcm/claude/codex-bridge`. VCM never edits `~/.claude/settings.json`. Native Claude
sessions keep their normal configuration and account authentication; VCM only
removes inherited environment variables that clearly point at the local Bridge
from the native child process.

Codex Bridge child processes use a hard context limit and auto-compaction window of
`258400` tokens. VCM sets Claude Code's proactive compaction threshold to `90%`
(about `232560` tokens), leaving headroom before the Codex API limit. Native
Claude sessions receive no VCM-owned context override.

Resume keeps the provider recorded by the existing Session. Use Restart when
switching between native Claude and Codex Bridge. If the Bridge is disabled,
unreachable, rejects the key, has unavailable Codex credentials, or no longer
exposes the selected model, VCM blocks the new Start, Resume, or Restart and
does not fall back to another model.

## Launch Template

The global launch template stores per-role defaults for the five workflow roles:

- permission mode
- model
- effort
- auto orchestration

One-click start launches the four core roles. If any Gate Review Gate is enabled,
it also launches Reviewer.

Translator and Harness Engineer are tool roles. They are controlled from their
own panels, not from the main role tab bar or the one-click launch template.
Their permission, model, and effort are stored as independent tool Session
defaults only after an explicit Start or Restart succeeds. Selector changes,
Resume, and backend automatic startup do not write these defaults. Without a
saved value, both tools use `bypassPermissions`, the default model, and medium
effort. An existing task Session keeps its own recorded values.

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

Before Project Manager can dispatch Architect, Coder, or Tester, it submits a
strict `workflow-progress.md` transition through `vcm-workflow-review`. VCM
checks the confirmed dispatch history and current task artifacts, then grants
one matching route. The target role's `UserPromptSubmit` consumes that approval
and appends the confirmed transition. A rejected transition can be bypassed
only by the user's exact one-time authorization recorded in the next Workflow
Progress submission.

If the flow stops, VCM always shows a blocking pause alert. `Pause alert sound`
only controls the looping sound. Enabling Gateway turns that preference off once;
it can be turned back on afterward. A new Gateway command closes an open pause
alert after its instruction is successfully submitted to PM.

## Gate Review Gates

Gate Review is optional and off by default.

Available gates:

- Architecture plan
- Validation adequacy
- Code diff

When a gate is enabled, VCM uses Reviewer as an independent review role.
Reviewer reviews artifacts and diffs, writes a gate report, and returns
only:

- `approve`
- `request_changes`

Reviewer does not run tests and does not choose owners or fixes. PM routes
findings back to the responsible role.

Each run has its own request ID and immutable request artifacts. A running
review must be cancelled before replacement; cancellation restarts Reviewer,
and a late result from the cancelled request cannot replace the current Gate
state, stable report, or PM callback.

## Translation

Conversation translation is controlled from the sidebar `Translation` section.

VCM uses a task-scoped Translator role and Claude transcript JSONL files, not
raw terminal text. Translation memory and completed file translations remain
project-level durable data. When translation is enabled and the active task's
Harness is initialized, the backend automatically starts a fresh Translator for
the task or resumes its saved Session.

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
- push the PM Round-final reply and Round status back to the active chat
- translate mobile messages when Gateway translation is enabled

Gateway does not expose the embedded terminal and does not send directly to
Architect, Coder, Tester, or Reviewer.

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

When Gateway starts, VCM enables conversation translation, auto-send, and the
`Round final reply` scope. On a normal Round end, Gateway sends the PM original
reply first, then reuses the matching translation already produced for the
translation panel. `/retry` explicitly creates a new translation only when the
previous Gateway translation failed or was unavailable.

## Harness Studio

Harness Studio is the UI for VCM harness maintenance.

Use it to:

- inspect fixed harness status
- inspect detected project languages and language-server availability
- run bootstrap
- open Harness Engineer
- review harness files
- view and edit shared or role-specific VCM memory
- review and revert memory changes recorded in the active task worktree
- copy file paths for discussion
- review task harness and consolidate optional Auto Memory in one retrospective
- inspect commit diffs for harness changes
- merge task harness commits back to the connected repository branch when
  appropriate

VCM bundles the Claude Code LSP bridge and loads it only for Architect sessions,
including Codex Bridge launches. The project environment must still
provide the language server for each detected language: `rust-analyzer`,
`typescript-language-server`, `pyright-langserver`, `gopls`, `clangd`, or
`jdtls`. Architect preloads `vcm-code-navigation` and uses LSP for semantic
relationships. Accessors, backing fields, trait items, implementations, wrappers,
and aliases are queried as separate symbols; a bounded source-text fallback may
only locate candidates after the correct LSP query is demonstrably partial.
Other roles use generated context and ordinary source reads.
Harness Studio reports
whether the server executable and plugin can run; the role Session performs the
real workspace indexing and semantic query retries. VCM uses Claude Code progress
hooks to detect a model response, tool call, subagent, or compaction that may be
stalled. Detection only opens a warning; it does not interrupt the Session or
change the Round. The user can ignore that warning or explicitly stop and resume
the same Claude Session from the warning dialog.

Harness Engineer is task-scoped and runs from the active task worktree. The
backend automatically starts a fresh Harness Engineer for each active task or
resumes its saved Session. Durable memory is versioned with the project harness
files.

### Auto Memory

`Auto memory` is the switch for the entire automated memory workflow. During
Review Task Harness after Final Acceptance, Project Manager, Architect, Coder,
Tester, and an enabled Reviewer submit proposals in sequence through
`vcm-propose-memory`. Harness Engineer verifies and consolidates them, commits
the reviewed memory, and writes the assigned machine-readable review result as
part of the same Task Harness Retrospective. Workflow roles cannot edit active
memory directly; Harness Engineer edits it only during the assigned Auto Memory
Retrospective.

When Auto Memory is enabled, the planning Architect writes a provisional memory
candidate before its post-planning Session restart. VCM snapshots that candidate
into the later memory-review run. The replacement Architect validates it against
the completed implementation and tests, and Harness Engineer reviews it with all
final role proposals before anything becomes active memory.

Shared memory is stored in the root `CLAUDE.md` `<VCM-memory>` block. Role memory
is stored in the matching `.claude/agents/*.md` block. Harness Engineer changes
only those blocks and creates a dedicated commit in the active task worktree.
VCM verifies the mechanical commit boundary and records the after snapshot and
diff. Harness Studio shows current memory and task-local applied history. Memory
is applied before user review; while the task worktree remains available, the
user can edit current memory or revert a recorded change through another commit.

Post-task processing is ordered by the backend:

```text
Final Acceptance
  -> Review Task Harness
  -> Snapshot Architect planning-session memory candidate, when present
  -> Workflow-role memory proposals, when Auto Memory is enabled
  -> Task Harness Retrospective
       -> Review pending Harness Feedback
       -> Review Auto Memory proposals, when Auto Memory is enabled
       -> Harness Engineer updates and commits memory, when Auto Memory is enabled
       -> Harness Engineer writes review-result.json, when Auto Memory is enabled
  -> VCM validates and records the committed memory result
  -> VCM dispatches durable-document assignments one at a time
  -> Complete Task Harness Retrospective after every assignment completes
```

Memory proposal prompts sent to Project Manager, Architect, Coder, Tester, and
an enabled Reviewer use their normal task sessions and participate in
Round/Turn tracking. Each proposed add, update, or removal identifies its
shared or current-role target and its supporting evidence. Adds and updates
also state why the memory is necessary, the impact of omitting it, and whether
the knowledge belongs in memory or a durable document. Harness Engineer first
reviews every existing memory entry, recording its retention reason, removal
impact, and durable-document disposition, then evaluates every proposal item
independently. Each Add or Update decision records why the memory is necessary,
what happens if it is absent, whether it belongs in memory or a durable
document, and the exact final memory content when retained. VCM validates that
every existing entry and proposal has one structurally valid decision, every
move decision has one durable-document assignment, moved content has already
been removed from memory, and the commit changes only assigned memory host
files and only their `<VCM-memory>` blocks. VCM does not decide whether the
Harness Engineer's semantic judgment is correct. Harness Engineer review and
retrospective work remain tool role activity and do not participate in Round
completion.

For `move-to-durable-doc`, memory is removed in the Harness Engineer commit
before documentation work starts. VCM assigns architecture and known-issues
documents to Architect and testing documentation to Tester. For another target,
PM selects Architect, Coder, or Tester and asks the user only when ownership
cannot be determined. These assignments are backend-dispatched work rather than
a Docs-Only Flow. Each owner updates and commits the document, submits the exact
assignment ID in `docs-update-report.md`, and finishes before the next assignment
starts. Harness Studio shows assignment status and allows failed work to be
retried.

When Auto Memory is disabled, Review Task Harness does not collect proposals or
ask Harness Engineer to update memory. When enabled, both automatic and manual
review requests collect proposals before starting the retrospective. A failed
proposal collection, combined retrospective memory review, or durable-document
assignment must be retried from Harness Studio.

## Closing a Task

`Close Task` is destructive.

It stops every running session owned by the task, including Translator and
Harness Engineer, then removes task-owned worktree/branch state. Commit or
preserve anything important before closing.

Uncommitted changes, unmerged commits, and cleanup failures are reported as
warnings; they do not block logical task closure. VCM may discard the task
worktree and task branch even when they contain commits that are not present on
the connected repository branch.

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
- `docs/CODING_STANDARDS.md`: shared implementation and test standards
- `docs/GLOSSARY.md`: allowed durable abbreviations
- `docs/TESTING.md`: validation strategy
- `docs/known-issues.md`: current unresolved durable issues
- `src/backend/gateway/ARCHITECTURE.md`: mobile gateway sub-area architecture
- `docs/vcm-cc-best-practices.md`: current VCM Claude Code harness practice
- `docs/v0.5-custom-workflow-plan.md`: deferred custom workflow proposal
- `docs/cc-best-practices.md`: archived generic Claude Code harness notes
