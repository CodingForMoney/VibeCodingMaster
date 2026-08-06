# Architecture

Project-level architecture for VibeCodingMaster (VCM). VCM is a single npm
package that provides a local GUI cockpit for running and orchestrating multiple
Claude Code role sessions around one engineering task.

This document is architect-owned. It gives the project-wide module overview,
responsibilities, relationships, dependency direction, and constraints.

## Module / Layer Overview

VCM is one workspace module (`vibe-coding-master`) organized into three source
layers plus supporting tools.

| Layer | Path | Responsibility |
| --- | --- | --- |
| Backend | `src/backend` | Fastify HTTP + WebSocket server, role/session runtime over `node-pty`, services, external adapters, mobile gateway, and the downstream harness templates. |
| Frontend | `src/frontend` | React 19 + Vite single-page GUI: task workspace, role tabs, embedded `xterm` terminals, harness/translation panels, and client state stores. |
| Shared | `src/shared` | Cross-layer TypeScript types, constants (role definitions, ports), and zod-backed validation helpers consumed by both backend and frontend. |
| Tools / scripts | `.ai/tools`, `scripts` | Generated-context generators, long-running validation wrappers, bash guard, and harness install/verify scripts. |

### Backend sub-areas (`src/backend`)

- `api/`: Fastify route modules, one per domain (project, task, session, round,
  message, harness, gate-review, translation, gateway, diagnostics, artifacts,
  runtime-state, usage analytics, app-settings, claude-hook). Routes are thin
  and delegate to services.
- `services/`: business logic. Key services include `task-service`,
  `task-launch-service` (backend-owned one-click task start, shared by the GUI
  endpoint and the gateway), `task-close-service` (backend-owned unconditional
  task close, shared by the GUI endpoint and the gateway), `session-service`, `round-service`,
  `runtime-coordinator-service`, `runtime-recovery-service`,
  `terminal-process-exit-service`, `message-service`, `task-workflow-service`,
  `architect-restart-service`,
  `artifact-service`, `harness-service`, `harness-feedback-service`,
  `auto-memory-service`,
  `gate-review-service`, `translation-service`/`translation-worker-service`,
  `ccr-integration-service`, `usage-analytics-service`, `job-guard-service`, and
  `command-dispatcher`.
- `runtime/`: PTY-backed terminal runtime (`node-pty-runtime`,
  `terminal-runtime`, `session-registry`, `terminal-submit`) that supervises one
  Claude Code process per role.
- `adapters/`: side-effect boundaries — `claude-adapter`,
  `ccr-gateway-adapter`, `git-adapter`, `command-runner`, `filesystem`.
- `gateway/`: mobile gateway service plus channel implementations
  (Weixin iLink, Lark) and command parsing; channel connection is gated by a
  runtime, default-off switch. Detailed sub-area design lives in
  [`src/backend/gateway/ARCHITECTURE.md`](../src/backend/gateway/ARCHITECTURE.md).
- `templates/`: message, handoff, role-command, and downstream harness
  templates. `templates/harness/` is the source of truth for the VCM harness
  installed into target repositories, including role agents, skills, tools, and
  project durable doc templates.
- `ws/`: WebSocket bridge (`terminal-ws`) streaming PTY I/O to the frontend.
- `server.ts`, `main.ts`, `app-version.ts`, `vcm-data-dir.ts`, `errors.ts`:
  composition root, CLI entry, version, data-dir resolution, error types.

### Frontend sub-areas (`src/frontend`)

- `routes/`: top-level views (`project-dashboard`, `task-workspace`).
- `components/`: GUI building blocks (app shell, session console/toolbar, role
  session tabs, harness panel/studio, translation panel, message timeline,
  repo connect form, diff modal, error center).
- `state/`: client stores and helpers (`app-store`, `session-store`,
  `api-client`, polling schedulers, translation feed, UI error handling).
- `terminal/`: `xterm` view and terminal websocket client.

### Shared sub-areas (`src/shared`)

- `types/`: domain type contracts shared across layers.
- `validation/`: pure validators (`artifact-check`, `language-detect`,
  `slug-check`).
- `constants.ts`: role definitions and default ports.

## Module Relationships and Dependency Direction

```
frontend  --depends on-->  shared  <--depends on--  backend
   |                                                   ^
   +-------- HTTP /api + WS /ws (api-client) ----------+
```

