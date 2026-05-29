# VibeCodingMaster V1 架构设计方案

版本：v0.2  
日期：2026-05-29  
状态：架构设计草案  
依据：

- `docs/product-design.md`
- `docs/cc-best-practices.md`

## 1. V1 架构目标

VibeCodingMaster V1 只解决一个核心问题：

> 做一个本地 GUI Session Cockpit，让用户可以在一个任务工作台中启动、切换、查看、输入和管理多个 Claude Code role sessions。

V1 不再把 CLI 或手动终端管理作为主交互模式。CLI 可以保留为开发、调试和 smoke test 入口，但用户主流程必须在 GUI 中完成。

核心能力：

- 启动本地 GUI 应用。
- 连接或选择本地 Git repo。
- 检查 Claude Code 是否可用。
- 创建任务 workspace。
- 为任务创建 `.ai/handoffs/<task-slug>/`、`role-commands/`、`logs/`。
- 在 GUI 中展示 `project-manager / architect / coder / reviewer` role session tabs。
- 用 embedded terminal 承载每个 Claude Code role session。
- 支持用户在 GUI 内直接输入、确认权限、继续对话。
- 将 terminal output 持续保存为 raw logs。
- 在 GUI 中查看 role command 和 handoff artifacts。
- 从 GUI 将 role command 发送到目标 role session。
- 展示 session 状态、artifact 状态、任务状态和下一步建议。
- 支持停止、重启、恢复单个 role session。

V1 的成功标准不是“能不能用命令控制多个终端”，而是：

> 用户是否可以不离开 GUI，就完成多 Claude Code sessions 的创建、切换、沟通、观察、日志保存和 handoff artifact 查看。

## 2. V1 非目标

V1 明确不做：

- SaaS 多用户协作。
- 企业权限和审计。
- 完整 Desktop 打包和自动更新。
- 产品层翻译管线。
- 独立翻译模型调用。
- 自动生成完整 Task Spec。
- 自动 Preflight Review。
- 自动 Cross-Model Code Review。
- 自动识别 public contract / test contract。
- 自动执行 validation commands。
- 自动创建 PR。
- Jira / Linear / GitHub 双向同步。
- 云端 session 托管。
- 多 repo / 多任务并行调度。
- 多 worktree 自动管理。
- 让用户手动管理底层 terminal process。

这些能力应在 V1 的 GUI session cockpit 稳定后作为 V2/V3 能力演进。

## 3. 关键设计原则

### 3.1 GUI First

V1 的主入口是本地 GUI。用户应该通过页面完成：

- 选择 repo。
- 创建任务。
- 启动 role sessions。
- 切换 `project-manager / architect / coder / reviewer`。
- 直接在 session 面板中输入和查看输出。
- 查看 role command、logs、handoff artifacts 和状态。

CLI 只用于：

- 启动 dev server。
- 调试 backend。
- 导出状态。
- 执行自动化 smoke test。

### 3.2 Terminal Runtime Is Internal

Claude Code 本质上是交互式终端程序，V1 通过 embedded terminal 承载它。

用户不需要理解：

- pseudo-terminal。
- process id。
- terminal stream。
- WebSocket message。
- input/output bridge。

产品界面表达的是任务、角色、会话、artifact、状态和验收。

### 3.3 Controller-Mediated

Project Manager session 不直接无限制控制其他 Claude Code sessions。

正确模型：

```text
Project Manager session
  -> writes role command artifact
  -> GUI shows command artifact to user
  -> user approves or sends from GUI
  -> VibeCodingMaster backend writes short instruction to target role session
  -> target role session executes
  -> backend records raw log
  -> handoff artifact becomes stable result
```

职责分离：

- PM 决定发什么 role command。
- GUI 让用户看见、确认和发送。
- Backend 把短指令写入正确 role session。
- Role agent 执行命令并产出 artifact。
- Handoff artifacts 是跨 session 的事实源。

### 3.4 File Handoff First

角色交接不依赖聊天记忆。所有关键结果必须进入：

```text
.ai/handoffs/<task-slug>/
```

Terminal output 是调试信息；长期事实源是 handoff artifacts。

### 3.5 One Task, One Workspace

V1 默认：

```text
one task
  -> one GUI task workspace
  -> multiple role sessions
  -> one handoff directory
  -> one repo working directory
```

V1 不为每个 role 创建独立 worktree。角色隔离由 role session、role prompt、permissions、handoff files 和流程顺序实现。

