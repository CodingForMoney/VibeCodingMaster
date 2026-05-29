# VibeCodingMaster

VibeCodingMaster is a local GUI workspace for managing multiple Claude Code role sessions around one engineering task.

It is designed for long-running coding work where one Claude Code conversation is not enough. VCM gives the user a task workspace with four role sessions:

- `project-manager`
- `architect`
- `coder`
- `reviewer`

Each role runs as a real Claude Code process inside an embedded terminal. The GUI lets the user start, stop, resume, switch, inspect, and manually intervene in those sessions without juggling several terminal windows.

## What It Does

```text
Open local GUI
  -> connect a Git repository
  -> create a task
  -> start Claude Code role sessions
  -> talk to Claude Code through embedded terminals
  -> let project-manager coordinate architect / coder / reviewer
  -> approve or automate role-to-role messages
  -> resume interrupted role sessions later
```

Current V1 capabilities:

- GUI-first task workspace.
- Embedded Claude Code terminals powered by `node-pty`.
- One Claude Code session per role.
- Role session recovery with persisted Claude session ids and `claude --resume`.
- Permission mode selection before start/restart:
  - default
  - `bypassPermissions`
  - `--dangerously-skip-permissions`
- PM-mediated role messaging through `vcmctl`.
- Manual and automatic orchestration modes.
- Durable task state, session state, raw logs, handoff artifacts, and message history.

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
```

Then start the packaged app:

```bash
vcm
```

The published package also installs `vcmctl`, which Claude Code role sessions use internally for VCM message bus commands.

From source:

```bash
npm install
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

If installed globally from npm, `vcm` runs the production-style app and serves the GUI from the backend port:

```text
http://127.0.0.1:4173/
```

## Run In VS Code Dev Containers

VCM works well inside a VS Code `devContainer` as long as VCM, Claude Code, and the target repository are all inside the same container filesystem.

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

Use:

```bash
npm install
npm run dev
```

Open the forwarded `5173` port for development mode. If you run `npm run build && npm start`, only `4173` is required.

Important container notes:

- Install Claude Code inside the container, or make the `claude` command available in the container PATH.
- Make sure Claude Code authentication works inside the container.
- Make sure the container has network access to Claude services.
- Keep the user project, `.vcm`, and `.ai/handoffs` on the same mounted workspace so paths are consistent.
- Treat the container as the sandbox boundary, especially when using relaxed Claude Code permission modes.

## Basic Usage

1. Start VCM.
2. Open the GUI.
3. Connect a Git repository.
4. Create a task.
5. Select a role tab.
6. Choose the Claude Code permission mode for that role.
7. Click `Start`.
8. Talk to `project-manager` first.
9. Let PM delegate to `architect`, `coder`, or `reviewer`.
10. Inspect and approve role messages in the `Messages` panel.

The recommended flow is to mostly talk to `project-manager`. The PM role should coordinate the other roles through VCM messaging instead of asking the user to copy prompts between terminals.

## Message Bus

The message bus is API-driven. VCM does not watch files to trigger role messages.

Role communication works like this:

```text
Claude Code role
  -> runs vcmctl send / vcmctl reply
  -> vcmctl calls VCM backend API
  -> backend validates policy and persists the message
  -> backend writes to the target embedded terminal when allowed
```

Examples that roles can run inside their terminal:

```bash
vcmctl send --to coder --type task --body-file /tmp/message.md
vcmctl reply --type blocked --body "Need clarification."
vcmctl result --body-file /tmp/result.md --artifact .ai/handoffs/task/implementation-log.md
vcmctl inbox
```

Files are still used for durability and auditability:

```text
.vcm/messages/<task>.jsonl
.vcm/orchestration/<task>.json
.ai/handoffs/<task>/messages/<message-id>.md
.ai/handoffs/<task>/role-commands/
.ai/handoffs/<task>/logs/
```

## Orchestration Modes

VCM has a task-level `Auto orchestration` switch.

When it is off, VCM is in manual mode:

- Roles may send messages through `vcmctl`.
- Messages appear in the GUI.
- The user can inspect them.
- Clicking `Stage` writes the message prompt into the target embedded terminal input line.
- VCM does not press Enter for the user.

When it is on, VCM is in auto mode:

- Backend policy still applies.
- PM can send work to `architect`, `coder`, or `reviewer`.
- Non-PM roles can reply only to `project-manager`.
- If the target role session is running and orchestration is not paused, VCM can deliver the message directly to the target terminal.

High-risk work should still stop for human review.

## Resume Behavior

Each role session stores a Claude session id under `.vcm/sessions`. If VCM exits or a task is interrupted, reopen the task and use `Resume` for the role. VCM starts Claude Code with `claude --resume <session-id>` where supported by Claude Code.

## Validation

```bash
npm run typecheck
npm test
npm run build
```

## Current Boundaries

- VCM does not use tmux.
- VCM does not auto-confirm Claude Code permission prompts.
- VCM does not deeply parse Claude Code output.
- VCM does not isolate roles with separate worktrees in V1.
- File writes still happen in the connected repository environment.
- The safest sandbox today is a container or VM boundary controlled by the user.

See also:

- `docs/product-design.md`
- `docs/v1-architecture-design.md`
- `docs/v1-implementation-plan.md`
- `docs/v1-message-bus-orchestration-design.md`