- `shared` is the leaf layer. It must not import from `backend` or `frontend`.
- `backend` and `frontend` both depend on `shared`, and must not depend on each
  other at the module level.
- The only runtime coupling between frontend and backend is the HTTP `/api`
  surface and the `/ws` WebSocket, mediated on the client by
  `src/frontend/state/api-client.ts` and
  `src/frontend/terminal/terminal-client.ts`.
- Within the backend, the intended direction is
  `api -> services -> (runtime | adapters | gateway | templates)`. Routes should
  not contain business logic; services should reach the outside world only
  through adapters and the runtime.

## CCR Model Integration

CCR is an optional global integration for running the existing VCM-managed
Claude Code processes against one supported GPT model. The host owns the CCR
process and account authentication. The VCM backend identifies CCR at the fixed
local endpoint `http://127.0.0.1:3456` or DevContainer endpoint
`http://host.docker.internal:3456`; the frontend never calls CCR.

`ccr-gateway-adapter` verifies the gateway identity and performs authenticated
model discovery, selecting the first valid runtime endpoint. `ccr-integration-service` owns the enabled state, volatile
connection result, shared in-flight check, short cache, safe API response, and
session-scoped child environment and settings override. The API key is
persisted only in global app settings and is used for gateway checks, model
discovery, and GPT child authentication through the helper; settings responses
expose only whether it is configured. GPT-backed children clear
inherited Anthropic credential variables and receive an isolated `apiKeyHelper`
through `--settings`. They also use the VCM-owned Claude configuration root
`~/.vcm/claude/ccr`, which keeps CCR model discovery, cache, and transcripts out
of the user's global `~/.claude` state. VCM never edits global Claude settings.
Native child processes retain normal Claude configuration and authentication;
only inherited environment variables that identify the local CCR gateway are
removed from that child.

`session-service` is the single process-launch boundary for CCR. It requests the
model environment before every Start, Resume, or Restart path and merges it into
the PTY child environment. This covers workflow roles, Reviewer,
Translator, Harness Engineer, Harness Bootstrap, and one-click launch without
separate role-specific CCR logic. `claude-adapter` omits native `--model` only
for the namespaced CCR model. Native Claude commands remain unchanged, and the
native child environment removes only inherited local-CCR takeover variables.
CCR/GPT children receive `CLAUDE_CODE_MAX_CONTEXT_TOKENS=258400`,
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=258400`, and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90`. Native Claude children receive none of
these overrides. Context-limit StopFailure
diagnostics are terminal because retrying the unchanged context cannot recover
them.
An unavailable CCR selection fails before process creation and is never
normalized or silently replaced. Session records persist the Claude
configuration root so transcript discovery and Resume use the same provider
state. Resume cannot cross between native Claude and CCR; Restart creates the
new provider Session.

## Task Usage Analytics

`session-service` enables Claude Code OpenTelemetry log export for every native
Claude role process and attaches only `vcm.role` plus a per-process launch ID.
It disables the exporter for CCR/GPT processes. Prompt, response, tool-detail,
and raw API body logging remain disabled.

Claude Code posts `api_request` events to
`POST /api/telemetry/v1/logs`. `usage-analytics-service` attributes them to the
single active task, deduplicates retried OTLP batches, and aggregates token and
estimated cost data across every launch and Claude session. It stores only the
aggregate at `<taskRepoRoot>/.ai/vcm/telemetry/usage.json`; no raw telemetry is
retained. The report returned by
`GET /api/tasks/:taskSlug/usage-analytics` contains task totals plus role and
model breakdowns. The frontend loads it only when Usage Analytics is opened or
manually refreshed. Task close removes the worktree and therefore the report.

## Project-Wide Constraints

- Single npm package, ESM only, TypeScript strict mode. Node `^20 || >=22`.
- Keep the layer boundary: no `shared -> backend/frontend` imports, no direct
  `frontend <-> backend` imports.
- Backend and frontend compile under separate tsconfigs
  (`tsconfig.node.json`, `tsconfig.json`); new files must fall inside the correct
  `include` globs, and `npm run typecheck` must pass both.
- VCM-managed downstream harness behavior is defined by
  `src/backend/templates/harness/**`. Project-owned generator behavior is
  changed in the target project's `.ai/tools/` files.
