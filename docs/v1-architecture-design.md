# VibeCodingMaster V1 架构设计方案

版本：v0.1  
日期：2026-05-29  
状态：架构设计草案  
依据：

- `docs/product-design.md`
- `docs/cc-best-practices.md`

## 1. V1 架构目标

VibeCodingMaster V1 只解决一个核心问题：

> 用本地 CLI 和 tmux 稳定管理一个任务中的多个 Claude Code role sessions，让 `project-manager`、`architect`、`coder`、`reviewer` 可以被启动、观察、下发命令、捕获输出，并通过 repo 内 handoff artifacts 完成交接。

V1 不追求完整 AI Project Manager 自动化，而是先把多 session 工程底座做稳。

核心能力：

- 连接本地 Git repo。
- 检查 `tmux` 和 Claude Code 是否可用。
- 为每个任务创建一个 tmux session。
- 为角色创建独立 tmux windows。
- 在每个 window 中启动对应 Claude Code role session。
- 创建 `.ai/handoffs/<task-slug>/` 和 `role-commands/`。
- 读取 Project Manager 产出的 role command artifact。
- 由 VibeCodingMaster controller 下发命令到目标 role window。
- 捕获 raw terminal output 并保存为 logs。
- 检查关键 handoff artifacts 是否存在。
- 展示 role session 状态。
- 支持用户 attach、stop、restart、recover。

## 2. V1 非目标

V1 明确不做：

- 产品层翻译管线。
- 自动生成完整 Task Spec。
- 自动 Preflight Review。
- 自动 Cross-Model Code Review。
- 自动识别 public contract / test contract。
- 自动执行 validation commands。
- 自动创建 PR。
- 多用户 SaaS。
- Web UI / Desktop UI。
- devcontainer sandbox。
- 多任务并行调度。
- 多 worktree 自动管理。

这些能力应在 V1 稳定后作为 V2/V3 能力演进。

## 3. 关键设计原则

### 3.1 Controller-Mediated

Project Manager agent 不直接控制其他 Claude Code sessions。

正确模型：

```text
Project Manager agent
  -> writes role command artifact
  -> VibeCodingMaster controller reads artifact
  -> controller sends command to target tmux window
  -> target role agent executes
  -> controller captures output
  -> controller writes raw log and checks handoff artifacts
  -> Project Manager reads logs/artifacts and summarizes to user
```

职责分离：

- PM 决定发什么 role command。
- VCM controller 决定把命令发到哪个 tmux window。
- Role agent 执行命令并产出 artifact。
- Handoff artifacts 是跨 session 的事实源。

### 3.2 File Handoff First

角色交接不依赖聊天记忆。所有关键结果必须进入：

```text
.ai/handoffs/<task-slug>/
```

终端输出只是调试信息；长期事实源是 handoff artifacts。

### 3.3 One Task, One Tmux Session

V1 默认：

```text
one task
  -> one tmux session
  -> multiple role windows
  -> one handoff directory
```

任务内的 `architect`、`coder`、`reviewer` 默认共享同一个 repo working directory。角色隔离由 role session、permissions、handoff files 和流程顺序实现，不在 V1 中为每个 role 创建独立 worktree。

### 3.4 Single-Writer Rule

同一个任务中，默认只有一个 write-capable role 在编辑代码。

推荐顺序：

```text
project-manager -> architect -> coder -> reviewer
```

允许并行的内容：

- read-only review。
- log analysis。
- artifact inspection。
- 用户 attach 查看。

不允许：

- `coder` 和 `reviewer` 同时大范围改代码。
- PM 直接替代 coder 实现复杂功能。
- reviewer 接管大范围实现。

### 3.5 State Can Be Rebuilt

V1 的状态必须能从三类来源恢复：

```text
tmux state
repo artifacts
local VCM metadata
```

不要把终端屏幕文本作为唯一状态源。

## 4. 技术栈选择

### 4.1 主语言

推荐使用：

```text
TypeScript + Node.js LTS
```

原因：

