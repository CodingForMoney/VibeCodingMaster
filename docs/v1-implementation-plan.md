# VibeCodingMaster V1 实施计划

版本：v0.2  
日期：2026-05-29  
状态：实施计划草案  
依据：

- `docs/product-design.md`
- `docs/v1-architecture-design.md`
- `docs/cc-best-practices.md`

## 1. 实施目标

V1 实现一个本地 GUI Session Cockpit，让用户可以在一个任务工作台中启动、切换、查看、输入和管理多个 Claude Code role sessions。

V1 完成后，用户应能：

```text
Open VibeCodingMaster
  -> Select repo
  -> New task
  -> Start project-manager session
  -> Start architect session
  -> Switch between role sessions
  -> Type directly into embedded Claude Code terminals
  -> View role commands, logs, and handoff artifacts
  -> Let project-manager send role messages through VCM message bus
  -> Inspect and stage pending role messages in manual mode
  -> Restart / stop role sessions
```

V1 不再以手动 CLI 或手动终端控制为主路径。

V1 不实现：

- 自动生成完整 Task Spec。
- 自动识别 public contract / test contract。
- 自动执行 validation commands。
- 自动 Cross-Model Review。
- 自动创建 PR。
- SaaS 多用户协作。
- 完整 Desktop 打包和自动更新。
- 多 worktree 自动管理。

## 2. 关键约束

1. GUI 是用户主入口，CLI 只用于启动 dev server、调试和 smoke test。
2. Claude Code role session 必须在 embedded terminal 中可见、可输入、可重启。
3. Project Manager 不直接无限制控制其他 role sessions。
4. Project Manager 必须通过 VCM message bus / `vcmctl send` 调度其他角色。
5. 非 PM role 只能通过 VCM message bus 回复 Project Manager。
6. `manual` orchestration mode 是默认；用户 stage 后 VCM 只写一行 prompt，不自动按 Enter。
7. `auto` orchestration mode 必须显式开启，并受 backend policy、pause state 和 target session state 约束。
8. Role command artifact 可作为长 handoff 引用保留，但不再是唯一 dispatch 机制。
9. Terminal output 只作为调试信息；长期事实源是 handoff artifacts 和 `.vcm/messages/<task-slug>.jsonl`。
10. Raw terminal stream 必须持续写入 `.ai/handoffs/<task-slug>/logs/<role>.log`。
11. V1 只做 artifact 存在性和标题完整性检查，不判断内容质量。
12. 状态必须能从 backend session registry、terminal process state、repo artifacts、`.vcm` metadata 恢复。
13. V1 不把每个 role 放到独立 worktree。同一任务默认共享当前 repo working directory。
14. V1 默认遵守 single-writer rule，但主要通过流程提示、role status 和 review gate 实现，不做强制 sandbox。

## 3. 技术选型

```text
Language: TypeScript
Runtime: Node.js LTS
Frontend: React + Vite
Terminal UI: xterm.js
Backend: Fastify + ws
Terminal runtime: node-pty
Process execution: execa
State storage: JSON files
Test runner: Vitest + Playwright
Module format: ESM / NodeNext
```

## 4. 目标目录结构

```text
VibeCodingMaster/
  package.json
  tsconfig.json
  tsconfig.node.json
  vite.config.ts
  vitest.config.ts
  playwright.config.ts
  index.html
  README.md
  docs/
    product-design.md
    v1-architecture-design.md
    v1-implementation-plan.md
    cc-best-practices.md

  src/
    main.ts

    shared/
      constants.ts
      types/
        api.ts
        artifact.ts
        harness.ts
        message.ts
        project.ts
        role.ts
        session.ts
        task.ts
        terminal.ts
      validation/
        artifact-check.ts
        slug-check.ts

    frontend/
      app.tsx
      main.tsx
      styles.css
      routes/
        project-dashboard.tsx
        task-workspace.tsx
      components/
        app-shell.tsx
        event-log.tsx
        harness-panel.tsx
        message-timeline.tsx
        repo-connect-form.tsx
        role-session-tabs.tsx
        session-console.tsx
        session-toolbar.tsx
        status-badge.tsx
        task-nav.tsx
      terminal/
        terminal-client.ts
        xterm-view.tsx
      state/
        api-client.ts
        app-store.ts
        session-store.ts

    backend/
      server.ts
      api/
        artifact-routes.ts
        harness-routes.ts
        message-routes.ts
        project-routes.ts
        session-routes.ts
        task-routes.ts
      ws/
        terminal-ws.ts
      runtime/
        node-pty-runtime.ts
        session-registry.ts
        terminal-runtime.ts
      services/
        artifact-service.ts
        command-dispatcher.ts
        harness-service.ts
        message-service.ts
        project-service.ts
        session-service.ts
        status-service.ts
        task-service.ts
      adapters/
        claude-adapter.ts
        command-runner.ts
        filesystem.ts
        git-adapter.ts
      templates/
        handoff.ts
        message-envelope.ts
        harness/
          claude-root.ts
          project-manager-agent.ts
          architect-agent.ts
          coder-agent.ts
          reviewer-agent.ts
        role-command.ts
      validation/
        environment-check.ts

    cli/
      vcmctl.ts

  tests/
    unit/
      shared/
      backend/
      frontend/
    integration/
      api/
      runtime/
    e2e/
      task-workspace.spec.ts
```

## 5. Package 和配置文件

### 5.1 `package.json`

职责：

- 声明本地开发命令。
- 声明 build、test、typecheck、e2e 命令。
- 保留 `vcm` binary 用于启动本地 GUI dev/prod server。

计划字段：

```json
{
  "type": "module",
  "bin": {
    "vcm": "./dist/main.js"
  },
  "scripts": {
    "dev": "tsx src/main.ts --dev",
    "build": "tsc -p tsconfig.node.json && vite build",
    "start": "node dist/main.js",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.node.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@fastify/static": "^7.0.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-web-links": "^0.11.0",
    "@xterm/xterm": "^5.5.0",
    "execa": "^9.0.0",
    "fastify": "^5.0.0",
    "node-pty": "^1.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "ws": "^8.0.0",
    "zod": "^3.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/ws": "^8.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vite": "^6.0.0",
    "vitest": "^2.0.0"
  }
}
```

### 5.2 `tsconfig.json`

职责：

- 类型检查前端和 shared 代码。
- 使用 JSX。
- 不输出文件。

关键配置：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src/frontend/**/*.ts", "src/frontend/**/*.tsx", "src/shared/**/*.ts"]
}
```

### 5.3 `tsconfig.node.json`

职责：

- 编译 backend、main 和 shared 代码到 `dist/`。
- 使用 NodeNext ESM。

关键配置：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/main.ts", "src/backend/**/*.ts", "src/shared/**/*.ts"]
}
```

### 5.4 `vite.config.ts`

职责：

- 构建 React frontend。
- 开发时代理 API 和 WebSocket 到 local backend。

导出定义：

```ts
export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist-frontend"
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4173",
      "/ws": {
        target: "ws://localhost:4173",
        ws: true
      }
    }
  }
});
```

### 5.5 `vitest.config.ts`

职责：

- 运行 unit 和 integration tests。
- 使用 node environment。

导出定义：

```ts
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"]
  }
});
```

### 5.6 `playwright.config.ts`

职责：

- 运行 GUI smoke tests。
- 启动 `npm run dev` 作为 webServer。

导出定义：

```ts
export default defineConfig({
  testDir: "tests/e2e",
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true
  }
});
```

### 5.7 `src/main.ts`

职责：

- 启动 local backend。
- 在 dev 模式提示 Vite URL。
- 在 prod 模式 serve frontend static assets。

导出定义：

```ts
export interface MainOptions {
  dev?: boolean;
  host?: string;
  port?: number;
  open?: boolean;
}

export function parseMainArgs(argv: string[]): MainOptions;

export async function main(argv?: string[]): Promise<void>;
```

## 6. Shared 类型层

### 6.1 `src/shared/types/role.ts`

职责：

- 定义 V1 role 集合和状态。

导出定义：