### 3.6 Single-Writer Rule

同一个任务中，默认只有一个 write-capable role 在编辑代码。

推荐顺序：

```text
project-manager -> architect -> coder -> reviewer
```

允许并行：

- read-only review。
- log analysis。
- artifact inspection。
- 用户查看多个 session。

不允许：

- `coder` 和 `reviewer` 同时大范围改代码。
- PM 直接替代 coder 实现复杂功能。
- reviewer 接管大范围实现。

### 3.7 State Can Be Rebuilt

V1 的状态必须能从四类来源恢复：

```text
backend session registry
terminal process state
repo artifacts
local VCM metadata
```

不要把前端页面内存作为唯一状态源。

## 4. 技术栈选择

### 4.1 主语言

推荐：

```text
TypeScript + Node.js LTS
```

原因：

- 前后端共享类型。
- 适合本地 GUI、WebSocket 和进程编排。
- 易于调用 `git`、`claude`、文件系统和终端 runtime。
- 与后续 Desktop shell、Web UI 和自动化能力兼容。

### 4.2 前端

推荐：

```text
React + Vite
```

原因：

- 适合构建本地单页工作台。
- 与 xterm.js 集成成熟。
- 本地开发体验快。
- 后续可以被 Electron / Tauri / Desktop shell 包装。

前端核心依赖：

```text
@xterm/xterm
@xterm/addon-fit
@xterm/addon-web-links
```

### 4.3 后端

推荐：

```text
Node.js HTTP server + WebSocket
```

可选框架：

```text
Fastify 或 Express
ws
```

后端职责：

- 提供 REST API。
- 提供 terminal WebSocket。
- 管理 pseudo-terminal lifecycle。
- 读写 `.vcm` 和 `.ai/handoffs`。
- 执行 git / claude 环境检查。

### 4.4 Terminal Runtime

V1 推荐：

```text
node-pty
```

用途：

- 启动 `claude --agent <role>`，并按用户选择追加权限参数。
- 承载交互式输入输出。
- 支持 backend 程序化写入 input。
- 支持 backend 程序化监听 output。
- 支持 terminal resize。
- 支持退出码和进程状态。
- 配合 xterm.js 提供接近真实终端的 GUI 体验。

V1 的 terminal runtime 固定为：

```text
TerminalRuntime implementation = node-pty
```

后续持久性增强应优先改进 backend lifecycle、session registry、raw logs 和恢复体验。

### 4.5 进程执行

推荐：

```text
execa
```

用途：

- 调用 `git`。
- 调用 `claude --version`。
- 执行 shell-safe command。
- 不用于承载 Claude Code 交互式 session；交互式 session 由 `node-pty` 负责。

### 4.6 本地状态存储

V1 推荐 JSON 文件，而不是 SQLite。

推荐路径：

```text
.vcm/
  config.json
  tasks/
    <task-slug>.json
  sessions/
    <task-slug>.json
  app-state.json
```

原因：

- V1 是本地单用户。
- 状态量小。
- 易于检查和恢复。
- 与 repo-local harness 理念一致。

后续加入多任务并发、后台 daemon 或复杂查询后，再迁移到 SQLite。

### 4.7 Markdown 处理

V1 不需要复杂 Markdown AST。

建议：

- 写入模板用字符串模板。
- artifact completeness 用标题存在性检查。
- 前端预览用简单 Markdown renderer。
- 后续再引入 Markdown parser。

### 4.8 测试框架

推荐：

```text
Vitest
Playwright
```

测试重点：

- slug/path 生成。
- artifact schema 检查。
- session status 推断。
- REST API。
- WebSocket terminal bridge。
- role command dispatch。
- GUI task workspace smoke test。

## 5. 进程架构

V1 采用本地 Web GUI + 本地 Node backend。

```text
User
  -> Browser / Desktop shell
      -> React Task Workspace
      -> xterm.js Role Session Console
      -> WebSocket terminal bridge
      -> REST API
          -> Local Node backend
              -> GitAdapter
              -> ClaudeAdapter
              -> FileSystemAdapter
              -> ArtifactService
              -> TaskService
              -> SessionRegistry
              -> TerminalRuntimeManager
                  -> node-pty
                      -> claude --agent project-manager
                      -> claude --agent architect
                      -> claude --agent coder
                      -> claude --agent reviewer
```

