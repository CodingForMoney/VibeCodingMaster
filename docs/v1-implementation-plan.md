# V1 Implementation Plan And File Map

Last updated: 2026-06-02

This document is the current implementation map for VCM V1.

## 1. Current Status

V1 is implemented as a local GUI app with:

- Fastify backend.
- React frontend.
- `node-pty` embedded terminals.
- `xterm.js` terminal rendering.
- Four Claude Code role sessions.
- VCM harness installer.
- File-driven route-file message bus dispatched by VCM from Claude Code `Stop` hooks.
- Translation panel based on Claude transcript JSONL tailing.
- npm packaging with built `dist` and `dist-frontend` output.
- Task creation creates one `feature/<task>` branch and one `.claude/worktrees/<task>` git worktree by default; users may clear `Create worktree and branch` to create an inline task in the connected repository/current branch. Because handoffs are scoped as `.ai/vcm/handoffs/` under the task runtime repo, only one active inline task is allowed per connected repository.

## 2. Package And Build

File:

- `package.json`

Current package facts:

- package name: `vibe-coding-master`
- current version: `0.0.14`
- type: ESM
- `bin.vcm`: `dist/main.js`
- published files: `dist`, `dist-frontend`, `docs`, `scripts`, `README.md`

Scripts:

- `clean`: remove build output.
- `fix:node-pty`: fix packaged `node-pty` spawn helper.
- `postinstall`: run `fix:node-pty`.
- `verify:package`: verify required package files.
- `prepack`: run build and package verification.
- `dev`: start backend plus Vite dev server.
- `build`: clean, compile Node TypeScript, build frontend.
- `start`: run built backend.
- `typecheck`: TypeScript no-emit checks for browser and Node configs.
- `test`: Vitest.
- `e2e`: Playwright.

Packaging guard:

- `scripts/verify-package.mjs`

It verifies required files, shebangs, packaged static path behavior, and frontend built assets.

## 3. Source Tree

```text
src/
  main.ts
  shared/
    constants.ts
    types/
    validation/
  backend/
    server.ts
    adapters/
    api/
    runtime/
    services/
    templates/
    ws/
  frontend/
    app.tsx
    main.tsx
    routes/
    components/
    state/
    terminal/
    styles.css
```

Removed/obsolete files that must not be documented as active:

- `src/shared/validation/translation-classifier.ts`
- `src/frontend/state/translation-store.ts`
- `src/frontend/components/translation-entry-row.tsx`
- `src/frontend/state/task-store.ts`

## 4. Entry Points

### `src/main.ts`

Exports:

- `MainOptions`
- `parseMainArgs(argv): MainOptions`
- `main(argv): Promise<void>`

Responsibilities:

- parse `--dev`, `--open`, `--host=`, `--port=`
- start backend on port `4173` by default
- start Vite on port `5173` in dev mode
- serve `dist-frontend` through backend in production mode
- close backend/Vite on `SIGINT`

### Removed CLI Surface

The target design removes `vcmctl` completely. Role sessions must not call a VCM CLI to send messages or hook events.

Remove:

- `src/cli/vcmctl.ts`
- `bin.vcmctl` from `package.json`
- packaged `dist/cli/vcmctl.js`
- `VCM_CTL_COMMAND` session environment
- harness rules that mention `vcmctl`

Role sessions still receive enough environment for direct hook POSTs and backend-aware terminal delivery:

- `VCM_API_URL`
- `VCM_TASK_SLUG`
- `VCM_ROLE`
- `VCM_SESSION_ID`

## 5. Shared Layer

### `src/shared/constants.ts`

Exports:

- `DEFAULT_BACKEND_PORT`
- `DEFAULT_FRONTEND_PORT`
- `ROLE_DEFINITIONS`
- `ROLE_NAMES`
- `DISPATCHABLE_ROLES`
- `isRoleName(value)`
- `isDispatchableRole(value)`
- `getRoleDefinition(role)`

Roles:

- `project-manager`
- `architect`
- `coder`
- `reviewer`

Dispatchable roles:

- `architect`
- `coder`
- `reviewer`

### `src/shared/types/role.ts`

Defines:

- `RoleName`
- `DispatchableRole`
- `RoleStatus`
- `RoleDefinition`

### `src/shared/types/project.ts`

Defines:

- `ProjectConfig`
- `ProjectSummary`
- `ConnectProjectRequest`

Important fields:

- `handoffRoot`
- `stateRoot`
- `terminalBackend`
- `claudeCommand`
- `isDirty`

### `src/shared/types/app-settings.ts`

Defines:

- `ThemeMode`
- `AppPreferences`
- `UpdateAppPreferencesRequest`

Theme modes:

- `system`
- `light`
- `dark`

Preferences:

- `themeMode`
- `roundCompletionAlerts`, default `true`

### `src/shared/types/task.ts`

Defines:

- `TaskStatus`
- `TaskRecord`
- `CreateTaskRequest`

Current UI sends `taskSlug` and `createWorktree`; the API type still permits optional `title` and `specPath`.

Worktree fields:

- `worktreePath?: string`
- `branch: feature/<taskSlug>` when worktree creation is selected, otherwise the connected repo's current branch
- `cleanupStatus?: "active" | "cleaned"`
- `cleanedAt?: string`

`CreateTaskRequest` supports `createWorktree?: boolean`. It creates a worktree and branch by default, and skips both when `createWorktree === false`. Inline creation rejects a second active inline task in the same connected repository.

### `src/shared/types/session.ts`

Defines:

- `ClaudePermissionMode`
- `RoleSessionRecord`
- `TaskSessionRecord`
- `RoleSessionPointer`
- `StartRoleSessionRequest`

`RoleSessionRecord` includes `claudeSessionId` and `transcriptPath`, which are required for resume and translation transcript lookup.

### `src/shared/types/message.ts`

Defines:

- `VcmMessageActor`
- `VcmMessageType`
- `VcmOrchestrationMode`
- `VcmRoleMessage`
- `VcmOrchestrationState`
- `VcmRouteFile`
- `VcmRouteFileDispatchResult`

The state type should only expose the current manual/auto mode. Remove compatibility-only paused state when deleting `vcmctl`.

### `src/shared/types/round.ts`

Defines:

- `VcmRoleTurnStatus`
- `VcmTaskRoundStatus`
- `VcmRoleTurnState`
- `VcmTaskRoundState`

Round state is task-level. It reports the latest active/completed role, pending route-file count, and a stable `completionId` for frontend notification dedupe.

### `src/shared/types/translation.ts`

Defines:

- `TranslationProviderType`
- `TranslationDirection`
- `TranslationInputMode`
- `TranslationPromptKey`
- `TRANSLATION_PROMPT_KEYS`
- `TranslationSourceKind`
- `TranslationStatus`
- `TranslationSettings`
- `TranslationSecretSettings`
- `TranslationEntry`
- `TranslateUserInputRequest`
- `TranslateUserInputResult`
- `SendTranslatedInputRequest`
- `TranslationProviderTestResult`
- `TranslationPromptPreview`
- `TranslationSessionStatus`
- `TranslationSessionEvent`
- `StartTranslationSessionResult`
- `PollTranslationSessionResult`

Prompt keys:

- `zh-to-en`
- `zh-to-en-with-context`
- `en-to-zh`

Source kinds:

- `prose`
- `tool-output`

Statuses:

- `queued`
- `translating`
- `translated`
- `failed`
- `preserved`

### `src/shared/types/api.ts`

Defines:

- `ApiErrorResponse`
- `TaskStatusReport`
- `DispatchRoleCommandResult`
- `BootstrapState`

### `src/shared/types/artifact.ts`

Defines:

- `ArtifactKind`
- `HandoffPaths`
- `ArtifactCheckResult`
- `ArtifactSummary`

Artifact kinds:

- `architecture-plan`
- `implementation-log`
- `validation-log`
- `review-report`
- `docs-sync-report`

### `src/shared/types/harness.ts`

Defines:

- `HarnessFileKind`
- `HarnessFileAction`
- `HarnessFileStatus`
- `HarnessPlannedChange`
- `HarnessStatusReport`
- `HarnessApplyResult`

### `src/shared/types/terminal.ts`

Defines:

- `ClientTerminalMessage`
- `ServerTerminalMessage`
- `TerminalEvent`

### `src/shared/validation/slug-check.ts`

Exports:

- `validateTaskSlug(taskSlug)`
- `assertValidTaskSlug(taskSlug)`

Current rule:

- lowercase slug-style task names
- safe for local paths and URLs

### `src/shared/validation/artifact-check.ts`

Exports:

- `checkMarkdownArtifact(kind, path, content)`

Current checks are title/placeholder oriented and do not judge semantic quality.

### `src/shared/validation/language-detect.ts`

Exports:

- `cjkRatio(value)`
- `isProbablyCjk(value, threshold)`
- `shouldSkipForTargetLanguage(value, targetLanguage)`

These helpers remain available, but current Claude-output translation no longer uses a classifier to skip assistant prose.

## 6. Backend Adapters

### `src/backend/adapters/filesystem.ts`

Exports:

- `FileSystemAdapter`
- `EnsureFileOptions`
- `createNodeFileSystemAdapter()`
- `resolveRepoPath(repoRoot, repoRelativePath)`
- `toRepoRelativePath(repoRoot, absolutePath)`

Used by all services that touch repo/app files.

### `src/backend/adapters/command-runner.ts`

Exports:

- `CommandResult`
- `CommandRunner`
- `CommandRunnerOptions`
- `createCommandRunner()`

Used by Git and Claude adapters.

### `src/backend/adapters/git-adapter.ts`