- 适合本地 CLI 和外部进程编排。
- 易于调用 `git`、`tmux`、`claude`。
- 处理 JSON、Markdown、文件系统、日志和终端输出方便。
- 后续可以复用类型和模块到 Web UI / Desktop UI。
- 与 VibeCodingMaster 后续产品形态兼容。

### 4.2 CLI 框架

推荐：

```text
commander 或 cac
```

V1 CLI 命令简单，优先选择轻量方案。

### 4.3 进程执行

推荐：

```text
execa
```

用途：

- 调用 `tmux`。
- 调用 `git`。
- 调用 `claude --version`。
- 调用 shell-safe command。

### 4.4 本地状态存储

V1 推荐先使用 JSON 文件，而不是 SQLite。

原因：

- V1 是 CLI-first，没有长期 daemon。
- 状态量小。
- 易于人工检查和恢复。
- 与 repo-local harness 理念一致。

推荐路径：

```text
.vcm/
  config.json
  tasks/
    <task-slug>.json
  sessions/
    <task-slug>.json
```

后续加入 Web UI、后台 daemon 或多任务并发后，再迁移到 SQLite。

### 4.5 Markdown 处理

V1 不需要复杂 Markdown AST。建议：

- 写入模板用字符串模板。
- artifact completeness 用标题存在性检查。
- 后续再引入 Markdown parser。

### 4.6 测试框架

推荐：

```text
Vitest
```

测试重点：

- slug/path 生成。
- tmux command 构造。
- role window naming。
- artifact schema 检查。
- session status 推断。
- recovery logic。

## 5. 进程架构

V1 采用 CLI 直接控制 tmux，不引入 daemon。

```text
User
  -> vcm CLI
      -> GitAdapter
      -> TmuxController
      -> ArtifactManager
      -> SessionRegistry
      -> StatusInspector
      -> tmux server
          -> vcm-<task-slug>
              -> project-manager window
                  -> claude --agent project-manager
              -> architect window
                  -> claude --agent architect
              -> coder window
                  -> claude --agent coder
              -> reviewer window
                  -> claude --agent reviewer
              -> monitor window
```

CLI 是一次性进程。tmux server 和 Claude Code sessions 在 CLI 退出后继续存在。

## 6. Tmux 结构

### 6.1 Session 命名

```text
vcm-<task-slug>
```

示例：

```text
vcm-fix-refund-coupon
```

### 6.2 Window 命名

固定 windows：

```text
0 project-manager
1 architect
2 coder
3 reviewer
4 monitor
```

### 6.3 启动命令

每个 role window 启动对应 Claude Code session：

```bash
claude --agent project-manager
claude --agent architect
claude --agent coder
claude --agent reviewer
```

monitor window 不启动 Claude Code。它用于显示任务状态、handoff 文件路径、attach 提示和最近日志位置。

### 6.4 tmux 操作

V1 需要封装以下 tmux 操作：

```text
hasSession(sessionName)
createSession(sessionName, cwd)
createWindow(sessionName, windowName, cwd)
sendKeys(sessionName, windowName, text)
capturePane(sessionName, windowName, lines)
pipePane(sessionName, windowName, logPath)
renameWindow(sessionName, oldName, newName)
killWindow(sessionName, windowName)
killSession(sessionName)
listWindows(sessionName)
attachCommand(sessionName)
```

长 role command 不直接粘贴到 tmux。V1 应先写入文件，再发送短命令让目标 role session 读取文件。

示例：

```text
Please read and execute this role command:
.ai/handoffs/<task-slug>/role-commands/architect-command.md
```

## 7. Repo Artifacts

V1 需要创建和维护：

```text
.ai/
  handoffs/
    <task-slug>/
      role-commands/
        architect-command.md
        coder-command.md
        reviewer-command.md
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
```

V1 可以不创建 `.ai/task-specs/`，但如果 Project Manager 已经生成 task spec，应在 task metadata 中记录路径。

## 8. 模块划分

推荐代码结构：