- Long-running and background process rules from the VCM managed block in
  `CLAUDE.md` apply; never detach processes.
- The npm package ships only built artifacts (`dist`, `dist-frontend`,
  `scripts`, `README.md`). `docs/` is not shipped (it holds internal
  process/design docs, not user-facing or runtime-needed content).

## Generated Context Ownership

Generated indexes under `.ai/generated/` are machine-maintained and regenerated
by project-owned tools in `.ai/tools/`. The fixed installer seeds the generators
only when missing; Bootstrap and Harness Engineer may adapt them to project
languages and conventions, and subsequent VCM updates preserve them:

- `.ai/generated/module-index.json` — produced by
  `.ai/tools/generate-module-index`. Maps the workspace to layers, modules,
  manifests, module docs, source files, and test files. Use it to locate code and
  confirm module boundaries.
- `.ai/generated/public-surface.json` — produced by
  `.ai/tools/generate-public-surface` (after `module-index.json` exists). It is the
  authoritative machine index of module-to-module public APIs, routes, and
  externally consumed surfaces. Treat it as the full public-surface listing;
  module docs explain meaning and design intent rather than duplicating it.

Regenerate both after changing module layout, public exports, or HTTP routes.

VCM ships the local `vcm-lsp-bridge` Claude Code plugin. Session Service passes
it through `--plugin-dir` and enables the LSP tool for Architect, Coder, and
Reviewer sessions on both native Claude and CCR launches. Auxiliary roles do not
load the plugin. The Claude adapter explicitly opts every role into Glob and
Grep. Architect, Coder, and Reviewer preload the `vcm-code-navigation` skill
through Agent frontmatter.

Architect, Coder, and Reviewer use LSP semantic navigation for definitions,
references, implementations, and call relationships, then Read the resolved
code. Grep and shell text search remain available for candidate files and
literal content, but text matches do not establish semantic relationships.
Unresolved project-owned relationships remain unresolved.

`code-intelligence-service` derives project languages from the active task
worktree's root manifests and `module-index.json`. It validates the bundled
plugin declaration, resolves the matching language-server executable from the
backend `PATH`, and runs a bounded version probe. Probe results are cached for
the backend process; detection does not start a persistent language server or
scan the repository recursively. A successful probe means the server is
runnable, not that a role workspace is indexed or semantically ready. Each role
Session performs a file-symbol warm-up and bounded workspace-query retry through
`vcm-code-navigation`. Harness Studio renders server availability and the exact
backend diagnostic. The project runtime, not VCM, owns installation of
`rust-analyzer`, `typescript-language-server`, `pyright-langserver`, `gopls`,
`clangd`, or `jdtls`.

## Durable Documentation Ownership

The fixed installer ships `.ai/tools/check-durable-docs`. Harness Bootstrap,
Architect Docs Sync, and Tester testing-doc updates run it after changing
durable docs. The tool detects high-confidence contract violations such as
resolved issue history, terminal plans left under `docs/plans/`, task history in
architecture/testing docs, missing module architecture docs, and generated
module-count drift.

Semantic consistency remains role-owned: Architect reconciles changed facts
across architecture docs, active plans, known issues, code, and generated
context; Tester owns `docs/TESTING.md`. Final Acceptance requires the relevant
evidence to record a passing audit after durable-doc changes.

Generated indexes own machine inventories and complete public-surface lists.
Durable prose owns current architecture, contract meaning, validation strategy,
active plans, and unresolved limitations. Git, PRs, and task handoffs own
history.

## Auto Memory Ownership

Harness Engineer owns the reviewed content of shared memory in the root
`CLAUDE.md` `<VCM-memory>` block and role memory in the matching
`.claude/agents/*.md` block. `auto-memory-service` owns collection, snapshots,
mechanical commit-boundary checks, history, and revert. The host file determines
the memory identity. The blocks live outside fixed managed blocks, so fixed
Harness refresh preserves them. Drafts, before/after snapshots, and review
history remain task runtime data under `.ai/vcm/memory-review/`.

