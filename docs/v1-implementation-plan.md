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
  -> Send role command to target session from GUI
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
4. Role command 必须先落盘到 `.ai/handoffs/<task-slug>/role-commands/<role>.md`。
5. GUI 读取 role command，用户点击发送后，backend 只向目标 terminal 写入短指令。
6. Backend 可以程序化写入和监听 embedded terminal，但 V1 只允许用户触发的 command dispatch，不自动确认权限，不自动串联驱动角色。
7. Terminal output 只作为调试信息；长期事实源是 handoff artifacts。
8. Raw terminal stream 必须持续写入 `.ai/handoffs/<task-slug>/logs/<role>.log`。
9. V1 只做 artifact 存在性和标题完整性检查，不判断内容质量。
10. 状态必须能从 backend session registry、terminal process state、repo artifacts、`.vcm` metadata 恢复。
11. V1 不把每个 role 放到独立 worktree。同一任务默认共享当前 repo working directory。
12. V1 默认遵守 single-writer rule，但主要通过流程提示、role status 和 review gate 实现，不做强制 sandbox。

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
        role-command.ts
      validation/
        environment-check.ts

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
  | "review-report";

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
}

export interface ArtifactCheckResult {
  kind: ArtifactKind;
  path: string;
  exists: boolean;
  isEmpty: boolean;
  missingHeadings: string[];
  status: "missing" | "empty" | "incomplete" | "ok";
}

export interface ArtifactSummary {
  paths: HandoffPaths;
  checks: ArtifactCheckResult[];
}
```

### 6.8 `src/shared/types/api.ts`

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
- `command-dispatcher`：在用户点击 Send Command 后，向目标 session 写入短指令。

V1 允许的自动化边界：

- 用户在 GUI terminal 里的输入可以原样转发。
- 用户点击 Send Command 后，backend 可以写入 `Please read and execute the role command at: <path>`。
- Backend 可以监听 output 并写入 raw log。
- Backend 可以根据 output/exit event 更新轻量状态和 GUI 提示。

V1 明确不做：

- 不自动确认 Claude Code permission prompt。
- 不由 Project Manager 自动向 Architect/Coder/Reviewer 连续下发命令。
- 不由 Architect 输出自动触发 Coder。
- 不由 Coder 输出自动触发 Reviewer。
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

### 10.4 `src/backend/services/session-service.ts`

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

### 10.5 `src/backend/services/command-dispatcher.ts`

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
- Project Manager 启动时，backend 必须向 session 注入 task context，明确 `taskSlug`、`handoffDir` 和三个 role command 路径。
- 目标 role session 未运行时失败并提示启动 session。
- `instruction` 必须是短文本：
- 只有用户通过 GUI 点击 Send Command 时才调用 dispatch。
- dispatch 不解析 Claude Code 输出，不自动重试，不自动确认权限。
- dispatch 成功后只记录 event，不继续触发下一个 role。

```text
Please read and execute the role command at: <path>
```

### 10.6 `src/backend/services/status-service.ts`

职责：

- 汇总 task、sessions、artifacts、events。

导出定义：

```ts
export interface TaskStatusReport {
  task: TaskRecord;
  sessions: RoleSessionRecord[];
  artifacts: ArtifactSummary;
  warnings: string[];
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
GET  /api/projects/harness
```

导出定义：

```ts
export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void;

export interface ProjectRouteDeps {
  projectService: ProjectService;
}
```

### 11.3 `src/backend/api/task-routes.ts`

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

### 11.4 `src/backend/api/session-routes.ts`

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

### 11.5 `src/backend/api/artifact-routes.ts`

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

### 11.6 `src/backend/ws/terminal-ws.ts`

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

### 12.9 `src/frontend/routes/project-dashboard.tsx`

职责：

- 展示 repo 连接表单、任务列表和 harness health。

导出定义：

```tsx
export function ProjectDashboard(): JSX.Element;
```

### 12.10 `src/frontend/routes/task-workspace.tsx`

职责：

- 任务运行时主界面。
- 组合 TaskNav、RoleSessionTabs、SessionConsole、EventLog。
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

### 14.6 下发 role command

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

### 14.7 Handoff files

V1 主界面不展示 artifact 状态。handoff files 和 role commands 仍由 backend templates / services 管理，供 Claude Code sessions 和 dispatch 流程使用。

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
- dispatches role command.

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
Send architect command
Verify logs/architect.log
Verify artifact status
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

### Milestone 6: GUI Role Command Dispatch

文件：

- `src/backend/services/command-dispatcher.ts`
- `src/frontend/components/event-log.tsx`

验收：

- 用户点击目标 role toolbar 的 Send Command。
- backend 写入短指令到 architect runtime。
- dispatch event 出现在 Event Log。
- 不发送未落盘长 prompt。

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
- [ ] 用户可以从 GUI 发送 role command 到目标 role session。
- [ ] backend 只发送短指令，不粘贴完整长 prompt。
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