Backend 是长生命周期本地进程。前端刷新后，应该能重新连接 backend 并恢复可见状态。

## 6. GUI 结构

### 6.1 Project Dashboard

职责：

- 显示已连接 repo。
- 显示 active tasks。
- 显示每个任务的 severity、required role route、session health。
- 显示 blocked tasks、recent validation failures、known issues、harness health。
- 提供进入 Task Workspace 的入口。

### 6.2 Task Workspace

V1 的主界面。

推荐布局：

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Header: repo / branch / task / severity / route / overall status            │
├───────────────┬──────────────────────────────────────────────────────────────┤
│ Task Nav      │ Role Sessions                                                │
│               │ tabs: PM | Architect | Coder | Reviewer                      │
│ Session State │ embedded terminal                                             │
│ Known Issues  │ session ops                                                   │
│               │ input handled by terminal                                     │
├───────────────┴──────────────────────────────────────────────────────────────┤
│ Event Log: PM wrote architect.md | Coder waiting for approval                │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Session Console

每个 role session 对应一个 console。

能力：

- 展示 role name。
- 展示 command，例如 `claude --agent architect`。
- 展示 xterm.js terminal viewport。
- 支持输入、复制、选择文本、resize。
- 展示状态：not started / starting / running / waiting / blocked / done / crashed。
- 支持 start / stop / restart。
- 显示 raw log path。

### 6.4 Handoff Files

V1 不在主界面展示独立 artifact inspector。handoff artifacts 和 role commands 仍保存在任务目录中，作为 session 之间的文件级事实源；GUI 的主工作区优先展示 embedded terminal。

### 6.5 Event Log

展示产品级事件，不展示完整 terminal stream。

示例：

```text
PM session started
PM wrote architect.md
User sent architect command
Architect wrote architecture-plan.md
Coder waiting for permission
Reviewer missing validation evidence
```

## 7. Terminal Runtime

### 7.1 Role Session 启动命令

每个 role session 启动对应 Claude Code：

```bash
claude --agent project-manager
claude --agent architect
claude --agent coder
claude --agent reviewer
```

### 7.2 TerminalRuntime 接口

V1 后端应抽象 terminal runtime，避免把 node-pty 写死到上层业务。

```ts
interface TerminalRuntime {
  createSession(input: CreateTerminalSessionInput): Promise<TerminalSession>;
  getSession(sessionId: string): TerminalSession | undefined;
  listSessions(taskSlug?: string): TerminalSessionSummary[];
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  stop(sessionId: string): Promise<void>;
  restart(sessionId: string): Promise<TerminalSession>;
  subscribe(sessionId: string, listener: TerminalEventListener): Unsubscribe;
}
```

### 7.3 node-pty 实现

`NodePtyTerminalRuntime` 负责：

- spawn `claude`。
- 设置 cwd 为 repo root。
- 设置 env。
- 捕获 stdout/stderr stream。
- 将 stream 推送给 WebSocket subscribers。
- 将 stream append 到 role log。
- 监听 exit code。
- 更新 session status。
- 支持 resize。

### 7.4 WebSocket Terminal Bridge

WebSocket 负责前后端双向通信。

推荐消息：

```json
{ "type": "input", "sessionId": "session_123", "data": "hello\n" }
{ "type": "resize", "sessionId": "session_123", "cols": 120, "rows": 32 }
{ "type": "output", "sessionId": "session_123", "data": "..." }
{ "type": "status", "sessionId": "session_123", "status": "running" }
{ "type": "exit", "sessionId": "session_123", "exitCode": 0 }
```

### 7.5 Role Command Dispatch

长 role command 不直接粘贴进 terminal。V1 应先写入文件，再向目标 session 发送短指令。

任务身份以 VCM `taskSlug` 为准。Project Manager 必须只写入当前 task 的 canonical handoff directory：

```text
.ai/handoffs/<task-slug>/role-commands/<role>.md
```

如果 task slug 不符合用户意图，Project Manager 必须要求用户创建或选择正确的 VCM task，不能自行创建 `.ai/handoffs/<other-task>/` 来绕过当前 task。

示例：

```text
Please read and execute the role command at: .ai/handoffs/<task-slug>/role-commands/architect.md
```

发送流程：

```text
GUI Send Command button
  -> POST /api/tasks/:taskSlug/sessions/:role/dispatch
  -> backend checks role command file exists, non-empty, and not placeholder/draft
  -> backend writes short instruction to terminal runtime
  -> backend records dispatch event
```