Exports:

- `GitRepoCheck`
- `GitAdapter`
- `createGitAdapter(runner)`

Important behavior:

- checks `.git` directly
- accepts normal `.git` directories
- accepts `.git` pointer files
- passes per-command `safe.directory`

Worktree methods:

- `branchExists(repoRoot, branch): Promise<boolean>`
- `createWorktree(input): Promise<void>`
- `removeWorktree(repoRoot, worktreePath, options): Promise<void>`
- `deleteBranch(repoRoot, branch, options): Promise<void>`
- `getStatusPorcelain(repoRoot): Promise<string>`
- `isIgnored(repoRoot, repoRelativePath): Promise<boolean>`

Required safety:

- all Git commands keep command-scoped `safe.directory`
- `TaskService` verifies Close Task worktree paths are under `<baseRepoRoot>/.claude/worktrees/`
- VCM-created task branches are derived from validated task slugs as `feature/<taskSlug>`

### `src/backend/adapters/claude-adapter.ts`

Exports:

- `ClaudeAdapter`
- `createClaudeAdapter(runner)`

Builds role commands:

```text
claude --agent <role> --session-id <uuid>
claude --agent <role> --resume <uuid>
```

Adds permission flags for `bypassPermissions` and `dangerously-skip-permissions`.

### `src/backend/adapters/translation-provider.ts`

Exports:

- `TranslationProviderRequest`
- `TranslationProviderResult`
- `TranslationProvider`
- `TranslationProviderError`
- `createOpenAiCompatibleTranslationProvider(fetchImpl)`
- `buildChatCompletionsUrl(baseUrl)`
- `parseOpenAiUsage(raw)`

Implements OpenAI-compatible chat completions.

## 7. Backend Runtime

### `src/backend/runtime/terminal-runtime.ts`

Defines the runtime interface:

- `CreateTerminalSessionInput`
- `TerminalSession`
- `TerminalEventListener`
- `Unsubscribe`
- `SubscribeTerminalOptions`
- `TerminalRuntime`

### `src/backend/runtime/node-pty-runtime.ts`

Exports:

- `NodePtyRuntimeDeps`
- `createNodePtyTerminalRuntime(deps)`
- `buildPtyEnvironment(baseEnv, inputEnv)`

Responsibilities:

- spawn Claude Code with `node-pty`
- append raw output to role log file
- emit terminal output/input/exit events
- replay logs on subscribe
- handle writes, resize, stop
- set color-friendly terminal env vars

### `src/backend/runtime/session-registry.ts`

Exports:

- `SessionRegistry`
- `createSessionRegistry()`

In-memory index for live/persisted role records by runtime session id and role.

## 8. Backend Services

### `src/backend/services/project-service.ts`

Exports:

- `ProjectService`
- `ProjectServiceDeps`
- `createProjectService(deps)`
- `buildDefaultProjectConfig(repoRoot)`

Responsibilities:

- connect repo
- store current project in process memory
- record recent repo paths in app settings
- create `~/.vcm/projects/<project-id>/config.json`
- ensure base state directories
- ensure `.ai/vcm/` and `.claude/worktrees/` are ignored by Git before task-worktree creation
- expose base repo as the project control root

Repository connect should keep connecting to the base repo. Task worktrees are managed under that base repo and should not be treated as separate projects in the normal task list.

### `src/backend/services/task-service.ts`

Exports:

- `TaskService`
- `TaskServiceDeps`
- `createTaskService(deps)`

Responsibilities:

- create task
- list tasks
- load task
- save task
- update task status
- create task branch and worktree
- clean up completed task worktree and task metadata

Task files:

```text
<baseRepoRoot>/.ai/vcm/tasks/<task>.json
```

Create flow:

```text
createTask(baseRepoRoot, { taskSlug })
  -> assertValidTaskSlug(taskSlug)
  -> assert .ai/vcm/ is ignored
  -> if createWorktree is not false:
       -> assert .claude/worktrees/ is ignored
       -> branch = feature/<taskSlug>
       -> worktreePath = <baseRepoRoot>/.claude/worktrees/<taskSlug>
       -> assert base repo has no uncommitted changes
       -> assert branch does not exist
       -> assert worktree path does not exist
       -> git.createWorktree({ baseRepoRoot, branch, worktreePath, baseRef: HEAD })
       -> taskRepoRoot = worktreePath
	  -> otherwise:
	       -> branch = current base repo branch
	       -> worktreePath = undefined
	       -> taskRepoRoot = baseRepoRoot
	       -> reject if another inline task is already active
  -> artifactService.ensureHandoffStructure({ repoRoot: taskRepoRoot, handoffDir })
  -> artifactService.createArtifactTemplates({ repoRoot: taskRepoRoot, handoffDir })
  -> ensure task runtime state dirs under <taskRepoRoot>/.ai/vcm/
  -> write central task record under <baseRepoRoot>/.ai/vcm/tasks/<task>.json
```

