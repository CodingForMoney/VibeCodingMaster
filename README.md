# VibeCodingMaster

VibeCodingMaster is a local GUI workspace for managing multiple Claude Code role sessions around one engineering task.

VCM is designed for long-running coding work where one Claude Code conversation is not enough. It gives the user a task workspace with four embedded Claude Code sessions:

- `project-manager`
- `architect`
- `coder`
- `reviewer`

Each role runs as a real Claude Code process inside an embedded terminal. The GUI lets the user start, stop, resume, restart, switch, observe, and manually intervene in those sessions without juggling separate terminal windows.

When Codex Review Gates are enabled for a task, or when a Codex Reviewer session already exists, the workspace can also show a fifth `Codex Reviewer` terminal role. It runs Codex CLI from `.ai/codex` with Codex model and effort selectors, receives gate prompts in the same long-lived terminal session, reports hook state back to VCM, and stays outside the normal Claude Code PM routing flow.

## Current Capabilities

- GUI-first task workspace.
- Collapsible sidebar with repository connection, settings, harness status, task creation, and task list.
- Recent repository path dropdown, stored locally with the five most recent paths.
- Connected repository status for the base repo, including branch, upstream status, commit hash, dirty state, and fast-forward-only pull.
- Embedded Claude Code terminals powered by `node-pty` and `xterm.js`.
- One Claude Code session per role, with role tabs in the task header.
- Optional Codex Reviewer terminal role when any Codex Review Gate is enabled.
- Role session recovery through persisted Claude session ids and `claude --resume`.
- Permission mode selection before start, resume, or restart:
  - `default`
  - `bypassPermissions`
- PM-mediated role messaging through VCM-dispatched route files.
- Manual and automatic orchestration modes.
- Two-stage VCM harness setup: deterministic fixed install plus AI-assisted bootstrap.
- VCM-managed root rules, four role agents, repo-local VCM skills, Claude Code hooks, Codex Reviewer hooks, generated-context tools, and PR template.
- Rust generated context for module indexing and crate-external public surface indexing.
- Translation panel powered by an OpenAI-compatible low-cost model.
- Mobile Gateway through Tencent iLink Bot API / Weixin DM, for talking to PM and managing tasks from Weixin.
- Durable task state, session state, raw terminal logs, handoff artifacts, and message history.

## Requirements

- Node.js 20 LTS or 22+.
- npm.
- Git.
- Claude Code installed and available as `claude` in the runtime environment.
- For Linux containers, native build/runtime basics for `node-pty`, usually:

```bash
python3 make g++ git bash
```

## Install

From npm:

```bash
npm install -g vibe-coding-master
vcm --version
vcm
```

Useful CLI flags:

```bash
vcm --help
vcm --version
vcm --host=127.0.0.1 --port=4173
```

From source:

```bash
npm install
npm run dev
```

## Run Locally

Development mode:

```bash
npm run dev
```

Open the Vite GUI:

```text
http://127.0.0.1:5173/
```

The backend runs at:

```text
http://127.0.0.1:4173/
```

If `5173` is already in use, Vite may choose another frontend port and print it in the terminal.

Production-style local run:

```bash
npm run build
npm start
```

Then open:

```text
http://127.0.0.1:4173/
```

The global `vcm` command runs the production-style app and serves the GUI from the backend port:

```text
http://127.0.0.1:4173/
```

## Run In VS Code Dev Containers

VCM works inside a VS Code `devContainer` when VCM, Claude Code, and the target repository all run inside the same container filesystem.

Add port forwarding to `.devcontainer/devcontainer.json`:

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

Use the path as seen from inside the container, for example `/workspace`.

Important container notes:

- Install Claude Code inside the container, or make `claude` available in the container `PATH`.
- Make sure Claude Code authentication works inside the container.
- Make sure the container has network access to Claude services and to the translation provider if translation is enabled.
- VCM accepts normal Git repositories by checking `.git` directly. It also supports `.git` files that point to worktree gitdirs.
- VCM uses per-command `git -c safe.directory=...` for Git metadata reads and does not require global `git config --global --add safe.directory`.
- Set `VCM_SANDBOX=devcontainer` so VCM-managed Codex Reviewer sessions rely on the container boundary and do not start Codex's nested Linux sandbox.
- Treat the container as the sandbox boundary, especially when using relaxed Claude Code permission modes.