```ts
export type RoleName =
  | "project-manager"
  | "architect"
  | "coder"
  | "reviewer";

export type DispatchableRole =
  | "architect"
  | "coder"
  | "reviewer";

export type RoleStatus =
  | "not_started"
  | "starting"
  | "running"
  | "waiting"
  | "blocked"
  | "done"
  | "resumable"
  | "crashed"
  | "exited"
  | "missing"
  | "unknown";

export interface RoleDefinition {
  name: RoleName;
  label: string;
  commandAgent: string;
  dispatchable: boolean;
}
```

### 6.2 `src/shared/constants.ts`

职责：

- 定义固定 role、artifact 文件名、默认端口。

导出定义：

```ts
export const DEFAULT_BACKEND_PORT = 4173;
export const DEFAULT_FRONTEND_PORT = 5173;

export const ROLE_DEFINITIONS: readonly RoleDefinition[];
export const ROLE_NAMES: readonly RoleName[];
export const DISPATCHABLE_ROLES: readonly DispatchableRole[];

export function isRoleName(value: string): value is RoleName;
export function isDispatchableRole(value: string): value is DispatchableRole;
export function getRoleDefinition(role: RoleName): RoleDefinition;
```

### 6.3 `src/shared/types/project.ts`

职责：

- 定义 repo 连接和项目配置。

导出定义：

```ts
export interface ProjectConfig {
  version: 1;
  repoRoot: string;
  defaultRoles: RoleName[];
  handoffRoot: string;
  stateRoot: string;
  terminalBackend: "node-pty";
  claudeCommand: string;
}

export interface ProjectSummary {
  repoRoot: string;
  branch: string;
  isDirty: boolean;
  config: ProjectConfig;
  warnings: string[];
}

export interface ConnectProjectRequest {
  repoPath: string;
}
```

### 6.4 `src/shared/types/task.ts`

职责：

- 定义 task metadata。

导出定义：

```ts
export type TaskStatus =
  | "created"
  | "planning"
  | "running"
  | "blocked"
  | "stopped"
  | "done";

export interface TaskRecord {
  version: 1;
  taskSlug: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  repoRoot: string;
  branch: string;
  handoffDir: string;
  status: TaskStatus;
  specPath?: string;
}

export interface CreateTaskRequest {
  taskSlug: string;
  title?: string;
  specPath?: string;
}
```

### 6.5 `src/shared/types/session.ts`

职责：

- 定义 role session metadata 和 task session summary。

导出定义：

```ts
export type ClaudePermissionMode =
  | "default"
  | "bypassPermissions"
  | "dangerously-skip-permissions";

export interface RoleSessionRecord {
  id: string;
  claudeSessionId: string;
  taskSlug: string;
  role: RoleName;
  status: RoleStatus;
  command: string;
  permissionMode: ClaudePermissionMode;
  cwd: string;
  terminalBackend: "node-pty";
  pid?: number;
  logPath: string;
  roleCommandPath?: string;
  handoffArtifactPath?: string;
  startedAt?: string;
  updatedAt: string;
  lastOutputAt?: string;
  exitCode?: number | null;
}

export interface TaskSessionRecord {
  version: 1;
  taskSlug: string;
  updatedAt: string;
  roles: Record<RoleName, RoleSessionPointer>;
}

export interface RoleSessionPointer {
  id: string | null;
  claudeSessionId?: string;
  status: RoleStatus;
  record?: RoleSessionRecord;
}

export interface StartRoleSessionRequest {
  cols?: number;
  rows?: number;
  permissionMode?: ClaudePermissionMode;
}
```

### 6.6 `src/shared/types/terminal.ts`

职责：

- 定义 WebSocket terminal 消息和事件。

导出定义：

```ts
export type ClientTerminalMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type ServerTerminalMessage =
  | { type: "output"; data: string }
  | { type: "status"; status: RoleStatus }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };

export interface TerminalEvent {
  id: string;
  sessionId: string;
  taskSlug: string;
  role: RoleName;
  type: "input" | "output" | "status" | "exit" | "error" | "dispatch";
  timestamp: string;
  data?: string;
  status?: RoleStatus;
  exitCode?: number | null;
}
```

### 6.7 `src/shared/types/artifact.ts`

职责：

- 定义 handoff artifact paths 和 schema check。

导出定义：

```ts
export type ArtifactKind =
  | "architecture-plan"
  | "implementation-log"
  | "validation-log"
  | "review-report"
  | "docs-sync-report";

export interface HandoffPaths {
  handoffDir: string;
  roleCommandsDir: string;
  logsDir: string;
  roleCommandPaths: Record<DispatchableRole, string>;
  roleLogPaths: Record<RoleName, string>;
  architecturePlanPath: string;
  implementationLogPath: string;
  validationLogPath: string;
  reviewReportPath: string;
  docsSyncReportPath: string;
}

export interface ArtifactCheckResult {
  kind: ArtifactKind;
  path: string;
  exists: boolean;
  isEmpty: boolean;
  hasPlaceholder: boolean;
  missingHeadings: string[];
  status: "missing" | "empty" | "incomplete" | "ok";
}

export interface ArtifactSummary {
  paths: HandoffPaths;
  checks: ArtifactCheckResult[];
}
```

### 6.8 `src/shared/types/harness.ts`

职责：

- 定义 VCM Harness 检查、计划和应用结果。

导出定义：

```ts
export type HarnessFileKind =
  | "root-claude"
  | "agent-project-manager"
  | "agent-architect"
  | "agent-coder"
  | "agent-reviewer";

export type HarnessFileAction = "create" | "insert" | "update" | "ok";

export interface HarnessFileStatus {
  kind: HarnessFileKind;
  path: string;
  exists: boolean;
  hasManagedBlock: boolean;
  managedVersion?: number;
  action: HarnessFileAction;
}

export interface HarnessStatusReport {
  version: number;
  files: HarnessFileStatus[];
  needsApply: boolean;
  plannedChanges: HarnessPlannedChange[];
  warnings: string[];
}

export interface HarnessPlannedChange {
  path: string;
  action: HarnessFileAction;
  reason: string;
}

export interface HarnessApplyResult {
  version: number;
  changedFiles: HarnessPlannedChange[];
  message: string;
}
```

### 6.9 `src/shared/types/message.ts`

职责：

- 定义 VCM role message bus 的消息、状态和 orchestration mode。
- 支持 PM-mediated role messaging，不支持任意 role-to-role chat。

导出定义：

```ts
export type VcmMessageActor = RoleName | "user";

export type VcmMessageType =
  | "user-request"
  | "task"
  | "question"
  | "blocked"
  | "result"
  | "finding"
  | "review-request"
  | "revise"
  | "cancel";

export type VcmMessageStatus =
  | "pending_approval"
  | "queued"
  | "staged"
  | "delivered"
  | "acknowledged"
  | "failed"
  | "rejected"
  | "cancelled";

export type VcmOrchestrationMode = "manual" | "auto";

export interface VcmRoleMessage {
  id: string;
  taskSlug: string;
  fromRole: VcmMessageActor;
  toRole: RoleName;
  type: VcmMessageType;
  body: string;
  artifactRefs: string[];
  bodyPath?: string;
  parentMessageId?: string;
  status: VcmMessageStatus;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  stagedAt?: string;
  failureReason?: string;
}

export interface VcmOrchestrationState {
  taskSlug: string;
  mode: VcmOrchestrationMode;
  paused: boolean;
  updatedAt: string;
}

export interface SendRoleMessageRequest {
  fromRole: VcmMessageActor;
  toRole: RoleName;
  type: VcmMessageType;
  body: string;
  artifactRefs?: string[];
  parentMessageId?: string;
}

export interface SendRoleMessageResult {
  message: VcmRoleMessage;
  delivered: boolean;
  requiresUserApproval: boolean;
}
```

### 6.10 `src/shared/types/api.ts`

职责：

- 定义统一 API response。

导出定义：

```ts
export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
```

## 7. Shared Validation

### 7.1 `src/shared/validation/slug-check.ts`

导出定义：

```ts
export interface SlugValidationResult {
  valid: boolean;
  reason?: string;
  suggestion?: string;
}

export function isValidTaskSlug(value: string): boolean;
export function validateTaskSlug(value: string): SlugValidationResult;
export function assertValidTaskSlug(value: string): string;
export function suggestTaskSlug(value: string): string;
```

### 7.2 `src/shared/validation/artifact-check.ts`

导出定义：