Close Task flow:

```text
cleanupTask(baseRepoRoot, taskSlug, options)
  -> load central task record
  -> route layer lists role sessions
  -> route layer stops each VCM-managed role session with status running
  -> route layer stops translation tailers and clears task translation cache
  -> if worktreePath exists, verify it is under <baseRepoRoot>/.claude/worktrees/
  -> if worktreePath exists, git.removeWorktree(baseRepoRoot, worktreePath, force=true)
  -> if worktreePath exists, git.deleteBranch(baseRepoRoot, task.branch, force=true) by default
	  -> delete <baseRepoRoot>/.ai/vcm/tasks/<task>.json
	  -> delete <taskRepoRoot>/.ai/vcm/handoffs/
  -> delete <taskRepoRoot>/.ai/vcm/sessions/<task>.json
  -> delete <taskRepoRoot>/.ai/vcm/messages/<task>.jsonl
  -> delete <taskRepoRoot>/.ai/vcm/orchestration/<task>.json
  -> delete <taskRepoRoot>/.ai/vcm/translation/<task>/
```

The UI labels this operation `Close Task`, styles it as a red destructive action, and shows a browser confirmation that names running role-session shutdown, the worktree, branch, and metadata that will be deleted. VCM actively stops VCM-managed running role sessions, but it does not preflight running sessions or uncommitted changes before closing. Tasks created without a worktree remove VCM metadata only.

### `src/backend/services/artifact-service.ts`

Exports:

- `ArtifactService`
- input interfaces for handoff, artifacts, role commands, logs
- `createArtifactService(fs)`

Responsibilities:

- compute handoff paths
- create handoff directory structure
- create artifact templates
- list artifact checks
- read artifacts
- read/save role commands
- append role logs

In task-worktree mode, artifact paths are still repo-relative, but `repoRoot` must be the task worktree path, not the base repo path.

Primary role command path:

```text
.ai/vcm/handoffs/role-commands/<role>.md
```

Legacy fallback:

```text
.ai/vcm/handoffs/role-commands/<role>-command.md
```

### `src/backend/services/status-service.ts`

Exports:

- `StatusService`
- `StatusServiceDeps`
- `createStatusService(deps)`

Responsibilities:

- assemble `TaskStatusReport`
- list sessions
- list artifact checks
- emit missing/incomplete artifact warnings

### `src/backend/services/session-service.ts`

Exports:

- `SessionService`
- `SessionServiceDeps`
- `createSessionService(deps)`

Responsibilities:

- start role session
- resume role session
- restart role session
- stop role session
- get role session
- list role sessions

Persistence:

```text
<taskRepoRoot>/.ai/vcm/sessions/<task>.json
```

Environment passed to Claude Code:

- `VCM_API_URL`
- `VCM_CTL_COMMAND`
- `VCM_TASK_SLUG`
- `VCM_ROLE`

In task-worktree mode:

- session cwd is `task.worktreePath`
- session persistence is written under `task.worktreePath/.ai/vcm/sessions`
- raw logs and handoff artifacts are written under the task worktree

### `src/backend/services/message-service.ts`

Exports:

- `MessageService`
- `ScanPendingRouteFilesInput`
- `DispatchPendingRouteFileInput`
- `RouteFileRecord`
- `createMessageService(deps)`

Responsibilities:

- list messages
- scan route-file outboxes after Claude Code `Stop`
- snapshot pending route-file messages
- mark all open messages done for manual recovery
- get/update orchestration state
- enforce message policy
- enforce per-target-role hook-driven busy/idle delivery
- leave non-empty route files pending when a target role is busy, unavailable, or terminal submission fails
- deliver the next pending route file when a target role becomes idle
- persist message snapshots
- archive dispatched route-file bodies before clearing source files
- submit route-file messages to the target terminal

In task-worktree mode:

- message snapshots live under `task.worktreePath/.ai/vcm/messages`
- orchestration state lives under `task.worktreePath/.ai/vcm/orchestration`
- pending route files live under `task.worktreePath/.ai/vcm/handoffs/messages`
- terminal delivery uses the runtime session for the role, whose cwd is the task worktree
- message mutations are serialized per task inside the VCM process to avoid concurrent dispatch and confirmation races

Route-file protocol:

- route file name is `<from-role>-<to-role>.md`
- the filename is the authoritative route; frontmatter cannot override `from` or `to`
- blank or whitespace-only files are ignored
- non-empty files are pending
- each directed route has exactly one pending file, so repeated sends by the same role to the same target become edits to the same file
- VCM scans after every `Stop` hook
- Stop hook handling is the only code path allowed to trigger automatic route-file dispatch; do not expose a frontend or public API scan/dispatch endpoint.
- VCM scans the stopped role's outgoing files and pending files targeting newly idle roles
- VCM delivers at most one route file per target role per scan
- if several files target the same idle role, choose oldest modified time, then route name
- before terminal write, store a `dispatchingAt` snapshot and wait briefly so the GUI can switch to the target role tab
- successful terminal write snapshots the delivered body as message history
- `UserPromptSubmit` confirms Claude Code accepted the prompt, stores `acceptedAt`, then clears the source route file if it still contains that same message
- failed, blocked, manual, or unavailable delivery leaves the source route file unchanged
- `markAllDone` may clear pending route files only after user confirmation; it does not mutate message history
- `deleteMessageHistory` rewrites the latest message snapshot file to remove all message history; it must not clear pending route files

Required service functions:

- `listMessages(taskSlug): Promise<VcmRoleMessage[]>`
- `listPendingRouteFiles(repoRoot, taskSlug): Promise<RouteFileRecord[]>`
- `scanAndDispatchPendingRouteFiles(input: { repoRoot: string; taskSlug: string; stoppedRole: RoleName }): Promise<void>`
- `readRouteFile(path): Promise<RouteFileRecord | null>`
- `dispatchPendingRouteFile(record): Promise<VcmRouteFileDispatchResult>`
- `appendMessageSnapshot(message): Promise<void>`
- `clearRouteFile(path): Promise<void>`
- `markAllDone(taskSlug, options): Promise<MarkAllMessagesDoneResult>`
- `deleteMessageHistory(taskSlug): Promise<DeleteMessageHistoryResult>`

`dispatchPendingRouteFile` must snapshot before clearing. Clearing means truncating the route file to an empty string, not deleting it.

### `src/backend/services/claude-hook-service.ts`

Exports:

- `ClaudeHookService`
- `createClaudeHookService(deps)`

Responsibilities:

- accept Claude Code `UserPromptSubmit` and `Stop` hook events directly over HTTP
- map hook events to the current VCM project, task, role, and persisted Claude session id
- update `RoleSessionRecord.activityStatus`: `UserPromptSubmit -> running`, `Stop -> idle`
- call `MessageService.confirmPromptSubmitted` when `UserPromptSubmit` includes a VCM message envelope
- call `MessageService.scanAndDispatchPendingRouteFiles` after recording the stop event
- never require `vcmctl hook-event`

### `src/backend/services/command-dispatcher.ts`

Exports:

- `CommandDispatcher`
- `DispatchRoleCommandInput`
- `CommandDispatcherDeps`
- `createCommandDispatcher(deps)`

Backend compatibility role-command dispatch path. The current GUI does not expose it as a primary action, and V1 orchestration does not rely on it. Preferred orchestration is `MessageService` scanning `.ai/vcm/handoffs/messages/<from-role>-<to-role>.md` after `Stop`.

### `src/backend/services/harness-service.ts`

Exports:

- `HarnessService`
- `HarnessServiceDeps`
- `VCM_HARNESS_VERSION`
- `createHarnessService(deps)`

Responsibilities:

- inspect harness files
- manage `.gitignore` entries for VCM local state
- plan create/insert/update/ok
- apply VCM managed blocks
- preserve user content outside managed blocks

### `src/backend/services/app-settings-service.ts`

Exports:

- `StoredTranslationConfig`
- `AppSettingsFile`
- `AppSettingsService`
- `AppSettingsServiceDeps`
- `createAppSettingsService(deps)`

Settings responsibilities:

- persist UI theme mode: `system`, `light`, or `dark`
- persist translation settings and translation secrets
- persist up to five recent repository paths

Storage:

```text
~/.vcm/settings.json
```

### `src/backend/services/translation-prompts.ts`

Exports:

- `TranslationPromptInput`
- `BuiltTranslationPrompt`
- `buildTranslationPrompt(input)`
- `getTranslationPromptKey(input)`
- `getBaseTranslationPrompt(key, settings)`
- `resolveTranslationSystemPrompt(key, settings)`
- `getTranslationPromptPreviews(settings)`

Owns default prompts and user overrides.

### `src/backend/services/translation-queue.ts`

Exports:

- `SerialTranslationQueue`
- `TranslationQueueRegistry`
- `createSerialTranslationQueue()`
- `createTranslationQueueRegistry()`

Ensures translations for one session run serially.

### `src/backend/services/claude-transcript-service.ts`

Exports:

- transcript event types
- `ClaudeTranscriptService`
- `TranscriptTail`
- `createClaudeTranscriptService()`
- `resolveExistingClaudeTranscriptPath(session)`
- `findClaudeTranscriptPathBySessionId(claudeSessionId)`
- `claudeProjectsRoot()`
- `projectHash(projectDir)`
- `projectsTranscriptDir(projectDir)`
- `claudeTranscriptPath(projectDir, claudeSessionId)`
- `parseAssistantContent(line)`

Responsibilities:

- tail Claude JSONL transcript files
- resolve transcript path after start/resume/restart
- parse assistant messages, tool uses, tool results, questions, todos, and agent calls

### `src/backend/services/translation-service.ts`

Exports:

- `TranslationService`
- `TranslateUserInputServiceInput`
- `SendTranslatedInputServiceInput`
- `TranslationEventListener`
- `TranslationServiceDeps`
- `createTranslationService(deps)`

Responsibilities:

- load/update translation settings
- expose prompt previews
- test provider
- start backend transcript listening for a role session
- poll cached translation events by cursor
- translate user input
- send English text to active terminal
- clear session entries and cached events
- stop session/task translation listeners
- retry failed output translation
- subscribe to Claude transcript service
- translate prose output and preserve tool output

Terminal submission is delegated to `src/backend/runtime/terminal-submit.ts`, which bracket-pastes text, waits briefly, then sends Enter separately.

### `src/backend/services/round-service.ts`

Exports:

- `RoundService`
- `TaskRoundInput`
- `RoundServiceDeps`
- `createRoundService(deps)`
- `evaluateTaskRoundState(input)`

Responsibilities:

- read hook-driven role activity from `RoleSessionRecord`
- map `activityStatus: "running"` to role state `answering`
- map `activityStatus: "idle"` plus `lastStopAt` to role state `idle`
- evaluate task-level round completion from hook-driven role states
- use pending route-file count to keep the round active while more dispatch work exists
- complete PM -> role -> PM chains only after the final role's hook `Stop`

## 9. Backend API

### `src/backend/server.ts`

Exports:

- `CreateServerOptions`
- `ServerDeps`
- `createServer(deps, options)`
- `startServer(options)`
- `CreateDefaultServerDepsOptions`
- `createDefaultServerDeps(options)`
- `getDefaultStaticDir()`

Registers HTTP routes and the terminal WebSocket.

### Route files

- `src/backend/api/app-settings-routes.ts`: UI preferences
- `src/backend/api/project-routes.ts`: health, recent paths, connect/current project
- `src/backend/api/harness-routes.ts`: harness status/apply
- `src/backend/api/task-routes.ts`: tasks, task status, and Close Task cleanup endpoint; Close Task stops running role sessions before translation/task cleanup
- `src/backend/api/session-routes.ts`: session lifecycle
- `src/backend/api/artifact-routes.ts`: artifact and log reads/writes
- `src/backend/api/message-routes.ts`: message history, pending route files, Mark All Done recovery, and orchestration
- `src/backend/api/claude-hook-routes.ts`: Claude Code `UserPromptSubmit` and `Stop` hook receiver
- `src/backend/api/round-routes.ts`: task round completion state
- `src/backend/api/translation-routes.ts`: settings, prompt previews, provider test, start/poll, input/send, clear/retry

Worktree task API:

```text
POST /api/tasks/:taskSlug/cleanup
```

Do not add a "switch task worktree" endpoint. Worktree assignment happens only during task creation.

### WebSocket files

- `src/backend/ws/terminal-ws.ts`

Terminal WebSocket forwards PTY output/input/resize.

Translation does not use WebSocket. The backend writes cached translation events under `<taskRepoRoot>/.ai/vcm/translation/<task>/<role>/<session-id>.jsonl`; the frontend polls `GET /api/translation/sessions/:sessionId/events?after=<cursor>`. The cursor is the next expected seq, so `after=18` means seq `1..17` can be removed and seq `18+` should be returned.

Round completion is HTTP-polled too. `GET /api/tasks/:taskSlug/round` returns `VcmTaskRoundState` from hook-driven role activity plus pending-message blockers; it is not a WebSocket stream.

## 10. Backend Templates

### `src/backend/templates/handoff.ts`

Exports:

- `renderArchitecturePlanTemplate(taskSlug)`
- `renderImplementationLogTemplate(taskSlug)`
- `renderValidationLogTemplate(taskSlug)`
- `renderReviewReportTemplate(taskSlug)`
- `renderDocsSyncReportTemplate(taskSlug)`

### `src/backend/templates/role-command.ts`

Exports:

- `renderRoleCommandTemplate(taskSlug, role)`

### `src/backend/templates/message-envelope.ts`

Exports:

- `renderMessageEnvelope(message)`
- `renderManualStagePrompt(message)`

Manual stage prompt does not submit Enter.

Auto delivery envelope is submitted with Enter.

### Harness templates

- `src/backend/templates/harness/claude-root.ts`
- `src/backend/templates/harness/gitignore.ts`
- `src/backend/templates/harness/project-manager-agent.ts`
- `src/backend/templates/harness/architect-agent.ts`
- `src/backend/templates/harness/coder-agent.ts`
- `src/backend/templates/harness/reviewer-agent.ts`

Each exports one render function for VCM managed rules.

## 11. Frontend State And API Client

### `src/frontend/state/api-client.ts`