After a normal stopped round has valid Final Acceptance, a manual or automatic
Review Task Harness request may start the Auto Memory state machine. Workflow
roles submit proposals sequentially through `vcm-propose-memory`. Once every
proposal is ready, `harness-feedback-service` starts one Task Harness
Retrospective turn. Its conditional prompt assigns the proposal paths, current
snapshot, active memory files, and planning candidate to Harness Engineer.
Role drafts use structured per-item targets, evidence, necessity, absence
impact, and durable-document disposition.
Harness Engineer performs a full sweep of the current memory snapshot before
evaluating those drafts. Every substantive existing entry receives a structured
retain, update, remove, or move-to-durable-doc decision with its reason, removal
impact, durable-document disposition, and evidence. Harness Engineer then edits
the active `<VCM-memory>` blocks directly, writes the required `Memory Review`
report block, and commits only the changed memory host files.
That block records one decision for every proposal item. Each Add or Update
decision independently explains why the memory is necessary, what would fail if
it were absent, whether the knowledge belongs in memory or a durable document,
the evidence checked, and the exact final memory content when retained. Blanket
acceptance or rejection of a role draft is invalid.
On the same successful `Stop`, `auto-memory-service` records the committed
result. It verifies only mechanical boundaries: the retrospective report
exists, memory host files have no uncommitted changes, the commit range contains
only managed memory host files, and those files changed only inside their
`<VCM-memory>` blocks. VCM does not parse Harness Engineer's semantic decisions,
apply staged output, or create the memory commit. It reads the committed active
memory, writes the after snapshot and diff, and preserves the run for user
review and revert.
Active memory blocks are read-only to role turns. Proposal prompts run through
the normal workflow-role sessions, so their `UserPromptSubmit`, `Stop`, and
`StopFailure` hooks participate in Round/Turn tracking. Sequential proposals
continue the post-acceptance Round, which settles to stopped after the last
workflow-role proposal. Harness Engineer retrospective work is tool-role
activity and is excluded from Round tracking. The frontend only displays state
and invokes memory file, retry, or revert APIs.

The planning Architect may be restarted before Final Acceptance. When Auto
Memory is enabled, `architect-restart-service` assigns one task-local planning
candidate path and refuses to replace that Session until a structurally valid
proposal exists. Restart scheduling and Gate revisions never delete or recreate
the candidate. `auto-memory-service` snapshots it into the memory review run.
The replacement Architect receives it while producing the final Architect
proposal, and Harness Engineer receives it during consolidation. The planning
candidate is never applied directly, is removed with the task worktree at Close
Task, and raw Session transcripts are not imported into memory.

Auto Memory completion is bound to the SHA-256 hash of the current accepted
`final-acceptance.md`. If that artifact changes, the next Review Task Harness
request creates a new memory phase for the new acceptance evidence.
`runtime-coordinator-service` and the manual Harness route use the same
readiness policy. When Auto Memory is disabled, Review Task Harness skips all
memory collection and updates. When enabled, pending, collecting, or failed
memory work delays retrospective analysis; `reviewing` means proposals are
ready and the retrospective may start. The retrospective reviews the proposals,
current memory snapshot, task evidence, and pending Harness Feedback in one
turn. A missing retrospective report, uncommitted memory edit, out-of-scope
commit, or edit outside a memory block prevents completion. Backend validation
does not interpret the memory review decision or judge whether a memory is
genuinely useful.

Reusable harness feedback from `vcm-report-harness-issue` is a passive inbox.
Harness Studio lets the user send one pending report to the active task's
Harness Engineer for review. Sending does not remove the report. Task Harness
Retrospective assigns every pending report, records its disposition, and removes
it only after the report contains that disposition.

Harness revision state is owned by the active task worktree. `session-service`
reads `.ai/vcm/harness/revision.json` from the same task runtime root used by
Harness status and Apply. Every task-scoped role records that revision at launch
and compares it against the same file when sessions are read or listed. Harness
refresh notification updates the task-scoped session record in the worktree;
the base repository revision and legacy project-tool session files are not used
for that comparison or persistence.

## Turn Runtime Ownership

`round-service` owns the active turn and round state. `session-service` owns role
session activity, while the PTY runtime owns Claude process liveness and terminal
output timestamps. `runtime-coordinator-service` runs full active-task
reconciliation every 10 seconds, independently of frontend polling. It
automatically starts or resumes the task-scoped Harness Engineer and starts or
resumes the task-scoped Translator when translation is enabled and the Harness
is initialized. Tool Session defaults are independent from the workflow-role
launch template. Explicit Start and Restart routes save the successful Session's
permission, model, and effort; automatic startup and Resume never write them.
Fresh tool Sessions use the saved defaults, while resumable task Sessions keep
the launch options recorded by that Session.