## Basic Usage

1. Start VCM.
2. Open the GUI.
3. In the sidebar, open `Repository Path`, enter a repository path or choose one from `Recent`, then click `Connect`.
4. Review `VCM Harness`; if fixed files need install/update, click `Install / Update`.
5. If bootstrap checks are incomplete, click `Run Bootstrap` and let the visible Claude Code bootstrap session fill project-specific docs and generated context.
6. Review and commit harness changes when they look right.
7. Create a task from `New Task` with a single task name.
8. Select the task from `Tasks`.
9. Use the role tabs in the task header to switch between `Project Manager`, `Architect`, `Coder`, and `Reviewer`.
10. Choose the permission mode for the active role.
11. Click `Start`, `Resume`, `Restart`, or `Stop` as needed.
12. Talk mostly to `project-manager`; let PM coordinate the other roles through VCM messaging.

The recommended flow is:

```text
project-manager
  -> architect architecture plan, Scaffold Manifest, and code scaffolding
  -> coder implementation and baseline unit checks
  -> reviewer independent validation
  -> architect docs sync / architecture drift check
  -> project-manager final acceptance, commit, and PR
```

## VCM Runtime Terminology

VCM statistics use three nested terms:

```text
Session = n x Round = m x Turn
```

- `Session`: the whole VCM task. It aggregates all statistics for that task, from task creation until the task is closed.
- `Round`: one user-facing VCM conversation cycle. It starts when a user prompt or VCM-delivered prompt is accepted, continues through automatic role orchestration, and normally ends when the final `project-manager` result has stopped and no next role turn starts inside the 10 second stop window.
- `Turn`: one role-level Claude Code conversation. A turn starts when VCM or the user submits a prompt to one role session and ends when that Claude Code process emits `Stop`.

Turns inside one Round are strictly sequential. VCM should finish one role Turn before starting the next role Turn in that Round.

Session state is intentionally small: `created` means no Round has started yet, `running` means there is a current running Round, and `stopped` means there is no current running Round after at least one Round has stopped. Starting Claude Code role sessions does not make the VCM Session `running`.

Round state is only `running` or `stopped`. After a `Stop` hook, the 10 second stop window still counts as `running`; the Round becomes `stopped` only when the timer expires without another `UserPromptSubmit`.

In this terminology, `Session` is a VCM statistics term. It is different from a Claude Code role session. VCM still runs one Claude Code role session per role, but the sidebar task statistics treat the task itself as the VCM Session.

## Task Worktree Management

VCM uses task-level worktree management by default:

```text
one task = one branch + one git worktree + one handoff directory + one role-session set
```

The `Create worktree and branch` option is selected by default when creating a task:

- task name: `<task>`
- branch: `feature/<task>`
- worktree path: `.claude/worktrees/<task>` inside the connected base repository
- role session cwd: that task worktree

VCM will not create worktrees per role. `project-manager`, `architect`, `coder`, and `reviewer` for the same task share the same task worktree.

The user can turn this option off. In that mode, VCM creates app-local task metadata, creates the handoff structure in the connected repository, records the current branch, and starts role sessions from the connected repository path.

VCM will not offer a separate `Create task worktree` button after a task exists, and a task should not be switched to another branch/worktree mode after creation.

Because worktrees live under `.claude/worktrees/`, the connected repository must ignore both `.ai/vcm/` and `.claude/worktrees/`. Apply the VCM Harness before creating tasks so `.gitignore` contains the managed ignore block. The base repository must also be clean because the task branch/worktree is created from the connected repo's current `HEAD`.

When a task is complete, VCM provides a red `Close Task` action. Closing a task shows a destructive confirmation, stops VCM-managed running role sessions for that task, then deletes the task worktree, deletes the task branch by default, removes the app-local task record, and removes task runtime metadata. VCM does not preflight running sessions or uncommitted changes before closing. Tasks created without a worktree only remove VCM metadata because they do not own a separate branch/worktree.

## Sidebar UI

The left sidebar is intentionally compact and collapsible:

- `Repository Path`: path input on one row; `Recent` and `Connect` on the next row.
- `Connected Repository`: connected base repo path, branch, upstream/ahead-behind status, commit hash, working tree state, and a `Pull` button.
- `Settings`: `Theme`, `Flow pause alert`, `Try alert`, `Messages`, and `Events`.
- `Gateway`: Weixin iLink binding, Gateway on/off, Gateway translation, and QR login.
- `VCM Harness`: fixed-install status, bootstrap completion checks, and the bootstrap terminal when one is running.
- `New Task`: one `task name` input.
- `Tasks`: task list and task status.

All sidebar sections are collapsed by default. When no task is selected, `Repository Path` opens by default. The sidebar behaves as a single-open accordion: opening one section closes the previously open section, and clicking the open section collapses it.

Opening `Connected Repository` refreshes the base repo status through the
backend. VCM does not poll it continuously. The `Pull` button runs
`git pull --ff-only` against the connected base repo only. It is disabled when
the base repo has uncommitted changes, when the current branch has no upstream,
or when the active task is an inline task using the base repo directly. It does
not stash, merge, or mutate task worktrees.

When VCM is connected to an active task, the bottom of the sidebar shows a task status dock. It stays outside the collapsible groups and shows the active VCM Session title, task status, start time, total elapsed time, total Round count, and role active runtime. If a Round is currently running, the dock also shows the Current Round start time, total elapsed time, role active runtime, and Turn count.

## Mobile Gateway

VCM Gateway lets one Weixin DM identity bind to one desktop VCM instance. It is a mobile control surface for the current desktop VCM, not a remote terminal and not a group-chat bot.

Gateway rules:

- DM only; group chat is not supported.
- One phone identity binds to one desktop VCM instance.
- The phone can manage projects and tasks available to that desktop VCM instance.
- When the desktop UI has an active task selected, Gateway uses that task automatically.
- After binding, VCM keeps a lightweight Gateway connection for `/start` and read-only commands even when the `Gateway` toggle is off.
- VCM caches the latest PM reply for each task locally, so `/start` can immediately return the current task's latest PM status when available.
- Plain text messages go only to the current task's `project-manager`.
- Gateway never sends directly to `architect`, `coder`, or `reviewer`.
- Gateway credentials and audit logs stay in local app state, not in connected repositories.

Gateway state is stored locally under:

```text
<vcmDataDir>/gateway/settings.json
<vcmDataDir>/gateway/audit.jsonl
```

### Bind Weixin

1. Start VCM and open the GUI.
2. Open the sidebar `Gateway` section.
3. Click `Start QR Login`.
4. VCM opens a global `Weixin Gateway Login` dialog with a QR code.
5. Scan the QR code with Weixin and confirm login on the phone.
6. Click `Confirm` in the dialog.
7. After binding succeeds, close the dialog and turn `Gateway` on in the sidebar.

`Start QR Login` is shown only when Gateway is not bound. It creates a new Tencent iLink QR login session and opens the QR dialog. The dialog `Confirm` button asks iLink whether the QR code has been scanned and confirmed. After binding succeeds, the sidebar shows `Reset Binding` instead of `Start QR Login`.

The `Gateway` toggle is disabled until a QR login has produced a usable iLink token. After binding, VCM keeps receiving `/help`, `/start`, `/status`, `/projects`, and `/tasks` even when the toggle is off. Turning `Gateway` on, either from desktop or by sending `/start`, enables PM messages, task-changing commands, and PM reply push. `Reset Binding` clears the stored token and bound Weixin identity so the desktop VCM can bind again.

When Gateway is turned on, VCM automatically turns off the browser `Flow pause alert` and disables `Try alert`. Gateway becomes the notification path, so the browser should not show blocking flow-pause dialogs while the user is managing the task from Weixin.

### Translation

The Gateway section has its own `Translation` toggle.

When Gateway translation is on:

- Chinese Weixin input is translated to English before being submitted to PM.
- The prompt sent to PM includes only the translated English text with a `[VCM Gateway]` marker.
- The original Chinese text is not included in the PM prompt.
- PM replies are translated back to Chinese before VCM sends them to Weixin.
- If PM reply translation fails or times out, VCM sends a translation failure notice instead of the English source. The user can send `/retry` to retry the latest failed Gateway output translation.

When Gateway translation is off, plain Weixin text is sent to PM as-is.