```ts
export const REQUIRED_ARCHITECTURE_PLAN_HEADINGS: readonly string[];
export const REQUIRED_IMPLEMENTATION_LOG_HEADINGS: readonly string[];
export const REQUIRED_REVIEW_REPORT_HEADINGS: readonly string[];

export function getRequiredHeadings(kind: ArtifactKind): readonly string[];
export function parseMarkdownHeadings(content: string): string[];
export function findMissingHeadings(content: string, required: readonly string[]): string[];
export function checkMarkdownArtifact(kind: ArtifactKind, path: string, content: string | null): ArtifactCheckResult;
export function checkValidationLogArtifact(path: string, content: string | null): ArtifactCheckResult;
```

## 8. Backend Adapter 层

### 8.1 `src/backend/adapters/command-runner.ts`

职责：

- 封装 `execa`。
- 供 git / claude check 使用。

导出定义：

```ts
export interface RunCommandOptions {
  cwd?: string;
  reject?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: RunCommandOptions): Promise<RunCommandResult>;
}

export function createDefaultCommandRunner(): CommandRunner;
export function normalizeCommandError(error: unknown): RunCommandResult;
```

### 8.2 `src/backend/adapters/filesystem.ts`

职责：

- 封装文件读写、JSON 读写、目录创建。

导出定义：

```ts
export interface FileSystemAdapter {
  pathExists(path: string): Promise<boolean>;
  ensureDir(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  appendText(path: string, content: string): Promise<void>;
  readJson<T>(path: string): Promise<T>;
  writeJsonAtomic<T>(path: string, value: T): Promise<void>;
  ensureFile(path: string, content: string, options?: EnsureFileOptions): Promise<boolean>;
}

export interface EnsureFileOptions {
  overwrite?: boolean;
}

export function createNodeFileSystemAdapter(): FileSystemAdapter;
export function resolveRepoPath(repoRoot: string, repoRelativePath: string): string;
export function toRepoRelativePath(repoRoot: string, absolutePath: string): string;
```

### 8.3 `src/backend/adapters/git-adapter.ts`

职责：

- 检查 Git repo 和 branch 状态。

导出定义：

```ts
export interface GitAdapter {
  isGitRepo(cwd: string): Promise<boolean>;
  getRepoRoot(cwd: string): Promise<string>;
  getCurrentBranch(repoRoot: string): Promise<string>;
  isDirty(repoRoot: string): Promise<boolean>;
  getDiffSummary(repoRoot: string): Promise<string>;
}

export function createGitAdapter(runner: CommandRunner): GitAdapter;
```

### 8.4 `src/backend/adapters/claude-adapter.ts`

职责：

- 检查 Claude Code 是否安装。
- 生成 role session 启动命令。

导出定义：

```ts
export interface ClaudeAdapter {
  isAvailable(command?: string): Promise<boolean>;
  getVersion(command?: string): Promise<string>;
  buildRoleStartCommand(
    role: RoleName,
    command?: string,
    permissionMode?: ClaudePermissionMode
  ): { command: string; args: string[]; display: string };
}

export function createClaudeAdapter(runner: CommandRunner): ClaudeAdapter;
```

## 9. Backend Runtime 层

### 9.1 `src/backend/runtime/terminal-runtime.ts`

职责：

- 定义 terminal runtime 抽象。
- 让上层业务不依赖 node-pty 细节。

导出定义：

```ts
export interface CreateTerminalSessionInput {
  taskSlug: string;
  role: RoleName;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  logPath: string;
}

export interface TerminalSession {
  id: string;
  taskSlug: string;
  role: RoleName;
  status: RoleStatus;
  pid?: number;
  startedAt: string;
  lastOutputAt?: string;
  exitCode?: number | null;
}

export type TerminalEventListener = (event: TerminalEvent) => void;
export type Unsubscribe = () => void;

export interface TerminalRuntime {
  createSession(input: CreateTerminalSessionInput): Promise<TerminalSession>;
  getSession(sessionId: string): TerminalSession | undefined;
  getSessionByRole(taskSlug: string, role: RoleName): TerminalSession | undefined;
  listSessions(taskSlug?: string): TerminalSession[];
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  stop(sessionId: string): Promise<void>;
  restart(sessionId: string): Promise<TerminalSession>;
  subscribe(sessionId: string, listener: TerminalEventListener): Unsubscribe;
}
```

### 9.2 `src/backend/runtime/node-pty-runtime.ts`

职责：

- 实现 `TerminalRuntime`。
- 使用 node-pty 承载 Claude Code 交互式 session。
- 将 output 写入 logs 并推送给 subscribers。

导出定义：

```ts
export interface NodePtyRuntimeDeps {
  fs: FileSystemAdapter;
  now?: () => string;
  id?: () => string;
}

export function createNodePtyTerminalRuntime(deps: NodePtyRuntimeDeps): TerminalRuntime;
```

实现规则：

- `createSession` 使用 `pty.spawn(command, args, { cwd, env, cols, rows })`。
- 监听 `onData`：
  - append 到 log。
  - emit `TerminalEvent`。
  - 更新 `lastOutputAt`。
- 监听 `onExit`：
  - 更新 `status` 为 `exited` 或 `crashed`。
  - emit `exit` event。
- `write` 写入 pty。
- `resize` 调用 pty resize。
- `stop` kill pty 并更新状态。

### 9.3 Programmatic I/O Boundary

V1 的 backend 允许程序化读写 embedded terminal：

- `runtime.write(sessionId, data)`：向指定 role session 写入 terminal input。
- `runtime.subscribe(sessionId, listener)`：监听 terminal output、status、exit 和 error event。
- `terminal-ws`：把用户在 GUI terminal 中输入的内容转发给 runtime。
- `message-service`：在 manual stage 或 auto delivery 时，按 policy 向目标 session 写入消息。
- `command-dispatcher`：兼容旧 Send Command，向目标 session 写入 role command 短指令。

V1 允许的自动化边界：

- 用户在 GUI terminal 里的输入可以原样转发。
- 用户点击 `Stage` 后，backend 可以写入 `Read and handle VCM message ...`，但不追加 Enter。
- 用户打开 auto mode 后，backend 可以在 policy 通过时写入可见 `[VCM MESSAGE]` envelope。
- 用户点击旧 Send Command 后，backend 可以写入 `Please read and execute the role command at: <path>`。
- Backend 可以监听 output 并写入 raw log。
- Backend 可以根据 output/exit event 更新轻量状态和 GUI 提示。

V1 明确不做：

- 不自动确认 Claude Code permission prompt。
- 不允许 Project Manager 绕过 MessageService 直接写 Architect/Coder/Reviewer terminal。
- 不允许 Architect 绕过 PM 直接触发 Coder。
- 不允许 Coder 绕过 PM 直接触发 Reviewer。
- 不根据 terminal output 自动执行高风险下一步。

### 9.4 `src/backend/runtime/session-registry.ts`

职责：

- 保存 backend 内存中的 live sessions。
- 将 runtime state 转为 GUI 可展示状态。

导出定义：

```ts
export interface SessionRegistry {
  upsert(session: RoleSessionRecord): void;
  get(sessionId: string): RoleSessionRecord | undefined;
  getByRole(taskSlug: string, role: RoleName): RoleSessionRecord | undefined;
  list(taskSlug?: string): RoleSessionRecord[];
  updateStatus(sessionId: string, status: RoleStatus, patch?: Partial<RoleSessionRecord>): void;
  remove(sessionId: string): void;
}

export function createSessionRegistry(): SessionRegistry;
```

## 10. Backend Service 层

### 10.1 `src/backend/services/project-service.ts`

职责：

- 连接 repo。
- 创建 `.vcm/config.json`。
- 检查 Claude Code、branch、dirty state。

导出定义：

```ts
export interface ProjectService {
  connectProject(input: ConnectProjectInput): Promise<ProjectSummary>;
  getCurrentProject(): Promise<ProjectSummary | null>;
  loadConfig(repoRoot: string): Promise<ProjectConfig>;
  saveConfig(config: ProjectConfig, force?: boolean): Promise<void>;
  getConfigPath(repoRoot: string): string;
}

export interface ProjectServiceDeps {
  fs: FileSystemAdapter;
  git: GitAdapter;
  claude: ClaudeAdapter;
}

export function createProjectService(deps: ProjectServiceDeps): ProjectService;
export function buildDefaultProjectConfig(repoRoot: string): ProjectConfig;
```