Central browser API wrapper.

It calls:

- project endpoints
- harness endpoints
- task endpoints
- session endpoints
- artifact endpoints
- message endpoints
- orchestration endpoints
- route-file inspection endpoints for the Messages modal
- round completion endpoint
- translation endpoints

Implemented task cleanup method:

- `cleanupTask(taskSlug, options)`

There are no branch/worktree switching APIs in the current frontend client.

### `src/frontend/state/app-store.ts`

Exports:

- `AppStateSnapshot`
- `selectActiveTask(tasks, activeTaskSlug)`

### `src/frontend/state/session-store.ts`

Exports:

- `getSessionForRole(sessions, role)`

## 12. Frontend Routes

### `src/frontend/app.tsx`

Exports:

- `App()`

Responsibilities:

- own top-level app state
- load current project and recent paths on startup
- load app preferences, including `themeMode` and `roundCompletionAlerts`
- load tasks and harness status after connect
- pass sidebar props to `ProjectDashboard`
- pass task props to `TaskWorkspace`
- keep active messages/orchestration/events synchronized by task
- dedupe task round `completionId` values and show/play completion alerts when enabled

### `src/frontend/routes/project-dashboard.tsx`

Exports:

- `ProjectDashboardProps`
- `ProjectDashboard(props)`

Responsibilities:

- collapsible sidebar
- repository connect form
- repository summary
- settings section
- round completion alert toggle
- try alert test button
- messages modal
- events modal
- harness panel
- task creation with one task-name field, `Create worktree and branch` checkbox selected by default, branch preview, and worktree path preview
- task navigation

### `src/frontend/routes/task-workspace.tsx`

Exports:

- `TaskWorkspaceProps`
- `TaskWorkspace(props)`

Responsibilities:

- task header with task title, role tabs, global `Translate`, and `Close Task`
- red `Close Task` action with destructive confirmation
- no task-header `Refresh` button; workspace state refreshes automatically
- status/message/orchestration refresh
- round state refresh
- periodic polling
- session lifecycle actions
- per-role permission state
- runtime event collection for sidebar Events modal

## 13. Frontend Components

### `src/frontend/components/app-shell.tsx`

Exports:

- `AppShellProps`
- `AppShell({ sidebar, children })`

Two-column page shell.

### `src/frontend/components/repo-connect-form.tsx`

Exports:

- `RepoConnectFormProps`
- `RepoConnectForm(props)`

Layout:

- path input row
- recent select plus connect button row

This form connects the base repository. It is not used to switch an existing task to another worktree.

### `src/frontend/components/harness-panel.tsx`

Exports:

- `HarnessPanelProps`
- `HarnessPanel(props)`

Shows harness status and install/update action.

### `src/frontend/components/message-timeline.tsx`

Exports:

- `MessageTimelineProps`
- `getMessageCounts(messages)`
- `MessageTimeline(props)`

Used inside the Messages modal. Current UI rows show newest message history first with stable increasing sequence numbers, timestamp, route, type, body preview, source route file path, and a `Copy` button. The modal header includes `Mark All Done` for clearing manually handled pending route files and `Delete All` for removing message history. Stage/approve/reject controls are not part of the current UI.

### `src/frontend/components/event-log.tsx`

Exports:

- `EventLogProps`
- `EventLog(props)`

Used inside the Events modal.

### `src/frontend/components/task-nav.tsx`

Exports:

- `TaskNavProps`
- `TaskNav(props)`

Task list in sidebar.

### `src/frontend/components/role-session-tabs.tsx`

Exports:

- `RoleSessionTabsProps`
- `RoleSessionTabs(props)`

Header role tabs with status badges.

### `src/frontend/components/session-console.tsx`

Exports:

- `SessionConsoleProps`
- `SessionConsole(props)`

Role console, `Auto orchestration` toggle, and translation split.

### `src/frontend/components/session-toolbar.tsx`

Exports:

- `SessionToolbarProps`
- `SessionToolbar(props)`

Renders permission select and session lifecycle buttons.

There is no visible primary `Send Command` button in the current toolbar. Role-command dispatch remains a backend compatibility path; normal role coordination uses route-file messages.

### `src/frontend/components/translation-panel.tsx`

Exports:

- `TranslationPanelProps`
- `TranslationPanel(props)`

Renders output translations, settings actions, auto-send toggle, and composer.

Important current behavior:

- panel-level status only
- no per-entry status label
- no `Original` buttons
- tool output is preserved, dim, one-line
- prose source is replaced by translated text after completion
- prose renders Markdown with GFM support
- user-input translation entries add a thick divider and larger top spacing to mark question/answer boundaries
- no separate translated-English textarea

### `src/frontend/components/translation-settings-modal.tsx`

Exports:

- `TranslationSettingsModalProps`
- `TranslationSettingsModal(props)`

Settings:

- base URL
- API key as text input
- model
- target language
- context
- timeout
- temperature
- direct editors for `zh-to-en`, `zh-to-en-with-context`, and `en-to-zh`
- reset prompts to built-in defaults
- provider test

### `src/frontend/components/status-badge.tsx`

Exports:

- `StatusBadgeProps`
- `StatusBadge(props)`

### `src/frontend/terminal/xterm-view.tsx`

Renders `xterm.js`, connects to terminal WebSocket, sends input and resize, and preserves terminal colors.

### `src/frontend/terminal/terminal-client.ts`

Terminal WebSocket client wrapper.

## 14. UI State Details

Sidebar:

- all groups default collapsed
- `Repository Path` default open only when no task is selected
- `Settings` includes `Theme`, `Round alert`, `Try alert`, `Messages`, and `Events`
- `Theme` cycles through `System`, `Light`, and `Dark`; `System` follows the browser/OS color-scheme preference
- `Round alert` is on by default and controls the in-app completion prompt plus a soft two-note completion chime
- `Try alert` calls the same prompt/sound path without waiting for a real completed round

Task workspace:

- role tabs in the first header row
- messages/events are not in main workspace
- active role console fills available space
- `Auto orchestration` is a compact role console toggle

Round completion:

- task round completion follows hook-driven role activity, not message history
- role activity uses Claude Code `UserPromptSubmit` -> `running` and Claude Code `Stop` -> `idle`; VCM terminal submit also optimistically marks the target role `running`
- PM -> role -> PM chains complete after PM's final hook `Stop`, not after the intermediate role's `Stop`
- pending route files keep the round active
- frontend dedupes `completionId` before showing a prompt or playing sound

Translation:

- task header button label is `✅ Translate` when on and `× Translate` when off
- the task header `Translate` toggle is global across all four role consoles
- translation panel `Auto-send` label is `✅ Auto-send` when on and `× Auto-send` when off
- panel uses terminal-like dark styling
- composer height is compact
- `Enter` translates/sends, `Shift+Enter` inserts newline

## 15. Data Persistence Summary

App settings:

```text
~/.vcm/settings.json
```

Contains UI theme preference, round-completion alert preference, translation settings/secrets, and recent repository paths.

Project config:

```text
~/.vcm/projects/<project-id>/config.json
~/.vcm/projects/index.json
```

Task state:

```text
<baseRepoRoot>/.ai/vcm/tasks/<task>.json
```

Session state:

```text
<taskRepoRoot>/.ai/vcm/sessions/<task>.json
```

Messages:

```text
<taskRepoRoot>/.ai/vcm/messages/<task>.jsonl
<taskRepoRoot>/.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
```

Orchestration:

```text
<taskRepoRoot>/.ai/vcm/orchestration/<task>.json
```

Translation cache:

```text
<taskRepoRoot>/.ai/vcm/translation/<task>/
```

Task worktrees:

```text
.claude/worktrees/<task>/
```

Handoff artifacts:

```text
.ai/vcm/handoffs/
```

Claude transcripts:

```text
~/.claude/projects/<project-hash>/<claude-session-id>.jsonl
```

## 16. Validation Checklist

Before release or publish:

```bash
npm run typecheck
npm test
npm run build
npm run verify:package
```

For frontend layout changes, also verify manually:

- connect repository
- confirm `.ai/vcm/` and `.claude/worktrees/` are ignored before creating a task worktree
- create task and verify branch `feature/<task>` is created
- verify worktree path is `<baseRepoRoot>/.claude/worktrees/<task>`
- open task
- verify role sessions start with cwd set to the task worktree
- role tabs stay in header
- sidebar sections collapse/open correctly
- embedded terminal remains visible after role switch
- translation split is 50/50
- Messages modal opens from sidebar Settings
- Events modal opens from sidebar Settings
- Auto orchestration toggles on/off from the role console toolbar
- Auto orchestration switches to the target role tab when VCM records `dispatchingAt`, before VCM submits the route-file message
- Round alert can be toggled from sidebar Settings and fires once after a chained round truly completes
- `Enter` in translation composer translates/sends
- `Shift+Enter` inserts newline
- close a worktree-backed task and verify it stops running role sessions, removes the worktree, deletes the task branch, and removes central task metadata

## 17. V1 Boundaries To Preserve

Do not reintroduce these into V1 docs or UI unless the product direction changes:

- tmux persistence backend
- CLI-first task management as the main product mode
- main workspace artifact panel
- Pause/Resume orchestration buttons in GUI
- raw PTY output translation
- translation classifier that drops assistant prose
- separate translated-English textarea
- optional title input in New Task
- `Dirty: yes/no` sidebar label
- role command dispatch as the primary orchestration path
- `vcmctl` as an active CLI or agent-facing message path
- per-role worktrees
- switching a task to another branch/worktree after creation
- a separate `Create task worktree` button outside task creation