### Commands

After Gateway is bound, send commands in the bound Weixin DM.

When `Gateway` is off, only these commands are accepted:

```text
/help
/start
/status
/projects
/tasks
```

When `Gateway` is on, the full command set is accepted:

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

Plain text that does not start with `/` is sent as a message to the current task's PM session only when `Gateway` is on.

In normal use, VCM runs one project and one task at a time. If the desktop UI has a task selected, turning Gateway on syncs that project/task into Gateway automatically. `/status` also refreshes this context, so the phone usually does not need to run `/tasks` and `/use-task` before sending a PM message.

Typical mobile flow:

```text
/projects
/use-project 1
/pull-current
/create-task mobile-demo "Implement mobile gateway smoke test"
/status
继续推进这个任务，先让 PM 安排下一步。
/close-task
/close-task confirm mobile-demo
```

### Command Behavior

- `/status`: shows Gateway, binding, translation, current project, current task, and last poll status.
- `/status` also adopts the current desktop project/task when one is selected.
- `/start`: turns Gateway on from the bound Weixin DM so full mobile task operations and PM messages are allowed. If the current task has a cached latest PM reply, `/start` includes it in the response.
- `/retry`: retries the latest failed Gateway output translation in the current VCM process.
- `/projects`: lists the current/recent repositories known by the desktop VCM.
- `/use-project <index-or-path>`: selects the Gateway's current project context.
- `/pull-current`: runs the same fast-forward-only connected repository pull as the desktop `Pull` button.
- `/tasks`: lists tasks for the selected project.
- `/use-task <index-or-task-slug>`: selects the Gateway's current task context.
- `/create-task <task-slug> [title]`: creates a worktree-backed task and starts the four role sessions using the saved launch template.
- `/close-task`: starts a destructive close confirmation for the current task.
- `/close-task confirm <task-slug>`: closes the task through VCM cleanup after exact slug confirmation.
- `/translate on` and `/translate off`: changes Gateway translation for mobile messages.

`/pull-current` only pulls the connected base repository. It does not pull task worktrees, stash local changes, merge divergent branches, or run arbitrary shell commands.

`/create-task` uses the saved launch template from the desktop settings. The template controls permission mode, model, effort, auto orchestration, and translation defaults for the four role sessions.

`/close-task` is destructive. It stops VCM-managed role sessions and removes task-owned worktree/branch state according to the same cleanup behavior as the desktop `Close Task` action.

### Troubleshooting

- If the QR dialog does not appear, refresh the page and click `Start QR Login` again.
- If the QR status stays `wait`, confirm the login on the phone and click `Confirm` again.
- If the QR code expires, start a new QR login.
- If `Gateway` cannot be enabled, bind Weixin first.
- If `/start` or read-only commands do not receive replies, check that the iLink token has not expired and the Weixin DM is the bound identity.
- If PM messages or task-changing commands are rejected, check that Gateway is on.
- If plain text cannot be sent to PM, select a project and task first, and make sure the task's PM session is running and idle.
- If PM replies are not pushed, check that Gateway is on and the PM session is producing normal Claude transcript output.
- If PM reply translation fails, send `/retry` from the bound Weixin DM. Retry state is memory-only and is cleared when VCM restarts.

## Translation

The task header has a global `Translate` button next to `Close Task`. It opens a translation panel beside the embedded terminal for the role consoles and keeps the same on/off setting while switching roles. The terminal and translation panel split the available width evenly.

The task header does not include a manual `Refresh` button. Task status, role status, messages, orchestration state, and flow pause state refresh automatically. The remaining `Refresh` button lives only in the sidebar `VCM Harness` section and is for rechecking harness files.

Translation settings are local and stored in:

```text
<vcmDataDir>/settings.json
```

The same file stores recent repository paths. The translation API key is stored locally under `translation.secrets.apiKey`; it is not written to the connected repository, `.ai/vcm/handoffs`, raw terminal logs, or git diffs.

VCM resolves `vcmDataDir` from `VCM_DATA_DIR`. If `VCM_DATA_DIR` is unset or empty, VCM uses `~/.vcm`. In Dev Containers, set `VCM_DATA_DIR=/workspace/.ai/vcm` and `VCM_SANDBOX=devcontainer` through `containerEnv` so VCM app state survives container rebuilds and VCM-managed Codex Reviewer sessions do not run a nested Codex sandbox.