### 10.2 `src/backend/services/task-service.ts`

职责：

- 创建任务 metadata。
- 创建 handoff structure。
- 读取任务列表和单个任务。

导出定义：

```ts
export interface TaskService {
  createTask(repoRoot: string, input: CreateTaskRequest): Promise<TaskRecord>;
  listTasks(repoRoot: string): Promise<TaskRecord[]>;
  loadTask(repoRoot: string, taskSlug: string): Promise<TaskRecord>;
  saveTask(repoRoot: string, task: TaskRecord): Promise<void>;
  updateTaskStatus(repoRoot: string, taskSlug: string, status: TaskStatus): Promise<TaskRecord>;
}

export interface TaskServiceDeps {
  fs: FileSystemAdapter;
  git: GitAdapter;
  artifactService: ArtifactService;
  projectService: Pick<ProjectService, "loadConfig">;
}

export function createTaskService(deps: TaskServiceDeps): TaskService;
```

### 10.3 `src/backend/services/artifact-service.ts`

职责：

- 创建 handoff 目录结构。
- 创建 artifact 模板。
- 读写 role command。
- 检查 artifact 状态。
- 追加 raw logs。

导出定义：

```ts
export interface ArtifactService {
  getHandoffPaths(repoRoot: string, handoffDir: string): HandoffPaths;
  ensureHandoffStructure(input: EnsureHandoffStructureInput): Promise<HandoffPaths>;
  createArtifactTemplates(input: CreateArtifactTemplatesInput): Promise<string[]>;
  listArtifacts(input: ListArtifactsInput): Promise<ArtifactSummary>;
  readArtifact(input: ReadArtifactInput): Promise<string>;
  readRoleCommand(input: ReadRoleCommandInput): Promise<string>;
  saveRoleCommand(input: SaveRoleCommandInput): Promise<void>;
  appendRoleLog(input: AppendRoleLogInput): Promise<void>;
}

export interface EnsureHandoffStructureInput {
  repoRoot: string;
  taskSlug: string;
  handoffDir: string;
}

export interface CreateArtifactTemplatesInput {
  repoRoot: string;
  taskSlug: string;
  handoffDir: string;
  overwrite?: boolean;
}

export interface ListArtifactsInput {
  repoRoot: string;
  taskSlug: string;
  handoffDir: string;
}

export interface ReadArtifactInput {
  repoRoot: string;
  path: string;
}

export interface ReadRoleCommandInput {
  repoRoot: string;
  handoffDir: string;
  role: DispatchableRole;
}

export interface SaveRoleCommandInput {
  repoRoot: string;
  handoffDir: string;
  role: DispatchableRole;
  content: string;
}

export interface AppendRoleLogInput {
  repoRoot: string;
  handoffDir: string;
  role: RoleName;
  content: string;
}

export function createArtifactService(fs: FileSystemAdapter): ArtifactService;
```

### 10.4 `src/backend/services/harness-service.ts`

职责：

- 检查 repo 是否安装 VCM Harness rules。
- 检查并计划 `CLAUDE.md` 与 `.claude/agents/*.md` 的 VCM managed block。
- 对缺失文件生成推荐默认内容。
- 对已有文件只插入或更新 `<!-- VCM:BEGIN version=... -->` managed block。
- 返回 planned changes，供 GUI 在写入前展示。
- 应用变更后返回 changed files summary，并提示用户 review/commit。

导出定义：

```ts
export interface HarnessService {
  getHarnessStatus(repoRoot: string): Promise<HarnessStatusReport>;
  applyHarness(repoRoot: string): Promise<HarnessApplyResult>;
}

export interface HarnessServiceDeps {
  fs: FileSystemAdapter;
  now?: () => string;
}

export function createHarnessService(deps: HarnessServiceDeps): HarnessService;
```

实现规则：

- `CLAUDE.md` 不存在时创建推荐默认文件。
- `.claude/agents/project-manager.md`、`architect.md`、`coder.md`、`reviewer.md` 不存在时创建推荐默认文件。
- 文件存在且无 VCM block 时，追加 VCM block。
- 文件存在且 VCM block 版本过期时，只替换 VCM block。
- 文件存在且 VCM block 最新时，不修改。
- 不修改 managed block 之外的用户内容。
- 如果 working tree 已 dirty，仍可应用，但必须在结果 warnings 中提示用户 review diff，避免混淆已有改动和 VCM 改动。

默认模板内容：

- `templates/harness/claude-root.ts`：共享 VCM 规则、canonical handoff directory、`vcmctl` 基本规则、高风险停止条件。
- `templates/harness/project-manager-agent.ts`：用户沟通入口、任务澄清、角色路由、`vcmctl send`、workflow gate、final acceptance / commit / PR。
- `templates/harness/architect-agent.ts`：architecture plan、module boundary、public/test contract、post-review docs sync / architecture drift check、`docs-sync-report.md`。
- `templates/harness/coder-agent.ts`：按 approved plan 实现、维护 implementation / validation logs、遇到范围或架构变化时回 PM。
- `templates/harness/reviewer-agent.ts`：独立 review、测试充分性、review report、发现 docs drift 时交回 PM。

### 10.5 `src/backend/services/session-service.ts`

职责：

- 启动、停止、重启 role session。
- 同步 runtime、registry 和 `.vcm/sessions` metadata。
- 首次启动生成 `claudeSessionId`，并使用 `claude --agent <role> --session-id <uuid>`。
- 异常中断或 backend 重启后，从 `.vcm/sessions/<task-slug>.json` 恢复 role metadata。
- Resume 使用 `claude --agent <role> --resume <claudeSessionId>` 创建新的 embedded terminal。
- Restart 优先复用已有 `claudeSessionId`，避免丢失长任务上下文。

导出定义：

```ts
export interface SessionService {
  listSessions(repoRoot: string, taskSlug: string): Promise<RoleSessionRecord[]>;
  startRoleSession(input: StartRoleSessionInput): Promise<RoleSessionRecord>;
  resumeRoleSession(input: StartRoleSessionInput): Promise<RoleSessionRecord>;
  stopRoleSession(input: StopRoleSessionInput): Promise<RoleSessionRecord>;
  restartRoleSession(input: RestartRoleSessionInput): Promise<RoleSessionRecord>;
  getRoleSession(repoRoot: string, taskSlug: string, role: RoleName): Promise<RoleSessionRecord | null>;
}

export interface StartRoleSessionInput {
  repoRoot: string;
  taskSlug: string;
  role: RoleName;
  cols?: number;
  rows?: number;
  permissionMode?: ClaudePermissionMode;
}

export interface StopRoleSessionInput {
  repoRoot: string;
  taskSlug: string;
  role: RoleName;
}

export interface RestartRoleSessionInput extends StopRoleSessionInput {
  cols?: number;
  rows?: number;
}

export interface SessionServiceDeps {
  claude: ClaudeAdapter;
  runtime: TerminalRuntime;
  registry: SessionRegistry;
  taskService: TaskService;
  artifactService: ArtifactService;
  projectService: Pick<ProjectService, "loadConfig">;
}

export function createSessionService(deps: SessionServiceDeps): SessionService;
```

### 10.6 `src/backend/services/command-dispatcher.ts`

职责：

- 从 role command artifact 读取命令。
- 将短指令写入目标 role terminal。
- 记录 dispatch event。

导出定义：

```ts
export interface CommandDispatcher {
  dispatchRoleCommand(input: DispatchRoleCommandInput): Promise<DispatchRoleCommandResult>;
}

export interface DispatchRoleCommandInput {
  repoRoot: string;
  taskSlug: string;
  role: DispatchableRole;
}

export interface DispatchRoleCommandResult {
  taskSlug: string;
  role: DispatchableRole;
  commandPath: string;
  instruction: string;
  dispatchedAt: string;
}

export interface CommandDispatcherDeps {
  runtime: TerminalRuntime;
  sessionService: SessionService;
  taskService: TaskService;
  artifactService: ArtifactService;
}

export function createCommandDispatcher(deps: CommandDispatcherDeps): CommandDispatcher;
```

实现规则：