```text
src/
  cli/
    index.ts
    commands/
      init.ts
      task-new.ts
      tmux-start.ts
      tmux-attach.ts
      send.ts
      capture.ts
      status.ts
      stop.ts
      restart.ts

  core/
    task.ts
    roles.ts
    status.ts
    errors.ts

  adapters/
    git-adapter.ts
    tmux-adapter.ts
    claude-adapter.ts
    filesystem.ts

  services/
    project-service.ts
    task-service.ts
    session-service.ts
    artifact-service.ts
    command-dispatcher.ts
    capture-service.ts
    status-service.ts
    recovery-service.ts

  templates/
    handoff.ts
    role-command.ts
    monitor.ts

  validation/
    environment-check.ts
    artifact-check.ts
    slug-check.ts

  types/
    project.ts
    task.ts
    session.ts
    role.ts
```

### 8.1 CLI Commands

负责解析用户输入，并调用 service。

V1 命令：

```text
vcm init
vcm task new <task-slug>
vcm tmux start <task-slug>
vcm tmux attach <task-slug>
vcm send <task-slug> architect
vcm send <task-slug> coder
vcm send <task-slug> reviewer
vcm capture <task-slug> architect
vcm status <task-slug>
vcm restart <task-slug> <role>
vcm stop <task-slug>
```

### 8.2 GitAdapter

职责：

- 检查当前目录是否为 Git repo。
- 读取 repo root。
- 读取当前 branch。
- 检查 dirty state。
- 生成 diff summary。

V1 不自动创建 branch/worktree，但应提示：

- 不建议在 `main` 上执行 AI implementation。
- 工作区有未提交改动时启动前提醒用户。

### 8.3 TmuxAdapter

职责：

- 封装所有 tmux 命令。
- 处理 tmux 不存在、session 已存在、window 已存在等错误。
- 提供稳定的 session/window target 格式。
- 捕获 pane 输出。
- 开启 pipe-pane 写 raw log。

TmuxAdapter 不理解 VibeCodingMaster 业务流程，只提供终端控制能力。

### 8.4 ClaudeAdapter

职责：

- 检查 Claude Code 是否安装。
- 生成 role session 启动命令。
- 支持不同 role 的启动参数。
- 后续可扩展 permission mode、agent path、model profile。

V1 只需要：

```text
claude --agent <role>
```

### 8.5 ArtifactService

职责：

- 创建 handoff directory。
- 创建 `role-commands/` 和 `logs/`。
- 创建空 artifact 模板。
- 检查 artifact 是否存在。
- 检查 artifact 是否包含关键标题。
- 保存 role command。
- 记录 raw terminal logs 路径。

ArtifactService 是 V1 质量控制的核心。它确保角色之间不是靠屏幕输出交接。

### 8.6 SessionService

职责：

- 创建 task tmux session。
- 创建 role windows。
- 启动 role Claude Code sessions。
- 保存 session metadata。
- 恢复已存在 session。
- 停止 session。
- 重启指定 role window。

### 8.7 CommandDispatcher

职责：

- 读取 `role-commands/<role>-command.md`。
- 校验目标 role。
- 确认目标 tmux window 存在。
- 向目标 window 发送短指令。
- 记录 dispatch event。

原则：

- 不允许 PM agent 直接调用 tmux。
- 不发送未落盘的长 prompt。
- 每次 dispatch 都必须有 role command artifact。

### 8.8 CaptureService

职责：

- 捕获指定 role window 最近输出。
- 将 output append 到对应 raw log。
- 支持手动 capture。
- 支持 `tmux pipe-pane` 持续日志。

V1 不从 raw log 自动推断复杂结论，只做状态辅助。

### 8.9 StatusService

职责：

- 汇总 tmux session 状态。
- 汇总 role window 状态。
- 汇总 handoff artifact 状态。
- 展示最近 capture 时间。
- 展示 attach command。

状态来源：

```text
.vcm session metadata
tmux list-windows
tmux capture-pane
handoff artifacts
raw logs
```

### 8.10 RecoveryService

职责：