### 7.6 Programmatic I/O Boundary

通过 `node-pty`，backend 技术上可以对 Claude Code session 做两类程序化操作：

```text
write input:
  runtime.write(sessionId, "Please read ...\r")

read output:
  runtime.subscribe(sessionId, listener)
```

V1 允许：

- 用户点击 Send Command 后，backend 写入短指令。
- 用户在 GUI terminal 中输入后，backend 转发输入。
- 用户在 Start / Restart 前选择 Claude Code 权限模式。
- backend 监听 output，写入 raw log。
- backend 根据进程退出、输出活动和用户操作更新轻量状态。
- backend 在 GUI 中提示 waiting / crashed / exited 等状态。

V1 不允许：

- 自动确认 Claude Code 权限提示。
- PM 写完 command 后自动发送给下一个 role。
- Architect 完成后自动触发 Coder。
- Coder 完成后自动触发 Reviewer。
- 根据 terminal output 自动执行高风险下一步。

更高级的自动编排必须进入后续版本，并带有人类 approval gate、审计日志和明确 stop conditions。

### 7.7 Claude Code Permission Modes

V1 在 Task Workspace 的每个 role session 控制区提供三档权限模式：

```text
默认
  -> claude --agent <role>

bypassPermissions
  -> claude --agent <role> --permission-mode bypassPermissions

--dangerously-skip-permissions
  -> claude --agent <role> --dangerously-skip-permissions
```

规则：

- 权限模式是用户显式选择，不由 Project Manager 或 backend 自动切换。
- 权限模式只影响 Start / Restart 创建的新 Claude Code 进程。
- `RoleSessionRecord.permissionMode` 必须记录实际启动模式。
- GUI 显示实际 command，方便用户确认当前 session 的权限状态。

## 8. Repo Artifacts

V1 需要创建和维护：

```text
.ai/
  handoffs/
    <task-slug>/
      role-commands/
        architect.md
        coder.md
        reviewer.md
      logs/
        project-manager.log
        architect.log
        coder.log
        reviewer.log
      architecture-plan.md
      implementation-log.md
      validation-log.md
      review-report.md

.vcm/
  config.json
  tasks/
    <task-slug>.json
  sessions/
    <task-slug>.json
  app-state.json
```

V1 可以不自动创建 `.ai/task-specs/`，但如果 Project Manager 已经生成 task spec，应在 task metadata 中记录路径。

## 9. 模块划分

推荐代码结构：

```text
src/
  main.ts

  frontend/
    app.tsx
    routes/
      project-dashboard.tsx
      task-workspace.tsx
    components/
      app-shell.tsx
      task-nav.tsx
      role-session-tabs.tsx
      session-console.tsx
      event-log.tsx
      status-badge.tsx
    terminal/
      xterm-view.tsx
      terminal-client.ts
    state/
      api-client.ts
      task-store.ts
      session-store.ts

  backend/
    server.ts
    api/
      project-routes.ts
      task-routes.ts
      session-routes.ts
      artifact-routes.ts
    ws/
      terminal-ws.ts
    runtime/
      terminal-runtime.ts
      node-pty-runtime.ts
      session-registry.ts
    services/
      project-service.ts
      task-service.ts
      session-service.ts
      artifact-service.ts
      command-dispatcher.ts
      status-service.ts
    adapters/
      git-adapter.ts
      claude-adapter.ts
      filesystem.ts
      command-runner.ts
    validation/
      environment-check.ts
      artifact-check.ts
      slug-check.ts
    templates/
      handoff.ts
      role-command.ts
    types/
      project.ts
      task.ts
      session.ts
      role.ts
      artifact.ts
      terminal.ts
      api.ts

tests/
  unit/
  integration/
  e2e/
```

### 9.1 Frontend App

职责：

- 渲染 GUI。
- 调用 REST API。
- 连接 terminal WebSocket。
- 管理 active task 和 active role tab state。

### 9.2 SessionConsole

职责：

- 渲染 xterm.js。
- 连接指定 role session 的 WebSocket stream。
- 将用户输入写回 backend。
- 处理 resize。
- 显示 start / stop / restart 操作。

### 9.3 EventLog

职责：

- 展示任务级运行事件。
- 保持短日志形态，不占用 terminal 主视野。

### 9.4 Backend Server

职责：