The sidebar `Settings` section also stores the UI theme preference in this file. The default is `system`, which follows the OS/browser color-scheme preference; users can cycle between `System`, `Light`, and `Dark`.

The same sidebar also has a `Flow pause alert` toggle. It is on by default and controls the local alert that fires when VCM detects that the current role flow has stopped advancing. Short flows use a weak reminder: the soft two-note chime plays 3 times, 1.4 seconds apart. Flows lasting 2 minutes or longer use a strong reminder: VCM shows an alert dialog and repeats the chime until the user confirms it. The alert sound reuses one browser audio context so repeated reminders remain reliable in stricter browsers such as Safari. Safari users may still need to manually set `Safari > Website Settings > Auto-Play > Allow All Auto-Play`; Chrome is recommended for the most reliable alert sound behavior. The `Try alert` button always triggers the strong reminder for testing.

When Gateway is on, `Flow pause alert` is forced off because mobile notifications are delivered through Weixin and browser alerts can block normal workflow progress.

Translation behavior:

- Provider type is OpenAI-compatible chat completions.
- Prompt slots are `zh-to-en`, `zh-to-en-with-context`, and `en-to-zh`.
- The settings modal shows all three prompt slots as direct editors and includes `Reset prompts` to restore the built-in defaults.
- Claude Code output translation reads semantic Claude transcript JSONL files under `~/.claude/projects`, not raw PTY output.
- VCM tails those transcript files in the backend. Closing the translation panel does not stop capture; the tailer stops only when the role session is stopped/restarted or the task is closed.
- Translation events are cached under the task runtime repo at `.ai/vcm/translation/<task>/<role>/<session-id>.jsonl` and delivered to the frontend through HTTP polling.
- The polling cursor is the next expected seq: `after=18` acknowledges seq `1..17` and returns seq `18+`; there is no snapshot mismatch error.
- The translation panel retains the most recent 500 entries per role session in frontend/backend memory. Older entries are pruned from the live panel state and event cache to keep long sessions responsive.
- When new translation events arrive, the active translation panel automatically scrolls to the bottom so the latest output, retry result, or conversation boundary is visible.
- Failed output translations are tracked in a backend failure list. When failures exist, the panel shows `Ignore N` and `Retry N`; retry reuses the original entry id so the failed row is replaced by the normal translating/translated flow. If an old failed entry is pruned by the 500-entry cap, its failure-list item is removed too.
- Assistant prose is shown as English source while translating, then replaced by the translated Chinese result.
- Assistant prose renders Markdown in the panel, including headings, lists, code fences, tables, and links.
- Tool calls and tool results are preserved as dim one-line rows such as `● Bash({"command":"npm test"})`.
- User input uses one textarea. Press `Enter` to translate or send the current English draft; press `Shift+Enter` for a newline.
- After user input is translated, the English draft replaces the original text in the same textarea.
- `Send English` writes the current English draft to the active embedded terminal and submits it.
- Automatic terminal submission uses bracketed paste first, then sends Enter separately for Claude Code TUI reliability.
- The translation panel `Auto-send` toggle sends the translated draft automatically when translation succeeds without warnings.

## Project Harness

VCM works best when the connected repository contains VCM collaboration rules as normal project files. Harness setup has two stages.

Fixed install is deterministic. It installs or updates VCM-owned files and managed blocks:

```text
CLAUDE.md
.gitignore
.claude/settings.json
.claude/agents/project-manager.md
.claude/agents/architect.md
.claude/agents/coder.md
.claude/agents/reviewer.md
.claude/skills/vcm-route-message/SKILL.md
.claude/skills/vcm-final-acceptance/SKILL.md
.claude/skills/vcm-long-running-validation/SKILL.md
.claude/skills/vcm-harness-bootstrap/SKILL.md
.ai/vcm-harness-manifest.json
.ai/tools/generate-module-index
.ai/tools/generate-public-surface
.ai/tools/run-long-check
.ai/tools/watch-job
.ai/tools/vcm-bash-guard
.github/pull_request_template.md
```

Repo-local skills are installed as `.claude/skills/<skill-name>/SKILL.md` so
Claude Code can register them.

