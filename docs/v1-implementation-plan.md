# V1 Implementation Plan And File Map

Last updated: 2026-05-30

This document is the current implementation map for VCM V1. It replaces older plan text that referenced removed files or obsolete UI behavior.

## 1. Current Status

V1 is implemented as a local GUI app with:

- Fastify backend.
- React frontend.
- `node-pty` embedded terminals.
- `xterm.js` terminal rendering.
- Four Claude Code role sessions.
- VCM harness installer.
- API-driven message bus.
- Translation panel based on Claude transcript JSONL tailing.
- npm packaging with built `dist` and `dist-frontend` output.

The implementation still has planned improvement space, but this file only describes code that exists now.

## 2. Package And Build

File:

- `package.json`

Current package facts:

- package name: `vibe-coding-master`
- current version: `0.0.6`
- type: ESM
- `bin.vcm`: `dist/main.js`
- `bin.vcmctl`: `dist/cli/vcmctl.js`
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
  cli/
    vcmctl.ts
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

### `src/cli/vcmctl.ts`

CLI commands:

- `vcmctl send`
- `vcmctl reply`
- `vcmctl result`
- `vcmctl inbox`
- `vcmctl ready`

Environment required in role sessions:

- `VCM_API_URL`
- `VCM_TASK_SLUG`
- `VCM_ROLE`

Role sessions receive these env vars from `SessionService`.

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

### `src/shared/types/task.ts`

Defines:

- `TaskStatus`
- `TaskRecord`
- `CreateTaskRequest`

Current UI sends only `taskSlug`, although the API type still permits optional `title` and `specPath`.

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
- `VcmMessageStatus`
- `VcmOrchestrationMode`
- `VcmRoleMessage`
- `VcmOrchestrationState`
- `SendRoleMessageRequest`
- `SendRoleMessageResult`

The state type includes `paused` for backend/API compatibility. The current GUI only exposes manual/auto.

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
- `TranslationWsMessage`

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
- `TaskWorkflowStepId`
- `TaskWorkflowStepStatus`
- `TaskWorkflowStep`
- `TaskWorkflowReport`
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
- create `.vcm/config.json`
- ensure base state directories

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

Task files:

```text
.vcm/tasks/<task>.json
```

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

Primary role command path:

```text
.ai/handoffs/<task>/role-commands/<role>.md
```

Legacy fallback:

```text
.ai/handoffs/<task>/role-commands/<role>-command.md
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
- compute workflow report

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
.vcm/sessions/<task>.json
```

Environment passed to Claude Code:

- `VCM_API_URL`
- `VCM_CTL_COMMAND`
- `VCM_TASK_SLUG`
- `VCM_ROLE`

### `src/backend/services/message-service.ts`

Exports:

- `MessageService`
- input interfaces
- `createMessageService(deps)`

Responsibilities:

- list messages
- send messages
- stage/approve/reject messages
- get/update orchestration state
- enforce message policy
- persist message snapshots
- write message body markdown
- write staged or delivered messages to target terminal

### `src/backend/services/command-dispatcher.ts`

Exports:

- `CommandDispatcher`
- `DispatchRoleCommandInput`
- `CommandDispatcherDeps`
- `createCommandDispatcher(deps)`

Compatibility role-command dispatch only. Preferred orchestration is `MessageService` plus `vcmctl`.

### `src/backend/services/harness-service.ts`

Exports:

- `HarnessService`
- `HarnessServiceDeps`
- `VCM_HARNESS_VERSION`
- `createHarnessService(deps)`

Responsibilities:

- inspect harness files
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

Storage:

```text
~/.vcm/settings.json
```

Also migrates legacy:

```text
~/.vibe-coding-master/settings.json
~/.vibe-coding-master/translation.json
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
- `formatTerminalSubmit(text)`

Responsibilities:

- load/update translation settings
- expose prompt previews
- test provider
- translate user input
- send English text to active terminal
- subscribe to session translation events
- clear session entries
- retry failed output translation
- subscribe to Claude transcript service
- translate prose output and preserve tool output

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

Registers all routes and WebSockets.

### Route files

- `src/backend/api/project-routes.ts`: health, recent paths, connect/current project
- `src/backend/api/harness-routes.ts`: harness status/apply
- `src/backend/api/task-routes.ts`: tasks and task status
- `src/backend/api/session-routes.ts`: session lifecycle and dispatch compatibility endpoint
- `src/backend/api/artifact-routes.ts`: artifact, role command, and log reads/writes
- `src/backend/api/message-routes.ts`: messages and orchestration
- `src/backend/api/translation-routes.ts`: settings, prompt previews, provider test, input/send, clear/retry

### WebSocket files

- `src/backend/ws/terminal-ws.ts`
- `src/backend/ws/translation-ws.ts`

Terminal WebSocket forwards PTY output/input/resize.

Translation WebSocket subscribes to translation entries/status for a runtime session id.

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
- translation endpoints

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
- load tasks and harness status after connect
- pass sidebar props to `ProjectDashboard`
- pass task props to `TaskWorkspace`
- keep active workflow/messages/orchestration/events synchronized by task

### `src/frontend/routes/project-dashboard.tsx`

Exports:

- `ProjectDashboardProps`
- `ProjectDashboard(props)`

Responsibilities:

- collapsible sidebar
- repository connect form
- repository summary
- workflow panel
- settings section
- messages modal
- events modal
- harness panel
- one-field task creation
- task navigation

### `src/frontend/routes/task-workspace.tsx`

Exports:

- `TaskWorkspaceProps`
- `TaskWorkspace(props)`

Responsibilities:

- task header with role tabs and refresh
- status/message/orchestration refresh
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

### `src/frontend/components/harness-panel.tsx`

Exports:

- `HarnessPanelProps`
- `HarnessPanel(props)`

Shows harness status and install/update action.

### `src/frontend/components/workflow-panel.tsx`

Exports:

- `WorkflowPanelProps`
- `WorkflowPanel({ workflow })`

Renders the sidebar workflow steps.

### `src/frontend/components/message-timeline.tsx`

Exports:

- `MessageTimelineProps`
- `getMessageCounts(messages)`
- `MessageTimeline(props)`

Used inside the Messages modal. Can show stage/reject/open-role actions.

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

Role console and translation split.

### `src/frontend/components/session-toolbar.tsx`

Exports:

- `SessionToolbarProps`
- `SessionToolbar(props)`

Renders permission select and session lifecycle buttons.

There is no visible primary `Send Command` button in the current toolbar. Role-command dispatch remains backend compatibility.

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
- no separate translated-English textarea

### `src/frontend/components/translation-settings-modal.tsx`

Exports:

- `TranslationSettingsModalProps`
- `TranslationSettingsModal(props)`

Settings:

- enable translation
- base URL
- API key as text input
- model
- target language
- input mode
- context
- translate output
- translate user input
- timeout
- temperature
- prompt slot overrides
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
- `Settings` includes `Messages`, `Events`, and `Auto orchestration`

Task workspace:

- role tabs in the first header row
- workflow is not in main workspace
- messages/events are not in main workspace
- active role console fills available space

Translation:

- top role toolbar button label is `✅ Translate` when on and `× Translate` when off
- translation panel `Auto-send` label is `✅ Auto-send` when on and `× Auto-send` when off
- panel uses terminal-like dark styling
- composer height is compact
- `Enter` translates/sends, `Shift+Enter` inserts newline

## 15. Data Persistence Summary

App settings:

```text
~/.vcm/settings.json
```

Project config:

```text
.vcm/config.json
```

Task state:

```text
.vcm/tasks/<task>.json
```

Session state:

```text
.vcm/sessions/<task>.json
```

Messages:

```text
.vcm/messages/<task>.jsonl
.ai/handoffs/<task>/messages/<message-id>.md
```

Orchestration:

```text
.vcm/orchestration/<task>.json
```

Handoff artifacts:

```text
.ai/handoffs/<task>/
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
- open task
- role tabs stay in header
- sidebar sections collapse/open correctly
- embedded terminal remains visible after role switch
- translation split is 50/50
- Messages modal opens from sidebar Settings
- Events modal opens from sidebar Settings
- Auto orchestration toggles on/off
- `Enter` in translation composer translates/sends
- `Shift+Enter` inserts newline

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