- 提供 REST API。
- 提供 WebSocket endpoint。
- 管理 backend service lifecycle。
- Serve frontend static assets。

### 9.5 TerminalRuntimeManager

职责：

- 管理 role session 生命周期。
- 启动 Claude Code pty。
- 转发 terminal input/output。
- 保存 raw logs。
- 维护 runtime status。

### 9.6 SessionRegistry

职责：

- 保存当前 backend 进程中的 live sessions。
- 对比 `.vcm/sessions/<task-slug>.json`。
- 支持页面刷新后的 session 查询。
- 标记 crashed / exited / missing。

### 9.7 ArtifactService

职责：

- 创建 handoff directory。
- 创建 `role-commands/` 和 `logs/`。
- 创建 artifact 模板。
- 检查 artifact 是否存在。
- 检查 artifact 是否包含关键标题。
- 保存 role command。
- 追加 raw terminal logs。

### 9.8 CommandDispatcher

职责：

- 读取 `role-commands/<role>.md`。
- 校验目标 role session 是否 running。
- 将短指令写入目标 terminal session。
- 记录 dispatch event。

原则：

- 不发送未落盘的长 prompt。
- 每次 dispatch 都必须有 role command artifact。
- 高风险 command 后续可增加用户确认 gate。

## 10. API 设计

### 10.1 Project API

```text
GET  /api/health
POST /api/projects/connect
GET  /api/projects/current
GET  /api/projects/harness
```

`POST /api/projects/connect`：

```json
{
  "repoPath": "/path/to/repo"
}
```

### 10.2 Task API

```text
GET  /api/tasks
POST /api/tasks
GET  /api/tasks/:taskSlug
GET  /api/tasks/:taskSlug/status
```

`POST /api/tasks`：

```json
{
  "taskSlug": "fix-refund-coupon",
  "title": "Fix refund coupon behavior",
  "specPath": ".ai/task-specs/fix-refund-coupon.md"
}
```

### 10.3 Session API

```text
GET    /api/tasks/:taskSlug/sessions
POST   /api/tasks/:taskSlug/sessions/:role/start
POST   /api/tasks/:taskSlug/sessions/:role/stop
POST   /api/tasks/:taskSlug/sessions/:role/resume
POST   /api/tasks/:taskSlug/sessions/:role/restart
POST   /api/tasks/:taskSlug/sessions/:role/resize
POST   /api/tasks/:taskSlug/sessions/:role/dispatch
```

### 10.4 Artifact API

```text
GET /api/tasks/:taskSlug/artifacts
GET /api/tasks/:taskSlug/artifacts/:artifactName
GET /api/tasks/:taskSlug/role-commands/:role
PUT /api/tasks/:taskSlug/role-commands/:role
GET /api/tasks/:taskSlug/logs/:role
```

### 10.5 Terminal WebSocket

```text
WS /ws/tasks/:taskSlug/sessions/:role
```

Client -> server：

```json
{ "type": "input", "data": "..." }
{ "type": "resize", "cols": 120, "rows": 32 }
```

Server -> client：

```json
{ "type": "output", "data": "..." }
{ "type": "status", "status": "running" }
{ "type": "exit", "exitCode": 0 }
{ "type": "error", "message": "Claude Code is not available" }
```

## 11. 数据模型

### 11.1 ProjectConfig

```json
{
  "version": 1,
  "repoRoot": "/path/to/repo",
  "defaultRoles": ["project-manager", "architect", "coder", "reviewer"],
  "handoffRoot": ".ai/handoffs",
  "stateRoot": ".vcm",
  "terminalBackend": "node-pty",
  "claudeCommand": "claude"
}
```

### 11.2 TaskRecord

```json
{
  "version": 1,
  "taskSlug": "fix-refund-coupon",
  "title": "Fix refund coupon behavior",
  "createdAt": "2026-05-29T00:00:00+08:00",
  "updatedAt": "2026-05-29T00:00:00+08:00",
  "repoRoot": "/path/to/repo",
  "branch": "feature/refund-coupon",
  "handoffDir": ".ai/handoffs/fix-refund-coupon",
  "status": "created",
  "specPath": ".ai/task-specs/fix-refund-coupon.md"
}
```

### 11.3 RoleSessionRecord