VCM roles must not run background Bash. A `PreToolUse` hook
(`.ai/tools/vcm-bash-guard`) denies `run_in_background`, `nohup`, `setsid`,
`disown`, and trailing `&` calls in VCM role sessions. The only sanctioned
long-running mechanism is `.ai/tools/run-long-check` plus
`.ai/tools/watch-job` through `vcm-long-running-validation`:

- The detached job worker itself enforces the job ceiling (`--timeout`, max 60
  minutes) and a supervision lease: a job left without a live foreground
  watcher for about 2 minutes is killed and recorded as `orphaned`.
- `watch-job` renews the lease and watches in windows of up to 8 minutes; it
  exits `125` while the job is still running instead of killing it, and the
  role re-runs it in the same turn until a terminal result.
- The VCM backend blocks a role from ending its turn while one of its
  validation jobs is still running.
- Only one validation job may be active at a time.

If a managed-block file already exists, VCM preserves user-authored content and only inserts or replaces the VCM block:

```md
<!-- VCM:BEGIN version=1 -->
VCM-managed rules live here.
<!-- VCM:END -->
```

For `.gitignore`, VCM uses a gitignore-native managed block:

```gitignore
# VCM:BEGIN version=1
.ai/vcm/
.claude/worktrees/
# VCM:END
```

`.ai/vcm/` is the active VCM local control area, and `.claude/worktrees/` is the Claude-compatible task worktree area. VCM keeps the task index in app-local project state under `<vcmDataDir>/projects/`; each task runtime repo keeps its own session, message, orchestration, and translation state.

VCM also JSON-merges `.claude/settings.json` to install Claude Code `PreToolUse`, `UserPromptSubmit`, `Stop`, and `PermissionRequest` hooks plus a managed `env.BASH_DEFAULT_TIMEOUT_MS` so foreground watch windows fit inside the Bash tool timeout. The hooks post directly to the local VCM backend, so roles do not need a VCM CLI command to confirm delivery or report turn completion. The `Stop` hook forwards the backend response to Claude Code, which lets VCM block turn-end while a validation job is still running. When Codex Review Gates are installed, VCM also writes `.ai/codex/.codex/config.toml` and `.ai/codex/.codex/hooks.json` so the embedded Codex Reviewer terminal can POST `UserPromptSubmit` and `Stop` events back to VCM.

Bootstrap is AI-assisted. VCM starts a visible temporary Claude Code session in the connected repository and asks it to use the `vcm-harness-bootstrap` skill. Bootstrap fills project-specific content and generated context:

```text
CLAUDE.md project context outside the VCM managed block
docs/ARCHITECTURE.md
<module>/ARCHITECTURE.md
docs/TESTING.md
.ai/generated/module-index.json
.ai/generated/public-surface.json
```

The generated-context tools currently target Rust projects. Non-Rust repositories can still install the fixed harness, but generated context should be treated as unsupported until project-specific generators exist.

After applying harness changes or completing bootstrap, VCM reports the exact files changed or checks completed and reminds the user to review and commit them before starting long-running work.

Role sessions learn VCM rules from `CLAUDE.md` and `.claude/agents/*.md`. VCM does not paste a long context block into the terminal at session start.

## Message Bus

The message bus is file-driven and dispatched by VCM after Claude Code turn completion. Roles do not call a VCM CLI to send messages.

Role communication works like this:

```text
Claude Code role
  -> writes or updates .ai/vcm/handoffs/messages/<from-role>-<to-role>.md
  -> ends the Claude Code turn
  -> Stop hook calls VCM backend directly
  -> VCM scans pending route files
  -> VCM validates and dispatches at most one pending route file
  -> VCM records dispatchingAt and the GUI switches to the target role
  -> VCM snapshots only actually delivered message history
  -> UserPromptSubmit hook records acceptedAt and clears the matching route file
```

Examples:

```text
.ai/vcm/handoffs/messages/project-manager-coder.md
.ai/vcm/handoffs/messages/coder-project-manager.md
.ai/vcm/handoffs/messages/project-manager-reviewer.md
```

Runtime message and handoff files:

```text
.ai/vcm/messages/<task>.jsonl                 # under the task runtime repo
.ai/vcm/orchestration/<task>.json             # under the task runtime repo
.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
.ai/vcm/handoffs/logs/
```

