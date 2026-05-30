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
- Collapsible sidebar with repository connection, workflow, settings, harness status, task creation, and task list.
- Recent repository path dropdown, stored locally with the five most recent paths.
- Embedded Claude Code terminals powered by `node-pty` and `xterm.js`.
- One Claude Code session per role, with role tabs in the task header.
- Role session recovery through persisted Claude session ids and `claude --resume`.
- Permission mode selection before start, resume, or restart:
  - `default`
  - `bypassPermissions`
  - `--dangerously-skip-permissions`
- PM-mediated role messaging through `vcmctl`.
- Manual and automatic orchestration modes.
- VCM harness installer for `CLAUDE.md` and `.claude/agents/*.md`.
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

The package also installs `vcmctl`, which Claude Code role sessions use internally to send VCM messages.

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

The workflow status is shown in the sidebar `Workflow` section. It is a soft guide in V1: VCM highlights missing or incomplete handoff artifacts and suggests the next step, but it does not hard-block the user from manually starting or switching roles.

## Sidebar UI

The left sidebar is intentionally compact and collapsible:

- `Repository Path`: path input on one row; `Recent` and `Connect` on the next row.
- `Repository`: connected path, branch, and working tree state. `Working tree: uncommitted changes` means `git status --porcelain` is not empty.
- `Workflow`: current soft gate and five workflow steps.
- `Settings`: `Messages`, `Events`, and the `Auto orchestration` on/off toggle.
- `VCM Harness`: status for `CLAUDE.md` and role agent files.
- `New Task`: one `task name` input.
- `Tasks`: task list and task status.

All sidebar sections are collapsed by default. When no task is selected, `Repository Path` opens by default.

## Translation

The `Translate` button in the role toolbar opens a translation panel beside the embedded terminal. The terminal and translation panel split the available width evenly.

Translation settings are local and stored in:

```text
~/.vcm/settings.json
```

The same file stores recent repository paths. The translation API key is stored locally under `translation.secrets.apiKey`; it is not written to the connected repository, `.ai/handoffs`, raw terminal logs, or git diffs.

Translation behavior:

- Provider type is OpenAI-compatible chat completions.
- Prompt slots are `zh-to-en`, `zh-to-en-with-context`, and `en-to-zh`.
- The settings modal shows default prompts and allows per-slot overrides.
- Claude Code output translation reads semantic Claude transcript JSONL files under `~/.claude/projects`, not raw PTY output.
- Assistant prose is shown as English source while translating, then replaced by the translated Chinese result.
- Tool calls and tool results are preserved as dim one-line rows such as `● Bash({"command":"npm test"})`.
- User input uses one textarea. Press `Enter` to translate or send the current English draft; press `Shift+Enter` for a newline.
- After user input is translated, the English draft replaces the original text in the same textarea.
- `Send English` writes the current English draft to the active embedded terminal and submits it.
- The translation panel `Auto-send` toggle sends the translated draft automatically when translation succeeds without warnings.

## Project Harness

VCM works best when the connected repository contains VCM collaboration rules as normal project files. On first connect, VCM checks:

```text
CLAUDE.md
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

After applying harness changes, VCM reports the exact files changed and reminds the user to review and commit them before starting long-running work.

Role sessions learn VCM rules from `CLAUDE.md` and `.claude/agents/*.md`. VCM does not paste a long context block into the terminal at session start.

## Message Bus

The message bus is API-driven. VCM does not watch files to trigger role messages.

Role communication works like this:

```text
Claude Code role
  -> runs vcmctl send / vcmctl reply / vcmctl result
  -> vcmctl calls VCM backend API
  -> backend validates message policy and persists the message
  -> backend writes to the target embedded terminal when allowed
```

Examples that roles can run inside their terminal:

```bash
vcmctl send --to coder --type task --body-file /tmp/message.md
vcmctl reply --type blocked --body "Need clarification."
vcmctl result --body-file /tmp/result.md --artifact .ai/handoffs/task/implementation-log.md
vcmctl inbox
```

Durable message and handoff files:

```text
.vcm/messages/<task>.jsonl
.vcm/orchestration/<task>.json
.ai/handoffs/<task>/messages/<message-id>.md
.ai/handoffs/<task>/role-commands/
.ai/handoffs/<task>/logs/
```

The backend also keeps a compatibility role-command dispatch endpoint, but the primary workflow is PM-mediated `vcmctl` messaging.

## Orchestration Modes

VCM has a task-level `Auto orchestration` switch in the sidebar `Settings` section.

When it is off, VCM is in manual mode:

- Roles may send messages through `vcmctl`.
- Messages appear in the `Messages` modal.
- The user can inspect them.
- Clicking `Stage` writes a prompt into the target embedded terminal input line.
- VCM does not press Enter for the user.

When it is on, VCM is in auto mode:

- Backend policy still applies.
- PM can send work to `architect`, `coder`, or `reviewer`.
- Non-PM roles can reply only to `project-manager`.
- If the target role session is running, VCM writes a `[VCM MESSAGE]` envelope to the target terminal and submits it.

The backend state model still contains a `paused` field for compatibility with existing API routes, but the current GUI exposes only a single on/off orchestration toggle.

## Resume Behavior

Each role session stores its Claude session id and transcript path under:

```text
.vcm/sessions/<task>.json
```

Session buttons behave as follows:

- `Start`: creates a fresh UUID, builds `claude --agent <role> --session-id <uuid>`, and stores the transcript path.
- `Resume`: reuses the persisted Claude session id and builds `claude --agent <role> --resume <uuid>`.
- `Restart`: stops the current process if needed, creates a new UUID, and starts a fresh Claude session.
- `Stop`: stops the embedded terminal process and leaves the persisted Claude session id resumable.

## Local Project Files

For a connected repository, VCM uses:

```text
.vcm/config.json
.vcm/tasks/<task>.json
.vcm/sessions/<task>.json
.vcm/messages/<task>.jsonl
.vcm/orchestration/<task>.json
.ai/handoffs/<task>/architecture-plan.md
.ai/handoffs/<task>/implementation-log.md
.ai/handoffs/<task>/validation-log.md
.ai/handoffs/<task>/review-report.md
.ai/handoffs/<task>/docs-sync-report.md
.ai/handoffs/<task>/role-commands/{architect,coder,reviewer}.md
.ai/handoffs/<task>/logs/{project-manager,architect,coder,reviewer}.log
```

## Packaging

The npm package publishes built output, not raw TypeScript entry files. `package.json` includes:

- `bin.vcm`: `dist/main.js`
- `bin.vcmctl`: `dist/cli/vcmctl.js`
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
- File writes still happen in the connected repository environment.
- The safest sandbox today is a container or VM boundary controlled by the user.

See also:

- `docs/product-design.md`
- `docs/v1-architecture-design.md`
- `docs/v1-implementation-plan.md`
- `docs/cc-best-practices.md`
