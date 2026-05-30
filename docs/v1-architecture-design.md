# VibeCodingMaster V1 架构设计方案

版本：v0.3
日期：2026-05-30
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
- 支持在每个 role session 旁开启 Translation Mode。
- 支持用 OpenAI-compatible 便宜模型把用户语言输入翻译成英文工程指令。
- 支持把 Claude Code 输出按类别翻译、摘要、保留或跳过，并在 Translation Panel 展示。
- 将 terminal output 持续保存为 raw logs。
- 在 GUI 中查看 role command 和 handoff artifacts。
- 通过 PM-mediated message bus 在角色间传递任务、问题、结果和 blocker。
- 在 manual mode 下让用户 stage / reject pending role messages。
- 展示 session 状态、artifact 状态、任务状态和下一步建议。
- 支持停止、重启、恢复单个 role session。

V1 的成功标准不是“能不能用命令控制多个终端”，而是：

> 用户是否可以不离开 GUI，就完成多 Claude Code sessions 的创建、切换、沟通、观察、日志保存和 handoff artifact 查看。

## 2. V1 非目标

V1 明确不做：

- SaaS 多用户协作。
- 企业权限和审计。
- 完整 Desktop 打包和自动更新。
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
  -> calls vcmctl send
  -> VibeCodingMaster backend validates policy
  -> backend persists a VCM role message
  -> manual mode: GUI asks user to stage/reject
  -> auto mode: backend writes visible envelope to target role terminal
  -> target role executes only within current task
  -> non-PM role replies to Project Manager through vcmctl