Each directed role route has exactly one message file. Route messages are the only dynamic task-dispatch files. If a role changes its mind during one turn, it edits the same route file instead of creating another message. A blank file means no pending message; a non-empty file means pending work for VCM to submit.

## Orchestration Modes

VCM has a task-level `Auto orchestration` switch in the role console toolbar. New tasks default to auto orchestration.

When it is off, VCM is in manual mode:

- Roles may write pending route files under `.ai/vcm/handoffs/messages/`.
- Messages appear in the `Messages` modal.
- The user can inspect them.
- The current GUI shows newest message history first with stable increasing sequence numbers, timestamp, body preview, path, `Copy`, `Mark All Done`, and `Delete All`.
- `Mark All Done` clears non-empty pending route files after the user manually copied or handled stuck handoff content.
- `Delete All` removes message history from the Messages modal without touching pending route files.
- The user decides what to do next by copying or manually acting on the message.
- VCM does not write to the target terminal or press Enter for the user.

When it is on, VCM is in auto mode:

- Backend policy still applies.
- Roles write pending route files under `.ai/vcm/handoffs/messages/`.
- On Claude Code `Stop`, VCM scans pending route files.
- If the target role session is running and idle, VCM writes a `[VCM MESSAGE]` envelope to the target terminal and submits it.
- Just before terminal submission, VCM records `dispatchingAt`, waits briefly for the GUI to switch tabs, then writes to the embedded terminal.
- After successful terminal write, VCM snapshots the delivered body as message history.
- Claude Code `UserPromptSubmit` confirms that the prompt was accepted; VCM stores `acceptedAt` and clears the source route file if it still contains the same message.
- If `UserPromptSubmit` does not confirm the auto-delivered message, VCM retries Enter from the backend PTY and finally records `failureReason` on the message if submission is still not confirmed.
- When the GUI observes a newly dispatching auto message, it switches the active role tab to that message's target role before the message is submitted.
- VCM enforces sequential turn-taking from hook state: a role that has accepted a prompt is busy until its `Stop` hook fires.
- Additional pending files to a busy target role remain non-empty and are not written to that terminal.
- When the target role later reaches `Stop`, VCM scans again and may deliver the next pending route file.
- If auto orchestration gets stuck after a manual copy/paste recovery, `Mark All Done` clears pending route files. It does not mutate message history.

VCM Harness injects Claude Code `UserPromptSubmit` and `Stop` hooks into `.claude/settings.json`, and Codex Reviewer hooks into `.ai/codex/.codex/hooks.json`. Role tabs become `running` when Claude Code or Codex accepts a prompt and `idle` after `Stop`; VCM also marks a role `running` immediately after it writes a message to that embedded terminal. The terminal process status is still tracked separately. Claude role rules require a role to end its turn after writing or updating a message route file, rather than polling, looping, or waiting for another role inside the same Claude Code turn; Codex Reviewer does not dispatch route files.

The implementation keeps only the active manual/auto orchestration mode. It does not expose pause/resume, stage/approve/reject, or a separate agent-facing message CLI.

## Flow Pause Alerts

VCM detects flow pauses from Claude Code hook events, not PTY silence, message history, or pending route files. `UserPromptSubmit` starts a new Round when there is no current running Round, or continues the current Round when it fires within the 10 second stop window.

When a `Stop` hook fires, VCM ends the current Turn and starts a 10 second timer. During that timer, the Round is still `running`. If another `UserPromptSubmit` fires inside that window, the same Round continues and VCM increments the Turn count. If no new prompt is accepted before the deadline, VCM marks the Round as `stopped`.

The normal path is timer-driven: `Stop` starts a backend timer, and `UserPromptSubmit` cancels it.

When `Flow pause alert` is enabled, the frontend polls the task Round state and deduplicates each stopped Round so the same stopped state does not alert on every poll. Flow duration is measured from the first `UserPromptSubmit` to `stoppedAt`, falling back to the last `Stop` when needed. If the flow lasted less than 2 minutes, it plays the local chime 3 times at 1.4 second intervals. If the flow lasted 2 minutes or longer, it shows a modal alert and repeats the local chime until the user clicks `Confirm`. A stopped Round can mean normal completion, user decision needed, dispatch failure, or another workflow interruption; the point is to get the user to look with the right amount of urgency.