Round tracking includes Project Manager, Architect, Coder, Tester, and optional
Reviewer sessions. Translator and Harness Engineer are task-scoped tool
roles and are excluded. A tool workflow that prompts a workflow role still
participates in Round tracking through that workflow role's hooks.

Normal Turn completion and failure come only from Claude Stop and StopFailure
Hooks. Transcript content is display and translation evidence; it never changes
Session, Turn, or Round state. `terminal-process-exit-service` subscribes
directly to PTY process exit events. An unexpected exit marks the current
Session idle and ends its active workflow-role Round with `terminal-exit`.
Explicit Stop and Restart dispose the PTY runtime entry before the child exit
event, so they do not enter this failure path.

## Architect Planning Context Ownership

Architect Interview produces two separate task artifacts: the user-confirmed
`.ai/vcm/handoffs/architecture-brief.md` and the current-worktree
`.ai/vcm/handoffs/architecture-evidence.md`. Planning consumes those artifacts
and writes the executable `architecture-plan.md`; the architecture-plan Gate
hashes all three so changed evidence invalidates an earlier approval.

Architect delegates exact scaffold execution to one foreground
`vcm-architect-scaffold-worker` subagent configured with `model: opus` and
`effort: xhigh`. The worker has an independent context and returns before the
Architect turn continues. Architect remains responsible for reviewing the
scaffold commit, ledger reconciliation, and build evidence.

Architecture planning also owns repeated-workaround disposition. When a
proposed file-local override of a shared default, constant, or documented
contract would be the third file carrying the same mechanism, the plan must fix
the owner, confirm intentional local handling and correct its documentation, or
record the unresolved issue and affected call sites. Code-diff review enforces
the same threshold against changed hunks.

Architecture evidence and planning also preserve backward compatibility with
existing code assumptions. The evidence artifact records verified assumptions
at every existing site the plan may change and complete directly related member
sets when one member of an existing semantic class is newly handled. The plan
states each assumption's effect and every member's disposition. Architecture
review reconstructs both from current code before approval.

`architect-restart-service` owns the task-local, in-memory deferred restart
between completed planning and later Architect work. The Architect schedules it
through `.ai/tools/request-architect-restart` before writing the first completed
route to PM. Repeated requests from the same Architect Session are idempotent.
The service keeps the current session and pending restart through
architecture-plan `request_changes` rounds and starts a fresh Architect session
only after a normal Architect Stop, delivery of the latest Architect-to-PM
message, PM's matching `UserPromptSubmit` confirmation, and an approved,
disabled, not-required, skipped, or overridden architecture-plan Gate. A failed
restart prerequisite becomes a visible blocked state and is retried only by an
explicit restart request. The service preserves the selected permission, model,
and effort and launches Claude Code with a short `--append-system-prompt` that
points to the accepted brief, evidence, plan, scaffold, and latest Gate report.
It does not inject a user prompt or create an extra turn. StopFailure and task
close never execute a pending restart.

Each Gate Review request owns an immutable prompt, metadata record, captured
snapshot of every referenced `.ai/vcm` handoff or prior-Gate input, and report
under `.ai/vcm/gate-reviews/requests/`. Reviewer uses those snapshots for the
request's role-produced evidence while reading current code, tests, durable
docs, generated context, and the named commit range directly from the
worktree. After a report parses successfully, the Gate Review service atomically publishes it to the gate's stable
`<gate>-review.md` path as the latest snapshot. PM callbacks reference the
request-scoped report, while the Gate index and stable report paths remain the
current-state interface.

Gate mutation is serialized per task. A running review cannot be replaced by
retry; cancellation must name the current request ID, records that request as
cancelled, clears the active Gate, and restarts Reviewer before another request
can begin. Completion and failure use a current-request compare-and-set check.
A late result from a cancelled or superseded request remains request history
only and cannot publish the stable report, mutate the Gate index, update
architecture disposition, or call back PM.

Code-producing flows run Tester validation and validation-adequacy review
before code-diff review. The Gate Review service rejects code-diff when the
Tester report is incomplete or when a required validation-adequacy decision is
missing or stale. Code-diff input binds the committed implementation and test
range, the current test report, and the validation-adequacy report, so later
code or test changes invalidate earlier approval.