- role command 文件缺失时失败。
- role command 文件为空时失败。
- role command 文件仍是模板或包含 `TBD` / `status: draft` 时失败。
- role command 必须使用当前 VCM task 的 canonical path：`.ai/handoffs/<task-slug>/role-commands/<role>.md`。
- Project Manager 的 VCM 协作规则必须来自 repo-local `CLAUDE.md` / `.claude/agents/project-manager.md` managed block，不再通过 terminal 输入注入长 context。
- 目标 role session 未运行时失败并提示启动 session。
- `instruction` 必须是短文本：
- 只有用户通过 GUI 点击 Send Command 时才调用 dispatch。
- dispatch 不解析 Claude Code 输出，不自动重试，不自动确认权限。
- dispatch 成功后只记录 event，不继续触发下一个 role。

```text
Please read and execute the role command at: <path>
```

### 10.7 `src/backend/services/message-service.ts`

职责：

- 实现 PM-mediated VCM message bus。
- 校验 sender / target / message type / taskSlug policy。
- 持久化 `.vcm/messages/<task-slug>.jsonl`。
- 写入长正文 `.ai/handoffs/<task-slug>/messages/<message-id>.md`。
- 管理 `.vcm/orchestration/<task-slug>.json`。
- 支持 manual mode 的 pending approval 和 staging。
- 支持 auto mode 的 visible envelope delivery。
- 禁止非 PM role 直接互发消息。

导出定义：

```ts
export interface MessageService {
  listMessages(input: ListMessagesInput): Promise<VcmRoleMessage[]>;
  sendMessage(input: SendMessageInput): Promise<SendRoleMessageResult>;
  stageMessage(input: MessageActionInput): Promise<VcmRoleMessage>;
  approveMessage(input: MessageActionInput): Promise<VcmRoleMessage>;
  rejectMessage(input: MessageActionInput): Promise<VcmRoleMessage>;
  getOrchestrationState(input: OrchestrationStateInput): Promise<VcmOrchestrationState>;
  updateOrchestrationState(input: UpdateOrchestrationStateInput): Promise<VcmOrchestrationState>;
}

export interface SendMessageInput extends SendRoleMessageRequest {
  repoRoot: string;
  stateRoot: string;
  handoffDir: string;
  taskSlug: string;
}

export interface MessageActionInput {
  repoRoot: string;
  stateRoot: string;
  taskSlug: string;
  messageId: string;
}

export interface UpdateOrchestrationStateInput extends OrchestrationStateInput {
  mode?: VcmOrchestrationMode;
  paused?: boolean;
}
```

Policy：

- `user -> project-manager` only with `user-request`。
- `project-manager -> architect/coder/reviewer` only with `task/question/review-request/revise/cancel`。
- `architect/coder/reviewer -> project-manager` only with `result/question/blocked/finding`。
- target session missing/running false -> `queued`。
- missing orchestration state -> `manual`, `paused: false`。
- manual mode -> `pending_approval`。
- manual stage -> write one-line prompt without trailing `\r`。
- auto mode and not paused -> write visible `[VCM MESSAGE]` envelope with trailing `\r`。
- never auto-confirm Claude Code permission prompts。

### 10.8 `src/backend/services/status-service.ts`

职责：

- 汇总 task、sessions、artifacts、events。
- 根据 handoff artifact status 计算 soft workflow gates：architecture、implementation、review、docs sync、PM final。
- 只提供下一步建议和 blocked/ready/complete 状态，不在 V1 硬拦截 role session 启动。

导出定义：

```ts
export interface TaskStatusReport {
  task: TaskRecord;
  sessions: RoleSessionRecord[];
  artifacts: ArtifactSummary;
  workflow: TaskWorkflowReport;
  warnings: string[];
}

export interface TaskWorkflowReport {
  currentStepId: "architecture-plan" | "implementation" | "review" | "docs-sync" | "final-acceptance";
  nextAction: string;
  blocked: boolean;
  steps: TaskWorkflowStep[];
}

export interface TaskWorkflowStep {
  id: TaskWorkflowReport["currentStepId"];
  label: string;
  status: "pending" | "blocked" | "ready" | "complete";
  detail: string;
  artifactPaths: string[];
}

export interface StatusService {
  getTaskStatus(repoRoot: string, taskSlug: string): Promise<TaskStatusReport>;
}

export interface StatusServiceDeps {
  taskService: TaskService;
  sessionService: SessionService;
  artifactService: ArtifactService;
}

export function createStatusService(deps: StatusServiceDeps): StatusService;
```

## 11. Backend API 层

### 11.1 `src/backend/server.ts`

职责：

- 创建 Fastify server。
- 注册 API routes。
- 注册 WebSocket terminal bridge。
- Serve frontend assets。

导出定义：

```ts
export interface CreateServerOptions {
  host?: string;
  port?: number;
  staticDir?: string;
  dev?: boolean;
}

export interface ServerDeps {
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: SessionService;
  artifactService: ArtifactService;
  commandDispatcher: CommandDispatcher;
  statusService: StatusService;
  runtime: TerminalRuntime;
}

export function createServer(deps: ServerDeps, options?: CreateServerOptions): Promise<FastifyInstance>;
export async function startServer(options?: CreateServerOptions): Promise<{ url: string; close(): Promise<void> }>;
```

### 11.2 `src/backend/api/project-routes.ts`

Routes：

```text
GET  /api/health
POST /api/projects/connect
GET  /api/projects/current
```

导出定义：

```ts
export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void;

export interface ProjectRouteDeps {
  projectService: ProjectService;
}
```

### 11.3 `src/backend/api/harness-routes.ts`

Routes：

```text
GET  /api/projects/harness
POST /api/projects/harness/apply
```

导出定义：

```ts
export function registerHarnessRoutes(app: FastifyInstance, deps: HarnessRouteDeps): void;

export interface HarnessRouteDeps {
  projectService: ProjectService;
  harnessService: HarnessService;
}
```

实现规则：

- `GET` 只返回 status 和 planned changes，不写文件。
- `POST /apply` 才写文件。
- `POST /apply` 只能改 VCM managed block 或创建缺失文件。
- 返回 changed files summary，供 GUI 提示用户 review/commit。

### 11.4 `src/backend/api/task-routes.ts`

Routes：

```text
GET  /api/tasks
POST /api/tasks
GET  /api/tasks/:taskSlug
GET  /api/tasks/:taskSlug/status
```

导出定义：

```ts
export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void;

export interface TaskRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  statusService: StatusService;
}
```

### 11.5 `src/backend/api/session-routes.ts`

Routes：

```text
GET  /api/tasks/:taskSlug/sessions
POST /api/tasks/:taskSlug/sessions/:role/start
POST /api/tasks/:taskSlug/sessions/:role/stop
POST /api/tasks/:taskSlug/sessions/:role/resume
POST /api/tasks/:taskSlug/sessions/:role/restart
POST /api/tasks/:taskSlug/sessions/:role/dispatch
```

导出定义：

```ts
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void;

export interface SessionRouteDeps {
  projectService: ProjectService;
  sessionService: SessionService;
  commandDispatcher: CommandDispatcher;
}
```

### 11.6 `src/backend/api/artifact-routes.ts`

Routes：

```text
GET /api/tasks/:taskSlug/artifacts
GET /api/tasks/:taskSlug/artifacts/:artifactName
GET /api/tasks/:taskSlug/role-commands/:role
PUT /api/tasks/:taskSlug/role-commands/:role
GET /api/tasks/:taskSlug/logs/:role
```

导出定义：

```ts
export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRouteDeps): void;

export interface ArtifactRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  artifactService: ArtifactService;
}
```

### 11.7 `src/backend/api/message-routes.ts`

Routes：

```text
GET  /api/tasks/:taskSlug/messages
POST /api/tasks/:taskSlug/messages
POST /api/tasks/:taskSlug/messages/:messageId/stage
POST /api/tasks/:taskSlug/messages/:messageId/approve
POST /api/tasks/:taskSlug/messages/:messageId/reject
GET  /api/tasks/:taskSlug/orchestration
PUT  /api/tasks/:taskSlug/orchestration
POST /api/tasks/:taskSlug/orchestration/pause
POST /api/tasks/:taskSlug/orchestration/resume
```

导出定义：

```ts
export function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps): void;

export interface MessageRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  messageService: MessageService;
}
```

实现规则：

- 所有 route 必须 require current project。
- 所有 message route 必须 load task，防止跨 taskSlug 注入。
- `PUT orchestration` 只接受 `manual` / `auto`。
- `stage` / `approve` 必须走 MessageService，不能直接写 terminal。
- route 不做 delivery policy；policy 集中在 MessageService。