- CLI 重启后重新发现 tmux session。
- 对比 `.vcm/sessions/<task-slug>.json` 和实际 tmux windows。
- 标记 missing window。
- 支持重建单个 role window。
- 保留已有 logs 和 handoff artifacts。

## 9. 数据模型

### 9.1 ProjectConfig

```json
{
  "version": 1,
  "repoRoot": "/path/to/repo",
  "defaultRoles": ["project-manager", "architect", "coder", "reviewer"],
  "tmuxPrefix": "vcm",
  "handoffRoot": ".ai/handoffs",
  "stateRoot": ".vcm"
}
```

### 9.2 TaskRecord

```json
{
  "version": 1,
  "taskSlug": "fix-refund-coupon",
  "title": "Fix refund coupon behavior",
  "createdAt": "2026-05-29T00:00:00+08:00",
  "repoRoot": "/path/to/repo",
  "branch": "feature/refund-coupon",
  "handoffDir": ".ai/handoffs/fix-refund-coupon",
  "tmuxSession": "vcm-fix-refund-coupon",
  "status": "created"
}
```

### 9.3 SessionRecord

```json
{
  "version": 1,
  "taskSlug": "fix-refund-coupon",
  "tmuxSession": "vcm-fix-refund-coupon",
  "cwd": "/path/to/repo",
  "roles": {
    "project-manager": {
      "window": "project-manager",
      "command": "claude --agent project-manager",
      "logPath": ".ai/handoffs/fix-refund-coupon/logs/project-manager.log",
      "status": "running"
    },
    "architect": {
      "window": "architect",
      "command": "claude --agent architect",
      "logPath": ".ai/handoffs/fix-refund-coupon/logs/architect.log",
      "status": "idle"
    }
  }
}
```

### 9.4 RoleStatus

V1 状态枚举：

```text
not_started
starting
idle
running
waiting
blocked
done
missing
unknown
```

V1 很难可靠判断 Claude Code 内部状态，因此：

- `missing` 来自 tmux window 不存在。
- `not_started` 来自 metadata。
- `running/idle/waiting/blocked/done` 可以先由用户或命令显式标记。
- 自动推断只能作为 best-effort。

## 10. 核心工作流

### 10.1 初始化

```text
vcm init
  -> check git repo
  -> check tmux
  -> check claude
  -> create .vcm/config.json
  -> check .ai/handoffs
```

### 10.2 创建任务

```text
vcm task new <task-slug>
  -> validate slug
  -> create .ai/handoffs/<task-slug>/
  -> create role-commands/
  -> create logs/
  -> create artifact templates
  -> create .vcm/tasks/<task-slug>.json
```

### 10.3 启动 tmux session

```text
vcm tmux start <task-slug>
  -> read task record
  -> create tmux session vcm-<task-slug>
  -> create role windows
  -> start claude --agent <role>
  -> setup pipe-pane logs
  -> write session record
  -> show attach command
```

### 10.4 下发 role command

```text
vcm send <task-slug> architect
  -> read .ai/handoffs/<task-slug>/role-commands/architect-command.md
  -> validate command file exists and non-empty
  -> validate architect window exists
  -> send short instruction to architect window
  -> capture output snapshot
  -> update dispatch metadata
```

发送到 tmux 的短指令：

```text
Please read and execute the role command at:
.ai/handoffs/<task-slug>/role-commands/architect-command.md
```

### 10.5 捕获输出

```text
vcm capture <task-slug> architect
  -> tmux capture-pane
  -> append to logs/architect.log
  -> update lastCaptureAt
```

### 10.6 查看状态

```text
vcm status <task-slug>
  -> read task record
  -> read session record
  -> inspect tmux session/windows
  -> check handoff artifacts
  -> show role status table
```

示例输出：

```text
Task: fix-refund-coupon
Tmux: vcm-fix-refund-coupon
Attach: tmux attach -t vcm-fix-refund-coupon

Role              Window            Status     Artifact
project-manager   project-manager   running    -
architect         architect         done       architecture-plan.md exists
coder             coder             idle       implementation-log.md missing
reviewer          reviewer          not_started review-report.md missing
```