Tester reports use a strict test-infrastructure disposition:
`none|repair-required|repaired|production-change-required`. Validation review
cannot start from either unresolved status. A confined test-only defect returns
to Tester for repair, commit, defect-class sweep, and clean-state validation;
production or shared changes use the active flow's Architect failure branch.
Code-diff continues to review the complete committed range. Each code-diff
finding classifies its affected scope as `test-only` or `implementation`, so PM
can route an all-test-only correction to Tester without performing technical
analysis.

## Task Workflow State Ownership

`task-workflow-service` stores PM-declared workflow context at
`<taskRepoRoot>/.ai/vcm/workflow/state.json`. The declaration records the
current flow, step, optional branch and resume point, status, and evidence
references. It is separate from Round, Turn, Session, Gate Review, and process
state: those services remain the source of truth for observed runtime facts.

PM declarations arrive through PM route-file frontmatter or the
`update-task-state` tool. The backend writes them atomically, returns them in the
task workspace aggregate, and restores saved context into a restarted or
resumed PM session. The frontend only renders the aggregate state. Missing,
stale, malformed, or unwritable workflow state never blocks message delivery,
Gate Review, final acceptance, session launch, or task close.

## Task Close Ownership

`task-close-service` is the single owner of task shutdown for both the GUI and
Gateway. It first persists `cleanupStatus: cleaned`; that logical close releases
the project for another task. Session shutdown (including task-scoped Translator
and Harness Engineer sessions), translation and Round cleanup, forced worktree
removal, stale-directory removal, forced branch deletion, and task-state removal
then run independently as best-effort cleanup. Detection and cleanup failures are
returned as warnings and never reactivate or block the closed task.

`task-service` owns the destructive Git and filesystem operations. Task branches
are force-deleted even when they contain commits absent from the base branch; the
discarded commit list is warning evidence, not a decision gate. If worktree or
branch cleanup remains unresolved, the cleaned task record is retained as a
tombstone. `runtime-recovery-service` retries such tombstones when the project is
connected again.

## Public Surface

The authoritative machine listing of exported APIs, HTTP routes, and externally
consumed surfaces is `.ai/generated/public-surface.json`. Do not duplicate that
listing here.

Design intent of the most externally meaningful surfaces:

- **CLI**: `vcm` with `--help`, `--version`, `--host=`, `--port=`, `--dev`,
  and `--open`.
- **HTTP `/api/*`**: route modules under `src/backend/api/`; this is the
  contract consumed by the frontend and gateway.
- **`/ws`**: terminal I/O streaming contract used by the embedded terminal.
- **`src/shared/types/**`**: typed contracts shared across the HTTP boundary.
- **`src/backend/templates/harness/**`**: downstream-facing harness contract
  installed into target repositories.

## Risks

- Layer-boundary erosion: accidental `frontend <-> backend` imports or
  `shared -> backend/frontend` imports.
- `node-pty` is a native dependency; runtime/spawn changes can be platform
  sensitive.
- Harness template edits affect every downstream repo VCM installs into.
- Shared-type changes are cross-cutting and must typecheck under both frontend
  and backend tsconfigs.
- The npm package ships built artifacts (`dist`, `dist-frontend`, `scripts`,
  `README.md`); runtime-required assets must live in shipped paths.

## Update Triggers

Update this document when:

- a top-level area is added under `src/backend`, `src/frontend`, or `src/shared`;
- dependency rules or layer boundaries change;
- externally meaningful surfaces change in a way that affects consumers;
- a new external integration, gateway channel, or adapter is added.
- post-task Auto Memory or Task Harness Retrospective ownership/order changes.

After these changes, regenerate `.ai/generated/module-index.json` and
`.ai/generated/public-surface.json`.

## Sub-Area Architecture Docs

Root packages do not get a separate module-level `ARCHITECTURE.md` by default.
Create sub-area architecture docs only for clear internal boundaries whose
details would make this project-level overview too noisy.

Existing sub-area docs:

- Mobile gateway: [`src/backend/gateway/ARCHITECTURE.md`](../src/backend/gateway/ARCHITECTURE.md)
  — channel abstraction, poll/inbound/PM-push flows, settings/persistence,
  dependency direction, security model, and a correctness review.