### 11.8 `src/backend/ws/terminal-ws.ts`

职责：

- 处理 `/ws/tasks/:taskSlug/sessions/:role`。
- 将 runtime events 推送给前端。
- 将前端 input/resize 写回 runtime。

导出定义：

```ts
export interface TerminalWsDeps {
  projectService: ProjectService;
  sessionService: SessionService;
  runtime: TerminalRuntime;
}

export function registerTerminalWebSocket(server: FastifyInstance, deps: TerminalWsDeps): void;

export function parseClientTerminalMessage(raw: string): ClientTerminalMessage;
export function serializeServerTerminalMessage(message: ServerTerminalMessage): string;
```

## 12. Frontend 层

### 12.1 `src/frontend/main.tsx`

职责：

- 挂载 React app。

导出定义：

```ts
export function bootstrap(): void;
```

### 12.2 `src/frontend/app.tsx`

职责：

- 应用顶层路由和布局。

导出定义：

```tsx
export function App(): JSX.Element;
```

### 12.3 `src/frontend/state/api-client.ts`

职责：

- 封装 REST API。

导出定义：

```ts
export interface ApiClient {
  connectProject(input: ConnectProjectRequest): Promise<ProjectSummary>;
  getCurrentProject(): Promise<ProjectSummary | null>;
  getHarnessStatus(): Promise<HarnessStatusReport>;
  applyHarness(): Promise<HarnessApplyResult>;
  listTasks(): Promise<TaskRecord[]>;
  createTask(input: CreateTaskRequest): Promise<TaskRecord>;
  getTask(taskSlug: string): Promise<TaskRecord>;
  getTaskStatus(taskSlug: string): Promise<TaskStatusReport>;
  listSessions(taskSlug: string): Promise<RoleSessionRecord[]>;
  startRoleSession(taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  stopRoleSession(taskSlug: string, role: RoleName): Promise<RoleSessionRecord>;
  restartRoleSession(taskSlug: string, role: RoleName, input?: StartRoleSessionRequest): Promise<RoleSessionRecord>;
  dispatchRoleCommand(taskSlug: string, role: DispatchableRole): Promise<DispatchRoleCommandResult>;
  listArtifacts(taskSlug: string): Promise<ArtifactSummary>;
  readRoleCommand(taskSlug: string, role: DispatchableRole): Promise<string>;
  saveRoleCommand(taskSlug: string, role: DispatchableRole, content: string): Promise<void>;
  readLog(taskSlug: string, role: RoleName): Promise<string>;
  listMessages(taskSlug: string): Promise<VcmRoleMessage[]>;
  sendRoleMessage(taskSlug: string, input: SendRoleMessageRequest): Promise<SendRoleMessageResult>;
  stageMessage(taskSlug: string, messageId: string): Promise<VcmRoleMessage>;
  rejectMessage(taskSlug: string, messageId: string): Promise<VcmRoleMessage>;
  getOrchestrationState(taskSlug: string): Promise<VcmOrchestrationState>;
  updateOrchestrationState(taskSlug: string, input: { mode?: VcmOrchestrationMode; paused?: boolean }): Promise<VcmOrchestrationState>;
}

export function createApiClient(baseUrl?: string): ApiClient;
```

### 12.4 `src/frontend/terminal/terminal-client.ts`

职责：

- 封装 terminal WebSocket。

导出定义：

```ts
export interface TerminalClient {
  connect(): void;
  disconnect(): void;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  onMessage(listener: (message: ServerTerminalMessage) => void): Unsubscribe;
}

export function createTerminalClient(input: CreateTerminalClientInput): TerminalClient;

export interface CreateTerminalClientInput {
  taskSlug: string;
  role: RoleName;
  baseUrl?: string;
}
```

### 12.5 `src/frontend/terminal/xterm-view.tsx`

职责：

- 渲染 xterm.js。
- 连接 TerminalClient。
- 处理 fit、resize、input、output。

导出定义：

```tsx
export interface XtermViewProps {
  taskSlug: string;
  role: RoleName;
  active: boolean;
}

export function XtermView(props: XtermViewProps): JSX.Element;
```

### 12.6 `src/frontend/components/session-console.tsx`

职责：

- 展示单个 role session。
- 在 Start / Restart 上方提供三档权限模式选择。
- 未启动时显示 Start。
- 已启动时显示 terminal。

导出定义：

```tsx
export interface SessionConsoleProps {
  taskSlug: string;
  role: RoleName;
  session?: RoleSessionRecord;
  active: boolean;
  permissionMode: ClaudePermissionMode;
  onPermissionModeChange(mode: ClaudePermissionMode): void;
  onStart(role: RoleName): Promise<void>;
  onResume(role: RoleName): Promise<void>;
  onStop(role: RoleName): Promise<void>;
  onRestart(role: RoleName): Promise<void>;
}

export function SessionConsole(props: SessionConsoleProps): JSX.Element;
```

### 12.7 `src/frontend/components/role-session-tabs.tsx`

职责：

- 渲染 PM / Architect / Coder / Reviewer tabs。
- 展示 status badge。

导出定义：

```tsx
export interface RoleSessionTabsProps {
  activeRole: RoleName;
  sessions: RoleSessionRecord[];
  onRoleChange(role: RoleName): void;
}

export function RoleSessionTabs(props: RoleSessionTabsProps): JSX.Element;
```

### 12.8 `src/frontend/components/event-log.tsx`

职责：

- 展示产品级事件摘要。

导出定义：

```tsx
export interface EventLogProps {
  events: TerminalEvent[];
}

export function EventLog(props: EventLogProps): JSX.Element;
```

### 12.9 `src/frontend/components/message-timeline.tsx`

职责：

- 展示当前 task 的 VCM role messages。
- 显示 pending / queued / staged / delivered / failed / rejected 状态。
- 在 manual mode 下显示 approval cards。
- 提供 `Stage`、`Reject`、`Open target role` 操作。
- 显示 `Auto orchestration` toggle 和 pause/resume state。

导出定义：

```tsx
export interface MessageTimelineProps {
  messages: VcmRoleMessage[];
  orchestration: VcmOrchestrationState;
  busy: boolean;
  onStage(messageId: string): Promise<void>;
  onReject(messageId: string): Promise<void>;
  onModeChange(mode: VcmOrchestrationMode): Promise<void>;
  onPauseChange(paused: boolean): Promise<void>;
  onOpenRole(role: RoleName): void;
}

export function MessageTimeline(props: MessageTimelineProps): JSX.Element;
```

UI 规则：

- `manual` mode 是默认显示状态。
- `Stage` 只把一行提示写入 terminal，不触发 Enter。
- `auto` mode 必须显式打开，并可以随时 pause。
- failed delivery 必须显示 failure reason。

### 12.10 `src/frontend/routes/project-dashboard.tsx`

职责：

- 展示 repo 连接表单、任务列表和 harness health。
- 在 repo 连接后拉取 harness status。
- 展示 `Install / Update VCM Harness`，但只在用户点击后应用变更。
- 应用后展示 changed files summary 和 review/commit 提示。

导出定义：

```tsx
export function ProjectDashboard(): JSX.Element;
```

### 12.11 `src/frontend/components/harness-panel.tsx`

职责：

- 展示 `CLAUDE.md` 和 4 个 role agent 的 status。
- 展示每个文件的 action：`create` / `insert` / `update` / `ok`。
- 展示 planned changes。
- 提供 `View Planned Changes`、`Install / Update VCM Harness`、`Refresh`。
- 应用后提示用户 review diff 并提交独立 commit。

导出定义：

```tsx
export interface HarnessPanelProps {
  status: HarnessStatusReport | null;
  busy: boolean;
  onRefresh(): Promise<void>;
  onApply(): Promise<void>;
}

export function HarnessPanel(props: HarnessPanelProps): JSX.Element;
```

### 12.12 `src/frontend/routes/task-workspace.tsx`

职责：

- 任务运行时主界面。
- 组合 TaskNav、RoleSessionTabs、SessionConsole、MessageTimeline、EventLog。
- 不渲染独立 ArtifactPanel；handoff files 保留在任务目录中。

导出定义：

```tsx
export interface TaskWorkspaceProps {
  taskSlug: string;
}

export function TaskWorkspace(props: TaskWorkspaceProps): JSX.Element;
```