### 10.7 重启 role window

```text
vcm restart <task-slug> coder
  -> confirm role window restart
  -> preserve logs/artifacts
  -> kill coder window
  -> recreate coder window
  -> start claude --agent coder
  -> re-enable pipe-pane logging
```

### 10.8 停止任务 session

```text
vcm stop <task-slug>
  -> confirm
  -> kill tmux session
  -> keep .ai/handoffs
  -> keep .vcm task/session records
```

## 11. Artifact Schema Checks

V1 不判断内容质量，但必须检查关键 artifact 是否存在且包含必要标题。

### 11.1 architecture-plan.md

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

### 11.2 implementation-log.md

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

### 11.3 validation-log.md

最低要求：

```text
至少存在一个 validation entry，或明确说明 not run + reason。
```

### 11.4 review-report.md

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

## 12. 错误处理

### 12.1 tmux 不存在

`vcm init` 或 `vcm tmux start` 应失败并提示安装。

### 12.2 Claude Code 不存在

启动 role session 前失败，并提示用户安装或配置 `claude` 路径。

### 12.3 tmux session 已存在

默认不覆盖：

```text
session exists
  -> show attach command
  -> suggest vcm status
  -> require --force to recreate
```

### 12.4 role command 缺失

`vcm send` 必须失败：

```text
Missing .ai/handoffs/<task-slug>/role-commands/<role>-command.md
Ask project-manager to produce the role command first.
```

### 12.5 artifact 缺失

`vcm status` 显示 missing，不自动补写真实内容。

### 12.6 用户手动干预

用户 attach 后可能手动输入或关闭 window。V1 必须接受状态漂移：

- 下次 `vcm status` 重新检查 tmux。
- missing window 标记为 `missing`。
- 支持 `vcm restart`。
- 不覆盖已有 handoff artifacts。

## 13. 安全和权限边界

V1 不是 sandbox。它只是 role session orchestrator。

V1 必须明确提示：

- Claude Code 在用户当前 repo 环境运行。
- VCM 不拦截 Claude Code 的所有文件写入。
- 高风险任务仍需要 human approval。
- 角色隔离依赖 `.claude/agents/*`、Claude Code permissions、用户 review 和 handoff artifacts。

V1 推荐但不强制：

- 项目提供 `.claude/agents/project-manager.md`。
- 项目提供 `.claude/agents/architect.md`。
- 项目提供 `.claude/agents/coder.md`。
- 项目提供 `.claude/agents/reviewer.md`。
- 项目配置 Claude Code permission hooks。

V1 可以提供 `vcm doctor` 检查这些文件是否存在，但不自动生成复杂 role agents。

## 14. V1 命令详细设计

### 14.1 `vcm init`

职责：

- 检查 repo。
- 检查 `tmux`。
- 检查 `claude`。
- 创建 `.vcm/config.json`。
- 创建 `.ai/handoffs/`。

### 14.2 `vcm task new <task-slug>`

职责：

- 创建 task metadata。
- 创建 handoff 目录。
- 创建 role command 目录。
- 创建 logs 目录。
- 创建 artifact 模板。

### 14.3 `vcm tmux start <task-slug>`

职责：

- 创建 tmux session。
- 创建 role windows。
- 启动 Claude Code role sessions。
- 配置日志捕获。

### 14.4 `vcm send <task-slug> <role>`

职责：

- 读取 role command artifact。
- 将短执行指令发送到 role window。
- 记录 dispatch。

只支持：

```text
architect
coder
reviewer
```

默认不支持 PM 向自己发送命令。

### 14.5 `vcm capture <task-slug> <role>`

职责：

- 捕获窗口输出。
- 追加到 raw log。
- 显示最近输出。

### 14.6 `vcm status <task-slug>`

职责：

- 显示 session 状态。
- 显示 role window 状态。
- 显示 artifact 是否存在。
- 显示 attach command。

### 14.7 `vcm restart <task-slug> <role>`

职责：