```json
{
  "id": "session_architect_123",
  "claudeSessionId": "00000000-0000-4000-8000-000000000001",
  "taskSlug": "fix-refund-coupon",
  "role": "architect",
  "status": "running",
  "command": "claude --agent architect --permission-mode bypassPermissions",
  "permissionMode": "bypassPermissions",
  "cwd": "/path/to/repo",
  "terminalBackend": "node-pty",
  "pid": 12345,
  "logPath": ".ai/handoffs/fix-refund-coupon/logs/architect.log",
  "roleCommandPath": ".ai/handoffs/fix-refund-coupon/role-commands/architect.md",
  "handoffArtifactPath": ".ai/handoffs/fix-refund-coupon/architecture-plan.md",
  "startedAt": "2026-05-29T00:00:00+08:00",
  "lastOutputAt": "2026-05-29T00:03:14+08:00",
  "exitCode": null
}
```

### 11.4 TaskSessionRecord

```json
{
  "version": 1,
  "taskSlug": "fix-refund-coupon",
  "updatedAt": "2026-05-29T00:03:14+08:00",
  "roles": {
    "project-manager": {
      "id": "session_pm_123",
      "status": "running"
    },
    "architect": {
      "id": "session_architect_123",
      "claudeSessionId": "00000000-0000-4000-8000-000000000001",
      "status": "running",
      "record": "{...RoleSessionRecord}"
    },
    "coder": {
      "id": null,
      "status": "not_started"
    },
    "reviewer": {
      "id": null,
      "status": "not_started"
    }
  }
}
```

### 11.5 RoleStatus

V1 状态枚举：

```text
not_started
starting
running
waiting
blocked
done
resumable
crashed
exited
missing
unknown
```

V1 很难可靠判断 Claude Code 内部语义状态，因此：

- `not_started` 来自 metadata。
- `running` 来自 live pty。
- `exited/crashed` 来自 process exit。
- `missing` 来自 metadata 存在但 live process 不存在。
- `resumable` 来自 metadata 中存在 `claudeSessionId`，但当前没有 live pty。
- `waiting/blocked/done` 可以先由用户或 role output marker 显式标记。
- 自动推断只能作为 best-effort。

### 11.6 TerminalEvent

```json
{
  "id": "evt_123",
  "sessionId": "session_architect_123",
  "taskSlug": "fix-refund-coupon",
  "role": "architect",
  "type": "output",
  "timestamp": "2026-05-29T00:03:14+08:00",
  "data": "..."
}
```

## 12. 核心工作流

### 12.1 启动应用

```text
vcm dev 或桌面入口
  -> start local Node backend
  -> serve React frontend
  -> open browser / desktop shell
  -> show Project Dashboard
```

### 12.2 连接 repo

```text
User selects repo path
  -> POST /api/projects/connect
  -> check git repo
  -> check claude --version
  -> create .vcm/config.json
  -> create .ai/handoffs/
  -> show branch and dirty warning
```

### 12.3 创建任务 workspace

```text
User clicks New Task
  -> enter task slug / title
  -> POST /api/tasks
  -> create .ai/handoffs/<task-slug>/
  -> create role-commands/
  -> create logs/
  -> create artifact templates
  -> create .vcm/tasks/<task-slug>.json
  -> open Task Workspace
```

### 12.4 启动 role session

```text
User clicks Start project-manager
  -> POST /api/tasks/<task-slug>/sessions/project-manager/start
  -> NodePtyTerminalRuntime spawns claude --agent project-manager
  -> backend writes RoleSessionRecord
  -> frontend opens WebSocket
  -> xterm.js renders output
```

### 12.5 用户切换和沟通

```text
User clicks Architect tab
  -> frontend switches active role
  -> if session exists, subscribe to WebSocket
  -> if session not started, show Start button
  -> user types directly into terminal
```

### 12.6 下发 role command

```text
PM writes architect.md
  -> User can inspect the command file in the task directory when needed
  -> User clicks Send Command in the target role toolbar
  -> backend validates command file
  -> backend writes short instruction to architect pty
  -> backend records dispatch event
```

### 12.7 查看 artifacts

```text
V1 main GUI does not render artifact status.
Handoff files remain available in the task directory and backend services.
```

### 12.8 重启 role session

```text
User clicks Restart coder
  -> backend stops existing coder pty if any
  -> preserves logs and artifacts
  -> starts new claude --agent coder
  -> updates session record
  -> frontend reconnects WebSocket
```

## 13. Artifact Schema Checks

V1 不判断内容质量，但必须检查关键 artifact 是否存在且包含必要标题。

