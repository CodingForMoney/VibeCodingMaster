# VibeCodingMaster

VibeCodingMaster is a local GUI workspace for managing multiple Claude Code role sessions around one engineering task.

VCM is designed for long-running coding work where one Claude Code conversation is not enough. It gives the user a task workspace with four embedded Claude Code sessions:

- `project-manager`
- `architect`
- `coder`
- `reviewer`

Each role runs as a real Claude Code process inside an embedded terminal. The GUI lets the user start, stop, resume, restart, switch, observe, and manually intervene in those sessions without juggling separate terminal windows.

## Current V1 Capabilities

- GUI-first task workspace.
- Collapsible sidebar with repository connection, settings, harness status, task creation, and task list.
- Recent repository path dropdown, stored locally with the five most recent paths.
- Embedded Claude Code terminals powered by `node-pty` and `xterm.js`.
- One Claude Code session per role, with role tabs in the task header.
- Role session recovery through persisted Claude session ids and `claude --resume`.
- Permission mode selection before start, resume, or restart:
  - `default`
  - `bypassPermissions`
  - `--dangerously-skip-permissions`
- PM-mediated role messaging through VCM-dispatched route files.
- Manual and automatic orchestration modes.
- VCM harness installer for `CLAUDE.md`, `.claude/agents/*.md`, and the VCM-managed `.gitignore` block.
- Translation panel powered by an OpenAI-compatible low-cost model.
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
vcm
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
- Treat the container as the sandbox boundary, especially when using relaxed Claude Code permission modes.

## Basic Usage

1. Start VCM.
2. Open the GUI.
3. In the sidebar, open `Repository Path`, enter a repository path or choose one from `Recent`, then click `Connect`.
4. Review `VCM Harness`; if files need install/update, click `Install / Update`.
5. Review any changed harness files and commit them if they look right.
6. Create a task from `New Task` with a single task name.
7. Select the task from `Tasks`.
8. Use the role tabs in the task header to switch between `Project Manager`, `Architect`, `Coder`, and `Reviewer`.
9. Choose the permission mode for the active role.
10. Click `Start`, `Resume`, `Restart`, or `Stop` as needed.
11. Talk mostly to `project-manager`; let PM coordinate the other roles through VCM messaging.

The recommended flow is:

```text
project-manager
  -> architect architecture plan
  -> coder implementation and validation
  -> reviewer independent review
  -> architect docs sync / architecture drift check
  -> project-manager final acceptance, commit, and PR
```

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
- `Repository`: connected path, branch, and working tree state. `Working tree: uncommitted changes` means `git status --porcelain` is not empty.
- `Settings`: `Theme`, `Round alert`, `Try alert`, `Messages`, and `Events`.
- `VCM Harness`: status for `CLAUDE.md`, role agent files, and `.gitignore`.
- `New Task`: one `task name` input.
- `Tasks`: task list and task status.

All sidebar sections are collapsed by default. When no task is selected, `Repository Path` opens by default.

## Translation

The task header has a global `Translate` button next to `Close Task`. It opens a translation panel beside the embedded terminal for the role consoles and keeps the same on/off setting while switching roles. The terminal and translation panel split the available width evenly.

The task header does not include a manual `Refresh` button. Task status, role status, messages, orchestration state, and round completion state refresh automatically. The remaining `Refresh` button lives only in the sidebar `VCM Harness` section and is for rechecking harness files.

Translation settings are local and stored in:

```text
~/.vcm/settings.json
```

The same file stores recent repository paths. The translation API key is stored locally under `translation.secrets.apiKey`; it is not written to the connected repository, `.ai/vcm/handoffs`, raw terminal logs, or git diffs.

The sidebar `Settings` section also stores the UI theme preference in this file. The default is `system`, which follows the OS/browser color-scheme preference; users can cycle between `System`, `Light`, and `Dark`.

The same sidebar also has a `Round alert` toggle. It is on by default and controls the in-app prompt plus a soft two-note completion chime that fires when VCM detects that the current full conversation round is complete. The `Try alert` button triggers the same local prompt and sound for testing.

Translation behavior:

- Provider type is OpenAI-compatible chat completions.
- Prompt slots are `zh-to-en`, `zh-to-en-with-context`, and `en-to-zh`.
- The settings modal shows all three prompt slots as direct editors and includes `Reset prompts` to restore the built-in defaults.
- Claude Code output translation reads semantic Claude transcript JSONL files under `~/.claude/projects`, not raw PTY output.
- VCM tails those transcript files in the backend. Closing the translation panel does not stop capture; the tailer stops only when the role session is stopped/restarted or the task is closed.
- Translation events are cached under the task runtime repo at `.ai/vcm/translation/<task>/<role>/<session-id>.jsonl` and delivered to the frontend through HTTP polling.
- The polling cursor is the next expected seq: `after=18` acknowledges seq `1..17` and returns seq `18+`; there is no snapshot mismatch error.
- Assistant prose is shown as English source while translating, then replaced by the translated Chinese result.
- Assistant prose renders Markdown in the panel, including headings, lists, code fences, tables, and links.
- Tool calls and tool results are preserved as dim one-line rows such as `● Bash({"command":"npm test"})`.
- User input uses one textarea. Press `Enter` to translate or send the current English draft; press `Shift+Enter` for a newline.
- After user input is translated, the English draft replaces the original text in the same textarea.
- `Send English` writes the current English draft to the active embedded terminal and submits it.
- Automatic terminal submission uses bracketed paste first, then sends Enter separately for Claude Code TUI reliability.
- The translation panel `Auto-send` toggle sends the translated draft automatically when translation succeeds without warnings.

## Project Harness

VCM works best when the connected repository contains VCM collaboration rules as normal project files. On first connect, VCM checks:

```text
CLAUDE.md
.gitignore
.claude/agents/project-manager.md
.claude/agents/architect.md
.claude/agents/coder.md
.claude/agents/reviewer.md
```

If a file is missing, VCM can create a recommended default. If a file already exists, VCM preserves user-authored content and only inserts or replaces a managed block:

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

`.ai/vcm/` is the active VCM local control area, and `.claude/worktrees/` is the Claude-compatible task worktree area. VCM keeps the task index in app-local project state under `~/.vcm/projects/`; each task runtime repo keeps its own session, message, orchestration, and translation state.

VCM also JSON-merges `.claude/settings.json` to install Claude Code `UserPromptSubmit` and `Stop` hooks. The hooks post directly to the local VCM backend, so roles do not need a VCM CLI command to confirm delivery or report turn completion.

After applying harness changes, VCM reports the exact files changed and reminds the user to review and commit them before starting long-running work.

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

VCM has a task-level `Auto orchestration` switch in the role console toolbar.

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
- When the GUI observes a newly dispatching auto message, it switches the active role tab to that message's target role before the message is submitted.
- VCM enforces sequential turn-taking from hook state: a role that has accepted a prompt is busy until its `Stop` hook fires.
- Additional pending files to a busy target role remain non-empty and are not written to that terminal.
- When the target role later reaches `Stop`, VCM scans again and may deliver the next pending route file.
- If auto orchestration gets stuck after a manual copy/paste recovery, `Mark All Done` clears pending route files. It does not mutate message history.

VCM Harness injects Claude Code `UserPromptSubmit` and `Stop` hooks into `.claude/settings.json`. Role tabs become `running` when Claude Code accepts a prompt and `idle` after `Stop`; VCM also marks a role `running` immediately after it writes a message to that embedded terminal. The terminal process status is still tracked separately. The injected role rules require a role to end its turn after writing or updating a message route file, rather than polling, looping, or waiting for another role inside the same Claude Code turn.

The implementation keeps only the active manual/auto orchestration mode. It does not expose pause/resume, stage/approve/reject, or a separate agent-facing message CLI.

## Round Completion Alerts

VCM detects conversation completion from hook-driven role activity state, not PTY silence or message history. `UserPromptSubmit` marks a role `running`, and `Stop` marks that role `idle` with a stop timestamp.

For role chains, VCM waits for the final role to reach hook `Stop`. For example, if PM sends work to Coder and Coder sends a result back to PM, the round is not complete when Coder finishes; it is complete only after PM reaches `Stop` for the final response. Pending route files block completion because more dispatch work is waiting; message history does not define completion.

When `Round alert` is enabled, the frontend polls the task round state, deduplicates each completion id, shows a small `Round complete` prompt, and plays the local completion chime.

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

## Local Project Files

For a connected repository, VCM uses:

```text
~/.vcm/projects/<project-id>/config.json
~/.vcm/projects/<project-id>/tasks/<task>.json
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

The project config is stored under `~/.vcm` so it is durable local app state and is not hidden inside a Git-ignored repository directory. For worktree-backed tasks, `taskRepoRoot` is `<baseRepoRoot>/.claude/worktrees/<task>`; for inline tasks, `taskRepoRoot` is the connected base repo.

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
- VCM does not isolate roles with separate worktrees in V1.
- VCM does not translate Claude output from raw PTY output; translation reads Claude transcript JSONL files.
- VCM does not write translation output into handoff artifacts unless a user or role explicitly copies it there.
- Role file writes happen in the task worktree when a task has a worktree.
- The safest sandbox today is a container or VM boundary controlled by the user.

See also:

- `docs/product-design.md`
- `docs/v1-architecture-design.md`
- `docs/v1-implementation-plan.md`
- `docs/cc-best-practices.md`