```

职责分离：

- PM 决定是否调度角色、调度谁、发送什么消息。
- Backend enforce sender / target / message type / task identity policy。
- GUI 让用户看见 message history、pending approvals、queue 和 failures。
- Backend 只在 manual stage 或 auto policy 通过时写入正确 role terminal。
- Role agent 执行消息并产出 handoff artifact。
- Handoff artifacts 和 `.vcm/messages/<task-slug>.jsonl` 是跨 session 的事实源。

兼容规则：

- `role-commands/<role>.md` 可以继续作为长 handoff artifact 使用。
- 旧的 `Send Command` dispatch 只能作为过渡辅助能力；稳定路径应迁移到 PM-mediated message bus。
- VCM 不允许角色直接写其他角色 PTY。
- VCM 不通过 terminal startup 注入长 messaging context；规则来自 repo-local `CLAUDE.md` / `.claude/agents/*` managed blocks。

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

### 3.8 Translation Sidecar, Not Source of Truth

Translation Mode 是 Session Console 的旁路辅助层，不是 Claude Code terminal 的替代品，也不是新的事实源。

架构规则：

- 左侧 xterm.js 始终显示原始 Claude Code terminal stream。
- 右侧 Translation Panel 只显示辅助翻译、摘要、跳过状态和英文 input preview。
- Translation Provider 独立于 Claude Code，默认使用 OpenAI-compatible `/chat/completions` API。
- 翻译 prompt 必须面向 Claude Code 工程场景，保留代码、路径、命令、flag、错误信息、标识符和 git refs。
- 用户输入翻译可以使用当前 role session 的上一条 Claude Code 自然语言输出作为上下文，但只翻译新输入。
- 每个 role session 必须有独立 FIFO output translation queue，避免并发翻译造成顺序错乱。
- output chunk 必须先分类：prose 翻译，code/diff/log/tool output/permission prompt 默认保留或摘要。
- 已经是用户目标语言或 CJK 的内容跳过翻译。
- 翻译失败只影响 Translation Panel，不影响 raw terminal、raw log、handoff artifacts 和 message bus。

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
- PM-mediated message bus。
- legacy role command dispatch。
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
              -> TranslationService
              -> TranslationProvider
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
│ Session State │ workflow strip + embedded terminal                           │
│ Known Issues  │ session ops                                                   │
│               │ input handled by terminal                                     │
├───────────────┴──────────────────────────────────────────────────────────────┤
│ Message Timeline: pending / queued / staged / delivered role messages        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Session Console

每个 role session 对应一个 console。

能力：

- 展示 role name。
- 展示 command，例如 `claude --agent architect`。
- 展示 xterm.js terminal viewport。
- 支持输入、复制、选择文本、resize。
- 支持 Translation Mode toggle。
- 开启 Translation Mode 后展示左右分栏：左侧 raw terminal，右侧 Translation Panel。
- Translation Panel 支持用户语言 composer、英文 preview、context indicator、source classification badge、retry 和 pause。
- 展示状态：not started / starting / running / waiting / blocked / done / crashed。
- 支持 start / stop / restart。
- 显示 raw log path。

### 6.4 Workflow Strip

V1 在 role tabs 下方展示紧凑的 workflow strip：

```text
Architecture -> Implementation -> Review -> Docs Sync -> PM Final
```

它是 soft gate，不是强制状态机。Backend 根据 handoff artifact status 计算当前 gate、下一步建议和 blocked/ready/complete 状态；GUI 只展示提示，不阻止用户手动启动或切换 role session。

### 6.5 Handoff Files

V1 不在主界面展示独立 artifact inspector。handoff artifacts 和 role commands 仍保存在任务目录中，作为 session 之间的文件级事实源；GUI 的主工作区优先展示 embedded terminal。

核心 handoff artifacts：

```text
architecture-plan.md
implementation-log.md
validation-log.md
review-report.md
docs-sync-report.md
```

### 6.6 Event Log

展示产品级事件，不展示完整 terminal stream。

示例：

```text
PM session started
PM sent coder task message
User staged coder message
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

### 7.5 Message Bus Delivery

V1 的稳定角色调度路径是 PM-mediated message bus。角色不直接写其他角色 PTY；角色通过 `vcmctl` 调用 backend，由 MessageService 校验 policy、持久化消息并决定是否投递。

任务身份以 VCM `taskSlug` 为准。Project Manager 必须只写入当前 task 的 canonical handoff directory：

```text
.ai/handoffs/<task-slug>/messages/<message-id>.md
.vcm/messages/<task-slug>.jsonl
```

如果 task slug 不符合用户意图，Project Manager 必须要求用户创建或选择正确的 VCM task，不能自行创建 `.ai/handoffs/<other-task>/` 来绕过当前 task。

Manual mode stage 示例：

```text
Read and handle VCM message msg_123 at .ai/handoffs/<task-slug>/messages/msg_123.md
```

Manual flow：

```text
vcmctl send / reply / result
  -> POST /api/tasks/:taskSlug/messages
  -> MessageService validates policy
  -> MessageService persists message
  -> GUI shows pending approval
  -> user clicks Stage
  -> backend writes one-line prompt without Enter
  -> user presses Enter in target embedded terminal
```

Auto flow：

```text
vcmctl send / reply / result
  -> MessageService validates policy
  -> orchestration mode is auto
  -> target session is running
  -> orchestration is not paused
  -> backend writes visible [VCM MESSAGE] envelope and appends Enter
```

Legacy `role-commands/<role>.md` dispatch can remain as a compatibility path for long handoff artifacts, but it is not the preferred orchestration mechanism.

### 7.6 Programmatic I/O Boundary

通过 `node-pty`，backend 技术上可以对 Claude Code session 做两类程序化操作：

```text
write input:
  runtime.write(sessionId, "Please read ...\r")

read output:
  runtime.subscribe(sessionId, listener)
```

V1 允许：

- 用户点击 `Stage` 后，backend 写入一行 message prompt。
- 用户点击旧 `Send Command` 后，backend 写入 legacy role command 短指令。
- 用户显式打开 auto mode 后，backend 在 policy 通过时写入可见 message envelope。
- 用户在 GUI terminal 中输入后，backend 转发输入。
- 用户在 Start / Restart 前选择 Claude Code 权限模式。
- backend 监听 output，写入 raw log。
- backend 根据进程退出、输出活动和用户操作更新轻量状态。
- backend 在 GUI 中提示 waiting / crashed / exited 等状态。

V1 不允许：

- 自动确认 Claude Code 权限提示。
- PM 绕过 MessageService 直接写其他 role terminal。
- Architect 绕过 PM 直接触发 Coder。
- Coder 绕过 PM 直接触发 Reviewer。
- 根据 terminal output 自动执行高风险下一步。

更高级的自动编排必须显式开启 auto mode，并带有人类 approval gate、审计日志和明确 stop conditions。

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

### 7.8 Translation I/O Boundary

Translation Layer 和 Terminal Runtime 的边界：

```text
terminal output:
  node-pty output
    -> raw log append
    -> terminal WebSocket to xterm.js
    -> TranslationService receives a copy when Translation Mode is on
    -> strip ANSI / classify / enqueue
    -> TranslationProvider translates or summarizes
    -> translation WebSocket to Translation Panel

user-language input:
  Translation Panel composer
    -> TranslationService zh-to-en / zh-to-en-with-context prompt slot
    -> optional context from last assistant prose chunk
    -> English preview
    -> user confirms
    -> runtime.write(role session pty, english + "\r")
```

边界规则：

- Raw terminal input path 不经过翻译；用户聚焦 xterm.js 时所有按键原样进入 Claude Code。
- Translation Panel 的 `Send English` 才会向 pty 写入英文输入。
- `auto-send` 只影响 Translation Panel composer，不影响 raw terminal。
- Permission prompt、password prompt、shell control characters 和快捷键不经过翻译。
- TranslationService 不写 handoff artifacts，不改 raw log，不改 message bus。
- API key 存在本机 app config 或后续 keychain，不进入 repo。

## 8. Repo Artifacts

V1 需要创建和维护：

```text
CLAUDE.md
.claude/
  agents/
    project-manager.md
    architect.md
    coder.md
    reviewer.md

.ai/
  handoffs/
    <task-slug>/
      role-commands/
        architect.md
        coder.md
        reviewer.md
      messages/
        <message-id>.md
      logs/
        project-manager.log
        architect.log
        coder.log
        reviewer.log
      architecture-plan.md
      implementation-log.md
      validation-log.md
      review-report.md
      docs-sync-report.md

.vcm/
  config.json
  tasks/
    <task-slug>.json
  sessions/
    <task-slug>.json
  messages/
    <task-slug>.jsonl
  orchestration/
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
      translation-panel.tsx
      translation-settings-modal.tsx
      event-log.tsx
      status-badge.tsx
    terminal/
      xterm-view.tsx
      terminal-client.ts
    state/
      api-client.ts
      task-store.ts
      session-store.ts
      translation-store.ts

  backend/
    server.ts
    api/
      project-routes.ts
      harness-routes.ts
      task-routes.ts
      session-routes.ts
      artifact-routes.ts
      message-routes.ts
      translation-routes.ts
    ws/
      terminal-ws.ts
      translation-ws.ts
    runtime/
      terminal-runtime.ts
      node-pty-runtime.ts
      session-registry.ts
    services/
      project-service.ts
      harness-service.ts
      task-service.ts
      session-service.ts
      artifact-service.ts
      command-dispatcher.ts
      status-service.ts
      message-service.ts
      translation-service.ts
    adapters/
      git-adapter.ts
      claude-adapter.ts
      filesystem.ts
      command-runner.ts
      translation-provider.ts
    validation/
      environment-check.ts
      artifact-check.ts
      slug-check.ts
    templates/
      handoff.ts
      role-command.ts
      message-envelope.ts
      harness/
        claude-root.ts
        project-manager-agent.ts
        architect-agent.ts
        coder-agent.ts
        reviewer-agent.ts
    types/
      project.ts
      task.ts
      session.ts
      role.ts
      message.ts
      artifact.ts
      terminal.ts
      translation.ts
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

### 9.8 HarnessService

职责：

- 检查 repo-level VCM Harness 是否存在、是否过期。
- 检查 `CLAUDE.md` 和 `.claude/agents/{project-manager,architect,coder,reviewer}.md`。
- 为缺失文件生成推荐默认内容。
- 对已有文件只插入或更新 VCM managed block。
- 生成 planned changes，让用户在写入前审阅。
- 写入后返回 changed files summary，并提示用户 review/commit。

Managed block 边界：

```md
<!-- VCM:BEGIN version=1 -->
...
<!-- VCM:END -->
```

HarnessService 不覆盖 managed block 之外的用户内容。

### 9.9 CommandDispatcher

职责：

- 读取 `role-commands/<role>.md`。
- 校验目标 role session 是否 running。
- 将短指令写入目标 terminal session。
- 记录 dispatch event。

原则：

- 不发送未落盘的长 prompt。
- 每次 dispatch 都必须有 role command artifact。
- 高风险 command 后续可增加用户确认 gate。

CommandDispatcher 是 role-command artifact 时代的过渡组件。V1 稳定路径应优先使用 MessageService；CommandDispatcher 保留用于用户显式点击旧 `Send Command` 或调试长 handoff artifact。

### 9.10 MessageService

职责：

- 提供 backend-mediated PM message bus。
- 验证 sender、target、message type、taskSlug 和当前 project。
- 禁止非 PM 角色直接互发消息。
- 持久化 `.vcm/messages/<task-slug>.jsonl`。
- 为长正文写入 `.ai/handoffs/<task-slug>/messages/<message-id>.md`。
- 管理 `.vcm/orchestration/<task-slug>.json`。
- 在 manual mode 下创建 `pending_approval` 消息。
- 在用户点击 `Stage` 时写入一行 terminal input，但不追加 Enter。
- 在 auto mode 下通过 policy check 后写入可见 `[VCM MESSAGE]` envelope 并提交。
- 记录 queued、delivered、staged、failed、rejected 等状态。

允许矩阵：

| Sender | Allowed target | Allowed message types |
| --- | --- | --- |
| user | project-manager | user-request |
| project-manager | architect / coder / reviewer | task, question, review-request, revise, cancel |
| architect | project-manager | result, question, blocked |
| coder | project-manager | result, question, blocked |
| reviewer | project-manager | result, finding, blocked |

Delivery policy：

- default mode 是 `manual`。
- target session 未 running 时，message 进入 `queued`。
- manual mode 下，message 进入 `pending_approval`。
- manual stage 只写入 `Read and handle VCM message ...`，不追加 `\r`。
- auto mode 下，如果 orchestration 未 paused 且 target running，写入 visible envelope 并追加 `\r`。
- 不自动确认 Claude Code 权限提示。
- 不自动发送超过一个 queued message 给同一 role。
- `blocked` message 必须回到 PM，由 PM 判断是否问用户或重新计划。

### 9.11 TranslationService

职责：

- 管理 Translation Mode 的 settings、session state 和 runtime subscriptions。
- 使用 OpenAI-compatible TranslationProvider。
- 把用户语言输入翻译成英文工程指令。
- 使用当前 role 的上一条 Claude Code prose output 作为可选上下文。
- 对 terminal output chunk 做 ANSI stripping、classification、secret redaction 和 CJK skip。
- 为每个 role session 维护 FIFO output translation queue。
- 向 Translation Panel 推送 `queued / translating / translated / summarized / preserved / skipped / failed` events。

内部组件：

```text
TranslationService
  -> TranslationSettingsStore
  -> TranslationPromptBuilder
  -> TerminalOutputClassifier
  -> LanguageDetector
  -> SecretRedactor
  -> PerRoleSerialQueue
  -> TranslationProvider
```

Provider contract：

```ts
interface TranslationProvider {
  testConnection(settings: TranslationSettings): Promise<TranslationProviderTestResult>;
  translate(input: TranslationRequest): Promise<TranslationResult>;
  streamTranslate?(input: TranslationRequest, onDelta: (delta: string) => void): Promise<TranslationResult>;
}
```

分类规则：

- `prose`：翻译。
- `error`：翻译说明，保留错误原文。
- `code` / `diff` / `stack-trace`：默认 preserved。
- `log` / `tool-output`：短内容 summarized，长内容 preserved with summary。
- `permission-prompt`：preserved，不自动回复。
- `already-target-language`：skipped。
- `sensitive`：redacted 或 skipped。

上下文规则：

- 只保留当前 role session 最近一条自然语言 output 作为 `lastAssistantText`。
- 上下文只用于 `zh-to-en-with-context` 消歧。
- 上下文不能写入 Claude Code terminal。
- 上下文不能进入 repo、handoff artifacts 或 raw logs。

## 10. API 设计

### 10.1 Project API

```text
GET  /api/health
POST /api/projects/connect
GET  /api/projects/current
GET  /api/projects/harness
POST /api/projects/harness/apply
```

`POST /api/projects/connect`：

```json
{
  "repoPath": "/path/to/repo"
}
```

`GET /api/projects/harness` 返回 repo harness status、planned changes、managed block version 和每个文件的建议动作。

`POST /api/projects/harness/apply` 只执行用户确认后的 VCM managed block 创建/插入/更新，并返回 changed files summary。

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

### 10.5 Message and Orchestration API

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

`POST /api/tasks/:taskSlug/messages`：

```json
{
  "fromRole": "project-manager",
  "toRole": "coder",
  "type": "task",
  "body": "Read the architecture plan and implement phase 1.",
  "artifactRefs": [
    ".ai/handoffs/fix-refund-coupon/architecture-plan.md"
  ]
}
```

返回：

```json
{
  "message": "{...VcmRoleMessage}",
  "delivered": false,
  "requiresUserApproval": true
}
```

`PUT /api/tasks/:taskSlug/orchestration`：

```json
{
  "mode": "manual",
  "paused": false
}
```

### 10.6 Terminal WebSocket

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

### 10.7 Translation API

```text
GET  /api/translation/settings
PUT  /api/translation/settings
POST /api/translation/test
POST /api/tasks/:taskSlug/sessions/:role/translation/input
POST /api/tasks/:taskSlug/sessions/:role/translation/retry/:translationId
POST /api/tasks/:taskSlug/sessions/:role/translation/clear
```

`POST /api/tasks/:taskSlug/sessions/:role/translation/input`：

```json
{
  "text": "继续，按照你刚才说的方案改",
  "mode": "review-before-send",
  "useContext": true,
  "send": false
}
```

返回：

```json
{
  "translation": "{...TranslationEntry}",
  "englishPreview": "Continue and implement the approach you just described.",
  "contextUsed": true,
  "requiresReview": true
}
```

当 `send: true` 且 policy 允许时，backend 在翻译完成后写入当前 role pty 并追加 Enter。`review-before-send` 默认使用 `send: false`。

### 10.8 Translation WebSocket

```text
WS /ws/tasks/:taskSlug/sessions/:role/translation
```

Server -> client：

```json
{ "type": "translation-entry", "entry": "{...TranslationEntry}" }
{ "type": "translation-delta", "id": "tr_123", "delta": "..." }
{ "type": "translation-status", "status": "ready" }
{ "type": "translation-error", "id": "tr_123", "message": "HTTP 429" }
```

Translation WebSocket 只推送右侧 Translation Panel 所需状态，不承载 raw terminal stream。

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

### 11.7 VcmRoleMessage

```json
{
  "id": "msg_123",
  "taskSlug": "fix-refund-coupon",
  "fromRole": "project-manager",
  "toRole": "coder",
  "type": "task",
  "body": "Read the architecture plan and implement phase 1.",
  "artifactRefs": [
    ".ai/handoffs/fix-refund-coupon/architecture-plan.md"
  ],
  "bodyPath": ".ai/handoffs/fix-refund-coupon/messages/msg_123.md",
  "status": "pending_approval",
  "createdAt": "2026-05-29T00:03:14+08:00",
  "deliveredAt": null,
  "stagedAt": null,
  "failureReason": null
}
```

状态枚举：

```text
pending_approval
queued
staged
delivered
acknowledged
failed
rejected
cancelled
```

Message type 枚举：

```text
user-request
task
question
blocked
result
finding
review-request
revise
cancel
```

### 11.8 VcmOrchestrationState

```json
{
  "taskSlug": "fix-refund-coupon",
  "mode": "manual",
  "paused": false,
  "updatedAt": "2026-05-29T00:03:14+08:00"
}
```

如果 `.vcm/orchestration/<task-slug>.json` 不存在，backend 必须返回：

```json
{
  "mode": "manual",
  "paused": false
}
```

### 11.9 TranslationSettings

```json
{
  "version": 1,
  "enabled": true,
  "providerType": "openai-compatible",
  "baseUrl": "https://api.example.com/v1",
  "model": "cheap-translation-model",
  "sourceLanguage": "auto",
  "targetLanguage": "zh-CN",
  "workingLanguage": "en",
  "inputMode": "review-before-send",
  "translateOutput": true,
  "translateUserInput": true,
  "contextEnabled": true,
  "preserveTechnicalTokens": true,
  "skipCjkText": true,
  "redactSecrets": true,
  "maxChunkChars": 4000,
  "requestTimeoutMs": 15000,
  "temperature": 0.1
}
```

规则：

- `apiKey` 不出现在 repo-local JSON 示例和导出中。
- API key 存在 local app config；后续可迁移到 OS keychain。
- Settings 可以全局生效，后续再支持 project override。

### 11.10 TranslationEntry

```json
{
  "id": "tr_123",
  "taskSlug": "fix-refund-coupon",
  "role": "coder",
  "direction": "cc-output-to-user",
  "sourceKind": "prose",
  "sourceLanguage": "en",
  "targetLanguage": "zh-CN",
  "sourceText": "I will inspect the failing tests first.",
  "translatedText": "我会先检查失败的测试。",
  "status": "translated",
  "contextUsed": false,
  "createdAt": "2026-05-29T00:03:14+08:00",
  "provider": "openai-compatible",
  "model": "cheap-translation-model",
  "tokenUsage": {
    "input": 12,
    "output": 14
  }
}
```

枚举：

```text
direction:
  user-input-to-english
  cc-output-to-user

promptKey:
  zh-to-en
  zh-to-en-with-context
  en-to-zh
  en-to-zh

sourceKind:
  prose
  code
  diff
  log
  tool-output
  permission-prompt
  error
  already-target-language
  sensitive

status:
  queued
  translating
  translated
  skipped
  failed
  redacted
  summarized
  preserved
```

TranslationEntry 默认只存在 backend/front-end runtime memory 中，用于显示、retry 和 clear；不写入 repo。

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
  -> run HarnessService.check
  -> show Harness Status and planned VCM changes
  -> show branch and dirty warning
```

VCM 不应在连接 repo 时静默写入 `CLAUDE.md` 或 `.claude/agents/*`。用户必须明确点击 `Install / Update VCM Harness` 后才写入。

### 12.2.1 安装或更新 VCM Harness

```text
User clicks Install / Update VCM Harness
  -> POST /api/projects/harness/apply
  -> create missing CLAUDE.md if needed
  -> create missing .claude/agents/*.md if needed
  -> insert or update VCM managed blocks in existing files
  -> preserve user content outside managed blocks
  -> return changed files summary
  -> GUI recommends review and commit
```

典型结果：

```text
created CLAUDE.md
created .claude/agents/project-manager.md
created .claude/agents/architect.md
updated .claude/agents/coder.md VCM block
created .claude/agents/reviewer.md
```

用户应在开始长期任务前 review diff，并提交一个独立 harness commit。

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

### 12.6 PM sends role message

```text
PM calls vcmctl send --to coder
  -> POST /api/tasks/<task-slug>/messages
  -> MessageService validates PM -> coder policy
  -> write .ai/handoffs/<task-slug>/messages/<message-id>.md
  -> append .vcm/messages/<task-slug>.jsonl
  -> if manual mode: GUI shows pending approval
  -> if auto mode: backend writes [VCM MESSAGE] envelope to coder pty
```

Manual stage:

```text
User clicks Stage
  -> MessageService checks target session
  -> backend writes "Read and handle VCM message ..." to target pty
  -> backend does not append Enter
  -> user presses Enter in embedded terminal
```

Role reply:

```text
coder calls vcmctl reply --type blocked
  -> MessageService validates coder -> project-manager policy
  -> PM sees the message
  -> PM decides whether to continue, replan, or ask the user
```

### 12.7 Legacy role-command dispatch

```text
PM may still write role-commands/<role>.md as a durable long handoff.
User can inspect the command file in the task directory when needed.
Old Send Command can write a short instruction to the target pty.
This is a transition path; message bus is the stable PM orchestration path.
```

### 12.8 查看 artifacts

```text
V1 main GUI renders compact workflow status derived from artifact checks.
The full artifact inspector remains out of scope for V1.
Handoff files remain available in the task directory and backend services.
```

### 12.9 重启 role session

```text
User clicks Restart coder
  -> backend stops existing coder pty if any
  -> preserves logs and artifacts
  -> starts new claude --agent coder
  -> updates session record
  -> frontend reconnects WebSocket
```

### 12.10 Translation Mode

开启 output translation：

```text
User toggles Translate on
  -> frontend checks TranslationSettings
  -> if missing provider: show Translation Settings
  -> open translation WebSocket for active role
  -> TranslationService subscribes to runtime output copy
  -> strip ANSI and buffer semantic chunks
  -> classify chunk
  -> skip CJK / preserve code-diff-log-tool output / translate prose
  -> enqueue per-role FIFO translation job
  -> push TranslationEntry to Translation Panel
```

用户语言输入：

```text
User types Chinese in Translation Panel
  -> POST /translation/input with useContext=true
  -> TranslationService loads lastAssistantText for this role
  -> TranslationProvider translates only the new user input
  -> GUI shows English preview
  -> User clicks Send English
  -> runtime.write(current role session, english + "\r")
```

Auto-send：

```text
User explicitly selects auto-send
  -> TranslationService translates input
  -> if no warning and role session is running
  -> runtime.write(current role session, english + "\r")
```

Raw terminal bypass：

```text
User focuses xterm.js
  -> terminal-ws input
  -> runtime.write raw bytes
  -> no translation path
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

### 13.5 docs-sync-report.md

最低标题：

```text
Summary
Architecture Drift Check
Docs Updated
Docs Reviewed And Left Unchanged
Public Contract / Module Boundary Notes
Remaining Documentation Risks
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

### 14.9 Translation Provider 未配置或失败

首次开启 Translation Mode 但 provider 未配置时：

```text
Translation provider is not configured.
Open Translation Settings to configure an OpenAI-compatible endpoint.
```

Provider 请求失败时：

- TranslationEntry 标记为 `failed`。
- Translation Panel 显示错误码、provider message 和 retry 操作。
- Raw terminal 和 raw log 不受影响。
- 连续失败时自动 pause output translation，避免循环请求。

### 14.10 Translation 分类或脱敏

检测到敏感内容时：

- sourceKind 标记为 `sensitive`。
- status 标记为 `redacted` 或 `skipped`。
- 不调用 Translation Provider。

检测到 code / diff / stack trace / permission prompt 时：

- 默认 status 标记为 `preserved`。
- Translation Panel 显示原文和简短说明。
- 不自动回复权限提示。

## 15. 安全和权限边界

V1 不是 sandbox。它是本地 GUI session orchestrator。

V1 必须明确提示：

- Claude Code 在用户当前 repo 环境运行。
- VCM 不拦截 Claude Code 的所有文件写入。
- GUI 中的 terminal 是真实 Claude Code session。
- 高风险任务仍需要 human approval。
- 角色隔离依赖 `.claude/agents/*`、Claude Code permissions、用户 review 和 handoff artifacts。
- Translation Provider 可能是第三方 API；开启 output translation 前必须提示用户 terminal output 会发送到 provider。
- Translation API key 不进入 repo、handoff artifacts、raw logs 或 git diff。
- 翻译层不得拦截 raw terminal keystrokes、权限确认、密码输入或 shell control characters。

V1 推荐但不强制：

- 项目提供 `CLAUDE.md`。
- 项目提供 `.claude/agents/project-manager.md`。
- 项目提供 `.claude/agents/architect.md`。
- 项目提供 `.claude/agents/coder.md`。
- 项目提供 `.claude/agents/reviewer.md`。
- 上述文件包含最新 VCM managed block。
- 项目配置 Claude Code permission hooks。

V1 可以提供 Harness Health 检查和用户确认后的 Harness Install / Update。VCM 只能管理自己的 VCM block；不应重写用户已有 role agent 内容。

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

### 16.7 Translation Provider Extensions

后续增强：

- OS keychain integration。
- project-level glossary。
- provider cost estimation。
- local model / vLLM profiles。

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

### Milestone 5: PM-mediated Message Bus

- message types and persistence。
- MessageService policy checks。
- message API。
- `vcmctl send/reply/result/inbox`。
- manual mode pending approvals。
- stage without pressing Enter。
- auto mode visible envelope delivery。
- legacy role command dispatch as compatibility path。

### Milestone 6: Translation Mode

- Translation shared types。
- Translation Provider settings。
- OpenAI-compatible provider client。
- Engineering translation prompts。
- User input translation with last assistant context。
- Per-role FIFO output translation queue。
- Output chunk classifier。
- CJK / target-language skip。
- Translation API and WebSocket。
- Translation Panel split view。
- Pause / retry / clear controls。

### Milestone 7: Acceptance Smoke

- one repo。
- one task。
- start project-manager。
- start architect。
- send architect command。
- verify output streams in GUI。
- enable Translation Mode。
- translate one user-language input to English preview and send it。
- verify prose output translation appears in the Translation Panel。
- verify code/log/tool-like output is preserved or summarized, not mistranslated。
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
9. PM 通过 `vcmctl send` 创建发给 architect 的 task message
10. GUI message timeline 显示 pending approval
11. 用户点击 Stage
12. architect session 收到一行 message prompt，用户按 Enter 后执行
13. architect raw output 写入 logs/architect.log
14. architect 可通过 `vcmctl reply` 回 PM
15. backend artifact check 可识别 architecture-plan.md missing / incomplete / ok
16. 用户可以 restart coder session
17. 页面刷新后能恢复 task/session 状态
18. 用户可以在 role session 旁开启 Translation Mode
19. 用户语言输入可以翻译成英文 preview，确认后发送给当前 role terminal
20. Claude Code prose output 可以在 Translation Panel 中按顺序显示翻译
21. code / diff / log / tool output 可以被保留或摘要，不被逐字误译
22. 已经是目标语言或 CJK 的 chunk 会跳过翻译
```

成功指标：

- GUI 启动成功。
- repo 连接成功。
- role session 创建成功。
- terminal input/output 稳定。
- raw logs 不丢。
- artifact 状态可见。
- PM-mediated message bus 可控。
- legacy role command dispatch 可兼容。
- 页面刷新后可恢复状态。
- Translation Provider 设置可测试。
- 翻译队列保持输出顺序。

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
- PM 只能通过 MessageService 发送 role message。
- 非 PM 角色只能回复 PM。
- manual mode 默认要求用户 stage / reject。
- auto mode 必须显式开启，并可以 pause。
- backend 记录 message snapshots 和 delivery state。

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
- 优先完成 SessionConsole、message timeline 和 session recovery。

### 19.8 翻译误导或成本失控

应对：

- 默认 review-before-send。
- 英文 preview 可编辑。
- 翻译 prompt 保留代码、路径、命令、错误信息、标识符和 git refs。
- 输出 chunk 先分类；code/diff/log/tool output 默认保留或摘要。
- 每个 role session 使用 FIFO queue，避免并发乱序。
- 已经是目标语言或 CJK 的内容跳过翻译。
- output translation 可 pause，失败可 retry，连续失败自动暂停。
- Translation Panel 始终提供原文引用。

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

只要 V1 能稳定做到 GUI task workspace、embedded Claude Code role sessions、terminal I/O、raw logs、PM-mediated message bus 和 handoff artifact checks，后续 Task Spec Builder、Validation Runner、Cross-Model Review、Worktree Manager、Desktop Packaging 和 session persistence hardening 才有可靠地基。