The Current Round dock separates wall-clock Round duration from role active runtime. `Total` is `now - Round.startedAt`; `Role runtime` is only the accumulated time between each Turn's `UserPromptSubmit` and `Stop`; `Turn count` is the number of accepted prompts inside the current Round.

## Resume Behavior

Each role session stores its Claude session id and transcript path under:

```text
.ai/vcm/sessions/<task>.json                  # under the task runtime repo
```

Session buttons behave as follows:

- `Start`: creates a fresh UUID, builds `claude --agent <role> --session-id <uuid>`, and stores the transcript path.
- `Resume`: reuses the persisted Claude session id and builds `claude --agent <role> --resume <uuid>`.
- `Restart`: stops the current process if needed, creates a new UUID, and starts a fresh Claude session.
- `Stop`: stops the embedded terminal process and leaves the persisted Claude session id resumable.

Embedded terminal output is still written to raw role log files under `.ai/vcm/handoffs/logs/`. When a browser reconnects to a running terminal, VCM replays only the tail of that log, capped at 2 MB, rather than streaming the entire historical log back into xterm. This keeps long sessions responsive while preserving full logs on disk until task cleanup.

## Local Project Files

For a connected repository, VCM uses:

```text
<vcmDataDir>/projects/<project-id>/config.json
<vcmDataDir>/projects/<project-id>/tasks/<task>.json
<baseRepoRoot>/.claude/worktrees/<task>/
<taskRepoRoot>/.ai/vcm/sessions/<task>.json
<taskRepoRoot>/.ai/vcm/messages/<task>.jsonl
<taskRepoRoot>/.ai/vcm/orchestration/<task>.json
<taskRepoRoot>/.ai/vcm/translation/<task>/
<taskRepoRoot>/.ai/vcm/handoffs/architecture-plan.md
<taskRepoRoot>/.ai/vcm/handoffs/known-issues.md
<taskRepoRoot>/.ai/vcm/handoffs/review-report.md
<taskRepoRoot>/.ai/vcm/handoffs/docs-sync-report.md
<taskRepoRoot>/.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
<taskRepoRoot>/.ai/vcm/handoffs/logs/{project-manager,architect,coder,reviewer}.log
```

The project config is stored under `vcmDataDir` so it is durable local app state. `vcmDataDir` is `VCM_DATA_DIR` when set, otherwise `~/.vcm`. For Dev Containers, prefer:

```json
{
  "containerEnv": {
    "VCM_DATA_DIR": "/workspace/.ai/vcm"
  }
}
```

For worktree-backed tasks, `taskRepoRoot` is `<baseRepoRoot>/.claude/worktrees/<task>`; for inline tasks, `taskRepoRoot` is the connected base repo.

Because handoffs are scoped to `taskRepoRoot` without an extra task-name directory, VCM allows only one active inline task per connected repository. Use the default worktree mode for parallel tasks.

## Packaging

The npm package publishes built output, not raw TypeScript entry files. `package.json` includes:

- `bin.vcm`: `dist/main.js`
- `files`: `dist`, `dist-frontend`, `docs`, `scripts`, `README.md`
- `prepack`: `npm run build && npm run verify:package`

Use this before publishing:

```bash
npm run typecheck
npm test
npm run build
npm run verify:package
```

## Validation

```bash
npm run typecheck
npm test
npm run build
```

## Current Boundaries

- VCM does not use tmux.
- VCM does not auto-confirm Claude Code permission prompts.
- VCM does not isolate roles with separate worktrees; roles for one task share one task worktree.
- VCM does not translate Claude output from raw PTY output; translation reads Claude transcript JSONL files.
- VCM does not write translation output into handoff artifacts unless a user or role explicitly copies it there.
- Role file writes happen in the task worktree when a task has a worktree.
- The safest sandbox today is a container or VM boundary controlled by the user.

See also:

- `docs/product-design.md`
- `docs/v0.2-implementation-plan.md`
- `docs/vcm-cc-best-practices.md`
- `docs/full-harness-baseline.md`
- `docs/cc-best-practices.md` is archived and no longer maintained.