- 重启指定 role window。
- 保留 logs 和 artifacts。
- 重新启动 `claude --agent <role>`。

### 14.8 `vcm stop <task-slug>`

职责：

- 停止任务 tmux session。
- 保留任务文件和日志。

## 15. 后续演进接口

V1 代码应预留这些抽象，但不完整实现：

### 15.1 Review Adapter

后续接入 Cross-Model Reviewer。

### 15.2 Validation Runner

后续自动运行 validation commands。

### 15.3 Worktree Manager

后续实现：

```text
one task -> one branch -> one worktree
```

但 V1 只做当前 repo working directory orchestration。

### 15.4 Web/Desktop UI

后续 UI 可以复用：

- session metadata。
- status service。
- tmux capture。
- artifact checks。

### 15.5 Permission / Hook Manager

后续生成 role-specific Claude Code permission hooks。

## 16. 实施顺序

### Milestone 1: CLI Skeleton

- TypeScript 项目初始化。
- `vcm init`。
- config 读写。
- environment check。

### Milestone 2: Task Artifacts

- `vcm task new`。
- handoff directory。
- artifact templates。
- task metadata。

### Milestone 3: Tmux Session

- `vcm tmux start`。
- 创建 session/windows。
- 启动 Claude Code roles。
- attach command。

### Milestone 4: Command Dispatch

- role command artifact 读取。
- `vcm send`。
- 防止长 prompt 直接粘贴。
- dispatch metadata。

### Milestone 5: Capture and Status

- `vcm capture`。
- raw logs。
- `vcm status`。
- artifact schema checks。

### Milestone 6: Recovery

- `vcm restart`。
- `vcm stop`。
- session discovery。
- missing window handling。

## 17. V1 验收标准

V1 完成时，应能在一个真实 repo 中演示：

```text
1. vcm init
2. vcm task new demo-task
3. vcm tmux start demo-task
4. project-manager window 启动成功
5. architect/coder/reviewer windows 启动成功
6. PM 产出 architect-command.md
7. vcm send demo-task architect
8. architect 输出被保存到 logs/architect.log
9. architecture-plan.md 被识别为 exists/missing
10. vcm status 能展示所有 role 状态
11. 用户可以 tmux attach 手动接管
12. vcm restart demo-task coder 能恢复 coder window
```

成功指标：

- session 创建成功率高。
- role windows 创建成功率高。
- role command 下发稳定。
- raw logs 不丢。
- artifact 状态可见。
- 用户 attach 后仍能恢复状态。

## 18. 主要风险和应对

### 18.1 tmux 自动化脆弱

应对：

- 长命令文件化。
- raw logs 全量保存。
- 状态以 artifacts 和 metadata 为准。
- 支持 attach 和 restart。

### 18.2 Claude Code 状态不可结构化

应对：

- V1 不深度解析 Claude Code 输出。
- 只提供 manual status 和 artifact status。
- 后续通过 structured reports 改进。

### 18.3 PM 误控其他 session

应对：

- PM 不直接操作 tmux。
- `vcm send` 必须读取 role command artifact。
- controller 记录 dispatch。

### 18.4 Handoff 空洞

应对：

- artifact schema check。
- status 中显示 missing/incomplete。
- reviewer 后续检查 handoff compliance。

### 18.5 用户在 main 分支上开发

应对：

- `vcm init` 和 `vcm tmux start` 提示当前 branch。
- 如果当前 branch 是 `main`，显示 warning。
- V1 不强制创建 branch，但强烈建议用户切到 task branch。

## 19. 架构判断

V1 的本质不是“自动写代码”，而是搭建一个可靠的 Claude Code 多角色控制台。

第一版应该保持克制：

```text
少做智能判断
多做状态可见
少自动修改代码
多沉淀 artifacts
少解析终端语义
多保留 raw logs
```

只要 V1 能稳定做到 task-level tmux session、role windows、role command dispatch、output capture 和 handoff artifact checks，后续 Task Spec Builder、Validation Runner、Cross-Model Review、Worktree Manager 和 Web UI 才有可靠地基。