## 13. Templates

### 13.1 `src/backend/templates/handoff.ts`

导出定义：

```ts
export function renderArchitecturePlanTemplate(taskSlug: string): string;
export function renderImplementationLogTemplate(taskSlug: string): string;
export function renderValidationLogTemplate(taskSlug: string): string;
export function renderReviewReportTemplate(taskSlug: string): string;
```

### 13.2 `src/backend/templates/role-command.ts`

导出定义：

```ts
export function renderRoleCommandTemplate(taskSlug: string, role: DispatchableRole): string;
export function renderDispatchInstruction(commandPath: string): string;
```

`renderDispatchInstruction` 必须返回单行短指令：

```text
Please read and execute the role command at: <commandPath>
```

### 13.3 `src/backend/templates/message-envelope.ts`

导出定义：

```ts
export function renderMessageEnvelope(message: VcmRoleMessage): string;
export function renderManualStagePrompt(message: VcmRoleMessage): string;
```

`renderMessageEnvelope` 必须返回可见 envelope：

```text
[VCM MESSAGE]
id: msg_...
task: demo-task
from: project-manager
to: coder
type: task

<message body>

Artifact refs:
- .ai/handoffs/demo-task/architecture-plan.md

Instructions:
- Read the message and execute only within this VCM task.
- Reply to project-manager with vcmctl reply when complete, blocked, or unclear.
[/VCM MESSAGE]
```

`renderManualStagePrompt` 必须返回不带 trailing Enter 的短指令：

```text
Read and handle VCM message msg_123 at .ai/handoffs/demo-task/messages/msg_123.md
```

### 13.4 CLI Bridge

#### 13.4.1 `src/cli/vcmctl.ts`

职责：

- 给 Claude Code role sessions 提供调用 VCM backend 的本地命令。
- 读取 `VCM_API_URL`、`VCM_TASK_SLUG`、`VCM_ROLE`。
- 发送 PM task messages、非 PM replies、result messages。
- 查询 inbox。

命令：

```bash
vcmctl send --to coder --type task --body-file /tmp/vcm-message.md
vcmctl reply --type blocked --body "Need clarification on test scope."
vcmctl result --body-file /tmp/vcm-result.md --artifact .ai/handoffs/task/implementation-log.md
vcmctl inbox
vcmctl ready
```

规则：

- `send` 使用当前 `VCM_ROLE` 作为 sender。
- `reply` / `result` 默认发给 `project-manager`。
- CLI 不自行决定是否投递；它只调用 backend，policy 由 MessageService 执行。
- `vcmctl ready` 是显式 role readiness signal 的预留命令，可在后续 auto mode 阶段启用。

## 14. 核心调用链

### 14.1 启动应用

```text
main
  -> startServer
  -> create services/adapters/runtime
  -> register REST routes
  -> register terminal WebSocket
  -> serve frontend
```

### 14.2 连接 repo

```text
ProjectDashboard
  -> api.connectProject
  -> POST /api/projects/connect
  -> projectService.connectProject
  -> git.getRepoRoot
  -> git.getCurrentBranch
  -> git.isDirty
  -> claude.isAvailable
  -> fs.writeJsonAtomic(.vcm/config.json)
  -> api.getHarnessStatus
  -> GET /api/projects/harness
  -> harnessService.getHarnessStatus
  -> GUI shows missing/outdated VCM rules and planned changes
```

连接 repo 不自动修改 `CLAUDE.md` 或 `.claude/agents/*`。

```text
User clicks Install / Update VCM Harness
  -> api.applyHarness
  -> POST /api/projects/harness/apply
  -> harnessService.applyHarness
  -> create missing harness files or update VCM managed blocks
  -> GUI shows changed files summary
  -> GUI recommends review and commit
```

### 14.3 创建任务

```text
ProjectDashboard / TaskWorkspace
  -> api.createTask
  -> POST /api/tasks
  -> taskService.createTask
  -> assertValidTaskSlug
  -> artifactService.ensureHandoffStructure
  -> artifactService.createArtifactTemplates
  -> fs.writeJsonAtomic(.vcm/tasks/<task-slug>.json)
```

### 14.4 启动 role session

```text
SessionConsole Start
  -> api.startRoleSession
  -> POST /api/tasks/:taskSlug/sessions/:role/start
  -> sessionService.startRoleSession
  -> claude.buildRoleStartCommand
  -> runtime.createSession
  -> node-pty spawn
  -> registry.upsert
  -> write session metadata
```

### 14.5 Terminal 输入输出

```text
XtermView
  -> TerminalClient WebSocket
  -> input message
  -> terminal-ws
  -> runtime.write
  -> node-pty
  -> output event
  -> append role log
  -> WebSocket output message
  -> xterm.write
```

### 14.6 PM-mediated message bus

PM sends work:

```text
Project Manager terminal
  -> vcmctl send --to coder --type task --body-file /tmp/message.md
  -> POST /api/tasks/:taskSlug/messages
  -> messageService.sendMessage
  -> validateMessagePolicy(project-manager, coder, task)
  -> write .ai/handoffs/<task-slug>/messages/<message-id>.md
  -> append .vcm/messages/<task-slug>.jsonl
  -> manual mode: return pending_approval
  -> GUI shows approval card
```

User stages in manual mode:

```text
MessageTimeline Stage
  -> api.stageMessage
  -> POST /api/tasks/:taskSlug/messages/:messageId/stage
  -> messageService.stageMessage
  -> sessionService.getRoleSession(target)
  -> runtime.write(one-line prompt without Enter)
  -> append staged snapshot to .vcm/messages/<task-slug>.jsonl
```

Auto delivery:

```text
vcmctl send/reply/result
  -> messageService.sendMessage
  -> orchestration mode is auto
  -> not paused
  -> target session running
  -> runtime.write(renderMessageEnvelope(message) + "\r")
  -> append delivered snapshot
```

Role reply:

```text
Coder terminal
  -> vcmctl reply --type blocked --body-file /tmp/blocker.md
  -> MessageService validates coder -> project-manager
  -> PM receives pending/delivered message
```

### 14.7 Legacy role command dispatch

```text
Role toolbar Send Command
  -> api.dispatchRoleCommand
  -> POST /api/tasks/:taskSlug/sessions/:role/dispatch
  -> commandDispatcher.dispatchRoleCommand
  -> artifactService.readRoleCommand
  -> sessionService.getRoleSession
  -> runtime.write(short instruction)
  -> registry event
```

### 14.8 Handoff files

V1 主界面展示紧凑 workflow strip，用 artifact status 推导当前 gate 和下一步建议。完整 artifact inspector 仍不放在主界面；handoff files 和 role commands 仍由 backend templates / services 管理，供 Claude Code sessions 和 dispatch 流程使用。

## 15. 测试计划

### 15.1 Unit Tests

`tests/unit/shared/slug-check.test.ts`

- accepts valid task slugs。
- rejects uppercase、underscore、space、path traversal。
- suggests normalized slugs。

`tests/unit/shared/artifact-check.test.ts`

- parses headings。
- detects missing headings。
- validates handoff templates。
- validates `validation-log` not-run reason。

`tests/unit/backend/artifact-service.test.ts`

- creates handoff directory。
- creates role command files。
- does not overwrite existing files by default。
- returns artifact summary statuses。

`tests/unit/backend/command-dispatcher.test.ts`

- rejects missing command。
- rejects empty command。
- rejects not-started target session。
- writes only short instruction to runtime。

`tests/unit/backend/message-service.test.ts`

- accepts project-manager -> coder task messages。
- rejects non-PM role-to-role messages。
- persists message snapshots to `.vcm/messages/<task-slug>.jsonl`。
- writes long message bodies to `.ai/handoffs/<task-slug>/messages/<message-id>.md`。
- returns `pending_approval` in manual mode。
- stages one-line prompts without trailing Enter。
- delivers visible envelopes in auto mode only when target session is running and orchestration is not paused。

`tests/unit/backend/session-registry.test.ts`

- upserts sessions。
- finds by task + role。
- updates status。
- removes sessions。

`tests/unit/frontend/api-client.test.ts`

- unwraps successful API responses。
- throws useful errors for API failures。

`tests/unit/frontend/terminal-client.test.ts`