### 13.1 architecture-plan.md

最低标题：

```text
Architecture Summary
Task Classification
Required Role Route
Modules / Files
File Responsibilities
Public Surface Contract
Phases
Validation Per Phase
Risks
Stop Conditions
```

### 13.2 implementation-log.md

最低标题：

```text
Summary
Files Changed
Public Surface Changed
Tests Added / Updated
Validation Run
Deviations From Architecture Plan
Follow-ups
```

### 13.3 validation-log.md

最低要求：

```text
至少存在一个 validation entry，或明确说明 not run + reason。
```

### 13.4 review-report.md

最低标题：

```text
Summary
Role / Handoff Compliance
Scope Review
Architecture Review
Public Contract Review
Test Review
Validation Evidence
Findings
Decision
```

## 14. 错误处理

### 14.1 Claude Code 不存在

连接 repo 或启动 role session 前失败，并在 GUI 中提示：

```text
Claude Code command is not available.
Install Claude Code or configure the claude command path.
```

### 14.2 Repo 无效

`POST /api/projects/connect` 必须检查 Git repo。

失败时提示：

```text
Selected path is not a Git repository.
```

### 14.3 Role session 已存在

默认不重复启动。

GUI 显示：

- Focus existing session。
- Restart session。
- Stop session。

### 14.4 role command 缺失

发送 command 必须失败：

```text
Missing .ai/handoffs/<task-slug>/role-commands/<role>.md
Ask project-manager to produce the role command first.
```

### 14.5 role command 为空

发送 command 必须失败：

```text
Role command exists but is empty.
```

### 14.6 artifact 缺失

Backend artifact schema check 标记 missing，不自动补写真实内容。

### 14.7 进程崩溃

role session 进程异常退出时：

- 状态标记为 `crashed`。
- 保留 raw log。
- 显示 exit code。
- 提供 Restart。

### 14.8 页面刷新

页面刷新后：

- 前端重新请求 task/session 状态。
- 对 live session 重新建立 WebSocket。
- 对 missing live process 显示 `missing` 或 `exited`。

## 15. 安全和权限边界

V1 不是 sandbox。它是本地 GUI session orchestrator。

V1 必须明确提示：

- Claude Code 在用户当前 repo 环境运行。
- VCM 不拦截 Claude Code 的所有文件写入。
- GUI 中的 terminal 是真实 Claude Code session。
- 高风险任务仍需要 human approval。
- 角色隔离依赖 `.claude/agents/*`、Claude Code permissions、用户 review 和 handoff artifacts。

V1 推荐但不强制：

- 项目提供 `.claude/agents/project-manager.md`。
- 项目提供 `.claude/agents/architect.md`。
- 项目提供 `.claude/agents/coder.md`。
- 项目提供 `.claude/agents/reviewer.md`。
- 项目配置 Claude Code permission hooks。

V1 可以提供 Harness Health 检查这些文件是否存在，但不自动生成复杂 role agents。

## 16. 后续演进接口

V1 代码应预留这些抽象，但不完整实现：

### 16.1 Review Adapter

后续接入 Cross-Model Reviewer。

### 16.2 Validation Runner

后续自动运行 validation commands。

### 16.3 Worktree Manager

后续实现：

```text
one task -> one branch -> one worktree
```

V1 只做当前 repo working directory orchestration。

### 16.4 Session Persistence Hardening

后续增强：

- backend lifecycle 管理。
- session registry 持久化。
- raw log replay。
- 页面刷新和 backend 重启后的状态恢复。
- crashed / exited session 的恢复建议。

### 16.5 Desktop Shell

后续用 Electron 或 Tauri 包装本地 Web GUI。

### 16.6 Permission / Hook Manager

后续生成 role-specific Claude Code permission hooks。

## 17. 实施顺序

### Milestone 1: Local GUI Shell

- TypeScript monorepo / app 初始化。
- React + Vite frontend。
- Node backend。
- `vcm dev` 启动前后端。
- Project Dashboard。
- repo connect API。
- environment check。

### Milestone 2: Task Workspace and Artifacts

- Task Workspace 页面。
- `POST /api/tasks`。
- handoff directory。
- role command templates。
- artifact templates。
- artifact schema checks。

### Milestone 3: Embedded Terminal Runtime

- TerminalRuntime interface。
- NodePtyTerminalRuntime。
- WebSocket terminal bridge。
- xterm.js SessionConsole。
- start / stop / restart role session。
- raw logs。