- serializes input and resize messages。
- dispatches output/status/exit messages to listeners。

### 15.2 Integration Tests

`tests/integration/api/project-routes.test.ts`

- connects repo fixture。
- writes `.vcm/config.json`。
- returns branch and dirty warning。

`tests/integration/api/task-routes.test.ts`

- creates task。
- writes `.vcm/tasks/<task-slug>.json`。
- creates handoff artifacts。

`tests/integration/runtime/node-pty-runtime.test.ts`

- starts a simple shell command fixture。
- streams output。
- writes log file。
- handles exit。

`tests/integration/api/session-routes.test.ts`

- starts role session with fake runtime。
- stops role session。
- restarts role session。
- sends and stages a VCM role message。
- dispatches legacy role command.

### 15.3 E2E Tests

`tests/e2e/task-workspace.spec.ts`

- open GUI。
- connect temp repo。
- create task。
- see Task Workspace。
- start fake project-manager session。
- see terminal output。
- switch to architect tab。
- see Start button。
- verify the main workspace has no right-side artifact panel。

V1 e2e 可以使用 fake Claude command，避免真实消耗 Claude Code tokens。

### 15.4 Manual Smoke Test

在真实 repo 中执行：

```text
npm install
npm run dev
open http://localhost:5173
Select repo
Create demo-task
Start project-manager
Start architect
Type in PM terminal
Run vcmctl send from PM or create a message through API
Stage the pending architect message from GUI
Verify logs/architect.log
Verify workflow strip and artifact status
Restart coder
Refresh browser
Verify session state recovers
```

## 16. 实施里程碑

### Milestone 1: Project Reshape and Local GUI Shell

文件：

- `package.json`
- `tsconfig.json`
- `tsconfig.node.json`
- `vite.config.ts`
- `src/main.ts`
- `src/backend/server.ts`
- `src/frontend/main.tsx`
- `src/frontend/app.tsx`
- `src/frontend/routes/project-dashboard.tsx`

验收：

- `npm run dev` 启动 backend + frontend。
- 浏览器打开 Project Dashboard。
- `/api/health` 返回 ok。

### Milestone 2: Shared Types, Validation, and Artifacts

文件：

- `src/shared/types/*.ts`
- `src/shared/validation/*.ts`
- `src/backend/templates/*.ts`
- `src/backend/services/artifact-service.ts`
- `src/backend/services/task-service.ts`
- `src/backend/api/task-routes.ts`

验收：

- GUI 可以创建 task。
- `.ai/handoffs/<task-slug>/` 被创建。
- Handoff artifacts 在任务目录中被创建。

### Milestone 3: Repo Connect and Project Service

文件：

- `src/backend/adapters/*.ts`
- `src/backend/services/project-service.ts`
- `src/backend/validation/environment-check.ts`
- `src/backend/api/project-routes.ts`
- `src/frontend/components/repo-connect-form.tsx`

验收：

- GUI 可以选择/输入 repo path。
- backend 检查 Git repo 和 Claude Code。
- `.vcm/config.json` 被创建。
- main/master 和 dirty state 显示 warning。

### Milestone 4: Embedded Terminal Runtime

文件：

- `src/backend/runtime/terminal-runtime.ts`
- `src/backend/runtime/node-pty-runtime.ts`
- `src/backend/runtime/session-registry.ts`
- `src/backend/ws/terminal-ws.ts`
- `src/frontend/terminal/terminal-client.ts`
- `src/frontend/terminal/xterm-view.tsx`
- `src/frontend/components/session-console.tsx`

验收：

- GUI 可以启动 fake role session。
- xterm.js 显示 output。
- 用户输入能写入 backend runtime。
- output 写入 raw log。
- resize 工作。

### Milestone 5: Role Session Cockpit

文件：

- `src/backend/services/session-service.ts`
- `src/backend/api/session-routes.ts`
- `src/frontend/components/role-session-tabs.tsx`
- `src/frontend/components/session-toolbar.tsx`
- `src/frontend/components/status-badge.tsx`
- `src/frontend/routes/task-workspace.tsx`
- `src/frontend/state/session-store.ts`

验收：

- PM / Architect / Coder / Reviewer tabs 可切换。
- 每个 role 可 start / stop / restart。
- 状态 badge 正确显示。
- 页面刷新后可重新加载 task/session 状态。

### Milestone 6: PM-mediated Message Bus

文件：

- `src/shared/types/message.ts`
- `src/backend/services/message-service.ts`
- `src/backend/api/message-routes.ts`
- `src/backend/templates/message-envelope.ts`
- `src/cli/vcmctl.ts`
- `src/frontend/components/message-timeline.tsx`
- `src/frontend/state/api-client.ts`
- `src/backend/services/command-dispatcher.ts`
- `src/frontend/components/event-log.tsx`

验收：

- PM 可以通过 `vcmctl send --to coder` 创建 message。
- backend 按 PM-mediated policy 拒绝非法 role-to-role messages。
- manual mode 默认创建 `pending_approval` message。
- 用户点击 `Stage` 后，backend 只写入一行 prompt，不按 Enter。
- role 可以通过 `vcmctl reply` 回 PM。
- messages 持久化到 `.vcm/messages/<task-slug>.jsonl`。
- long body 写入 `.ai/handoffs/<task-slug>/messages/<message-id>.md`。
- 旧 Send Command 仍可作为过渡调试能力，但不再是推荐主路径。

### Milestone 7: Acceptance and Hardening

内容：

- unit tests。
- integration tests。
- e2e smoke。
- README 更新。
- GUI 错误态。
- empty/missing/incomplete artifact 状态。
- Claude Code 缺失提示。
- process crashed 提示。

验收：

- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `npm run e2e` 通过或有明确 fake Claude 限制说明。

## 17. 最终 V1 验收清单

- [ ] GUI 可以启动。
- [ ] 用户可以连接本地 Git repo。
- [ ] GUI 显示 repo path、branch、dirty warning。
- [ ] 用户可以创建 task workspace。
- [ ] 系统创建 `.vcm/config.json`。
- [ ] 系统创建 `.vcm/tasks/<task-slug>.json`。
- [ ] 系统创建 `.ai/handoffs/<task-slug>/role-commands/`。
- [ ] 系统创建 `.ai/handoffs/<task-slug>/logs/`。
- [ ] 系统创建 architecture / implementation / validation / review artifact templates。
- [ ] GUI 显示 PM / Architect / Coder / Reviewer tabs。
- [ ] 用户可以启动 project-manager session。
- [ ] 用户可以启动 architect session。
- [ ] embedded terminal 可以显示 Claude Code output。
- [ ] 用户可以直接在 embedded terminal 中输入。
- [ ] terminal output 被保存到 role log。
- [ ] PM 可以通过 `vcmctl send` 给目标 role 创建 message。
- [ ] 非 PM role 只能通过 `vcmctl reply/result` 回 PM。
- [ ] MessageService 拒绝非法 role-to-role message。
- [ ] manual mode 下 message 默认进入 `pending_approval`。
- [ ] 用户可以从 GUI stage / reject pending message。
- [ ] Stage 只写入一行 prompt，不自动按 Enter。
- [ ] backend 不粘贴隐藏长 prompt；auto delivery 使用可见 `[VCM MESSAGE]` envelope。
- [ ] 用户可以 stop / restart role session。
- [ ] 页面刷新后可以恢复 task/session 可见状态。
- [ ] Claude Code 缺失时 GUI 有清晰提示。
- [ ] 进程 crashed/exited 时 GUI 有清晰提示。

## 18. 需要延后到 V2 的接口

V1 文件中可以预留类型或接口，但不实现完整功能：

- `ReviewAdapter`：后续接 Cross-Model Reviewer。
- `ValidationRunner`：后续自动运行 validation commands。
- `WorktreeManager`：后续实现 one task -> one branch -> one worktree。
- `SessionPersistenceService`：后续增强 backend lifecycle、session registry 持久化、raw log replay 和恢复体验。
- `DesktopShell`：后续用 Electron 或 Tauri 打包。
- `PermissionHookManager`：后续生成 role-specific Claude Code permission hooks。

V1 的判断标准是：

```text
少做智能判断
多做状态可见
少自动修改代码
多沉淀 artifacts
少解析终端语义
多保留 raw logs
少暴露终端编排细节
多提供 GUI 操作入口
```