### Milestone 4: Role Session Cockpit

- role session tabs。
- session status badges。
- reconnect after page refresh。
- event log。
- session registry。
- crash / exited handling。

### Milestone 5: GUI Role Command Dispatch

- role command viewer。
- Send Command button。
- backend dispatch API。
- short instruction write to pty。
- dispatch event recording。

### Milestone 6: Acceptance Smoke

- one repo。
- one task。
- start project-manager。
- start architect。
- send architect command。
- verify output streams in GUI。
- verify raw logs saved。
- verify artifact status shown。
- restart coder session。
- stop all sessions。

## 18. V1 验收标准

V1 完成时，应能在一个真实 repo 中演示：

```text
1. 打开 VibeCodingMaster GUI
2. 选择本地 Git repo
3. 创建 demo-task
4. Task Workspace 打开成功
5. project-manager session 在 embedded terminal 中启动
6. architect session 在另一个 tab 中启动
7. 用户可以在 GUI 中切换 PM / architect
8. 用户可以直接在 terminal 中输入和确认 Claude Code 提示
9. PM 产出 architect.md
10. 用户需要时可在任务目录查看 architect.md
11. 用户点击目标 role 的 Send Command
12. architect session 收到短指令并执行
13. architect raw output 写入 logs/architect.log
14. backend artifact check 可识别 architecture-plan.md missing / incomplete / ok
15. 用户可以 restart coder session
16. 页面刷新后能恢复 task/session 状态
```

成功指标：

- GUI 启动成功。
- repo 连接成功。
- role session 创建成功。
- terminal input/output 稳定。
- raw logs 不丢。
- artifact 状态可见。
- role command dispatch 可控。
- 页面刷新后可恢复状态。

## 19. 主要风险和应对

### 19.1 Claude Code 交互终端嵌入复杂

应对：

- 使用 xterm.js。
- 使用 node-pty。
- 保留 raw stream。
- 支持 resize。
- 支持权限确认和用户输入。

### 19.2 Session 持久性不足

应对：

- backend 持有 session registry。
- `.vcm/sessions` 保存每个 role 的完整 `RoleSessionRecord` 和 `claudeSessionId`。
- 首次启动使用 `claude --agent <role> --session-id <uuid>`。
- backend 重启或异常退出后，GUI 将旧 pty 标记为 `resumable`。
- Resume 使用 `claude --agent <role> --resume <uuid>` 创建新的 embedded terminal。
- raw logs 持续写入。
- 页面刷新重新订阅。
- 后续继续增强 backend lifecycle 和 raw log replay。

### 19.3 Claude Code 状态不可结构化

应对：

- V1 不深度解析 Claude Code 输出。
- 状态以 process state、用户显式标记、artifact state 为主。
- 后续通过 structured reports 改进。

### 19.4 PM 误控其他 session

应对：

- PM 不直接操作 runtime。
- dispatch 必须读取 role command artifact。
- GUI 展示 command 并由用户发送。
- backend 记录 dispatch event。

### 19.5 Handoff 空洞

应对：

- artifact schema check。
- backend status 可报告 missing/incomplete/ok。
- reviewer 后续检查 handoff compliance。

### 19.6 用户在 main 分支上开发

应对：

- repo connect 和 task create 时显示当前 branch。
- 如果当前 branch 是 `main` 或 `master`，显示 warning。
- V1 不强制创建 branch，但强烈建议用户切到 task branch。

### 19.7 GUI 复杂度过高

应对：

- V1 只做本地单用户。
- V1 只做一个 repo 的核心路径。
- V1 不做自动 review、validation runner、PR。
- 优先完成 SessionConsole、role dispatch 和 session recovery。

## 20. 架构判断

V1 的本质不是“自动写代码”，也不是“给终端包一层命令”。

V1 的本质是：

> 搭建一个可靠的本地 Claude Code 多角色 GUI 工作台，让多个 role sessions、handoff artifacts、logs 和状态在一个任务页面中变得可见、可切换、可沟通、可恢复。

第一版应该保持克制：

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

只要 V1 能稳定做到 GUI task workspace、embedded Claude Code role sessions、terminal I/O、raw logs、role command dispatch 和 handoff artifact checks，后续 Task Spec Builder、Validation Runner、Cross-Model Review、Worktree Manager、Desktop Packaging 和 session persistence hardening 才有可靠地基。
