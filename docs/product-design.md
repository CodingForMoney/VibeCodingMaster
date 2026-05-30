# VibeCodingMaster 产品设计文档

版本：v0.2
日期：2026-05-30
状态：产品设计草案
依据：`docs/cc-best-practices.md`

## 1. 产品定位

VibeCodingMaster 是面向 Claude Code 的本地 GUI 多 session 工作台，也是 AI Project Manager、Harness Manager 和 English Working Layer。

它把用户的自然语言需求转化为可计划、可执行、可验证、可审查、可沉淀的英文工程任务，并在一个图形化任务工作台中托管多个 Claude Code role sessions，让用户可以在 `project-manager`、`architect`、`coder`、`reviewer` 等 session 之间切换、沟通、观察输出、管理交接 artifact，并在需要时用便宜模型翻译 Claude Code 输入输出。

一句话：

> VibeCodingMaster 不是让用户手动管理一堆终端和 prompt，而是把多个 Claude Code sessions 放进一个可视化、有角色、有契约、有测试、有交接、有验收的本地工程工作台里。

核心闭环：

```text
user intent
  -> GUI task workspace
  -> project manager session clarification
  -> project manager command planning
  -> task severity classification
  -> task spec
  -> required role route
  -> role session cockpit
  -> role-specific command generation
  -> architecture plan
  -> public contract review
  -> Claude Code implementation
  -> validation
  -> independent AI review
  -> replan when needed
  -> PR / final acceptance
  -> project memory update
```

## 2. 产品背景

Claude Code 已经可以在真实项目中高效写代码，但复杂项目里的失败通常不是因为模型完全不会写代码，而是因为缺少工程控制层：

- 需求没有被澄清，Claude Code 直接开始改代码。
- 任务没有 scope、non-goals、public contract、test contract。
- 一个 session 同时承担架构、编码、测试、review，导致自我确认。
- 任务进度、实现偏差、验证结果和决策只留在聊天里，无法跨 session 延续。
- 文档、模块边界、测试策略和代码变化不同步。
- AI 发现了计划问题，但没有正式 Replan 协议，只能边做边改。
- 代码完成后缺少独立 reviewer 和验收清单。

最新最佳实践的核心判断是：

> AI coding reliability comes from two things: public contract design prevents architecture drift, and public contract tests prevent behavior drift.

VibeCodingMaster 的产品机会，就是把这条原则变成日常 AI 编程工作流。

## 3. 核心价值

### 3.1 对用户

- 用户可以用自然语言描述需求，不需要手写复杂 Claude Code prompt。
- 用户能在编码前看到清晰的实现方案和风险。
- 用户能知道 Claude Code 做了什么、为什么这么做、如何验证。
- 用户能把长期项目的经验沉淀到 repo，而不是沉没在聊天记录里。

### 3.2 对工程团队

- 降低 AI 编码带来的架构漂移。
- 降低行为回归和测试缺失。
- 让高风险任务进入更严格的角色路由和 human approval。
- 让 AI 生成代码具备可审计的任务、计划、验证和 review 证据。

### 3.3 对 Claude Code

- 给 Claude Code 提供正确上下文，而不是大量噪音。
- 把模糊需求转成明确 task spec。
- 用 public contract 限制可变范围。
- 用 contract tests 和 validation commands 提供可执行反馈。
- 用 handoff artifacts 跨 session 保留任务状态。

## 4. 目标用户

### 4.1 Solo Builder

已经使用 Claude Code 做大量开发，但经常遇到：

- 改错文件。
- 一次做太多。
- 上下文丢失。
- 测试没跑。
- 代码能跑但架构变形。

VibeCodingMaster 帮他把想法整理成小步、可验证、可回滚的任务。

### 4.2 Tech Lead

希望团队使用 Claude Code 提升吞吐量，但担心：

- 架构边界被打穿。
- 测试质量下降。
- public API 被随意修改。
- 高风险业务逻辑缺少审查。

VibeCodingMaster 提供角色制、contract gate、review gate 和最终验收流程。

### 4.3 Product-minded Founder

能表达产品意图，但不能稳定写出高质量工程 prompt。

VibeCodingMaster 把业务语言转成：

- task spec
- architecture plan
- public surface contract
- validation plan
- PR summary

## 5. 产品原则

### 5.1 Repo 是事实源

重要项目知识必须进入 repo，成为 Claude Code 可读取、可版本化、可 review 的 artifact。

核心 artifact：

```text
CLAUDE.md
docs/
.ai/task-specs/
.ai/handoffs/
.ai/state/
.ai/generated/
tools/
```

### 5.2 Public Contract 优先

普通 feature、bug fix、PR 不能只说“改哪些文件”，还要定义：

- public/exported functions
- public methods
- module APIs
- service / controller / repository public entry points
- route handlers / command handlers
- hooks
- externally used component props

VibeCodingMaster 必须在编码前帮助用户锁定这些公共边界。

### 5.3 Public Contract Tests 是验收底线

新增或修改 public function 必须有契约测试。

最低要求：

- happy path
- boundary or failure path

高风险业务还需要：

- invalid input
- permission or state constraints
- side effects
- idempotency
- historical regressions

### 5.4 角色分离

复杂任务中，不允许一个 Claude Code session 同时拥有架构、编码、最终测试和独立 review。

默认角色链：

```text
project manager -> architect -> coder -> reviewer -> human approval
```

### 5.5 文件交接，不靠聊天记忆

角色之间通过 handoff artifacts 交接：

```text
.ai/handoffs/<task-slug>/
  architecture-plan.md
  implementation-log.md
  validation-log.md
  review-report.md
```

聊天记录可以辅助理解，但不能作为长期事实源。

### 5.6 Replan 是正式流程

当计划和代码现实不一致时，不能悄悄改方向。

VibeCodingMaster 必须触发：

```text
Stop
  -> Explain blocker
  -> Compare approved plan with code reality
  -> List options
  -> Recommend new plan
  -> Ask approval if scope or risk changed
  -> Update docs
  -> Continue
```

### 5.7 流程按风险分级

VibeCodingMaster 不是让所有任务都变重，而是按任务风险选择流程重量。

小任务要快，复杂任务要稳，高风险任务要有硬 gate。

### 5.8 GUI 是主交互入口

V1 的主入口不是 CLI，而是本地 GUI 工作台。

用户应该通过页面完成：

- 选择本地 repo。
- 从最近访问的 repo path 下拉列表中重新连接项目，最多保留 5 个最近路径。
- 创建任务。
- 启动或停止 role sessions。
- 切换 `project-manager / architect / coder / reviewer`。
- 直接在 session 面板里和 Claude Code 沟通。
- 查看 role command、handoff artifacts、logs、状态和风险。

CLI 可以作为开发、调试或自动化入口保留，但不能成为 V1 的主要用户体验。

### 5.9 终端是能力，不是产品界面

Claude Code 本质上仍然是交互式终端程序，VibeCodingMaster 可以使用 embedded terminal 来承载它。

但用户不应该被迫理解：

- pseudo-terminal。
- process id。
- terminal stream。
- WebSocket message。
- input/output bridge。

这些只应该是底层实现细节。产品界面表达的是任务、角色、会话、状态、artifact 和验收。

### 5.10 PM-mediated Role Messaging

VibeCodingMaster 的角色通信模型是：

```text
User <-> Project Manager <-> Other Roles
```

产品不应该变成一个所有角色两两互聊的 agent chat room。

规则：

- 用户主要和 `project-manager` 交流。
- `project-manager` 可以通过 VCM message bus 给 `architect`、`coder`、`reviewer` 分配任务或提出问题。
- 非 PM 角色只能把结果、问题、阻塞和 findings 回给 `project-manager`。
- 如果一个非 PM 角色需要另一个角色协助，必须先回到 PM，由 PM 决定是否继续调度。
- 用户必须始终能查看 message history、切换 role terminal、暂停自动编排并手动介入。

Message bus 和自动执行是两个不同能力：

- `manual`：默认模式。角色可以发消息，但 VCM 不自动让目标 terminal 执行；用户查看后点击 `Stage`，VCM 只把一行提示写进目标 terminal，用户按 Enter 才执行。
- `auto`：可选模式。VCM 在 backend policy 通过、目标 session running、编排未暂停时，可以把可见 message envelope 直接写入目标 terminal 并提交。

无论哪种模式，VCM 都不能自动确认 Claude Code 权限提示，也不能绕过高风险 human approval。

### 5.11 English Working Layer

Claude Code 在英文工程上下文里通常更稳定：代码标识符、错误日志、依赖文档、GitHub issue、测试输出和架构术语大多以英文存在。VCM 应提供一个低成本模型驱动的 English Working Layer，让用户可以继续用自己的语言表达，但让 Claude Code 主要接收英文工程指令、英文 handoff artifacts 和英文技术上下文。

核心规则：

- repo 内长期保存的工程 artifact 默认使用英文。
- role command、VCM role message、architecture plan、implementation log、validation log、review report 默认使用英文。
- 用户可以在 GUI 中用中文或其他语言输入。
- VCM 使用独立、便宜、可配置的大模型把用户输入转换为英文工程指令，再发送给 Claude Code。
- VCM 使用同一个翻译通道持续把 Claude Code terminal output 转成用户语言，帮助用户理解执行过程。
- 翻译结果是辅助视图，不是事实源；事实源仍是 terminal raw log、handoff artifacts、git diff 和 validation evidence。

VCM 只借鉴现有轻量翻译工具中的这些产品策略：

- 使用 OpenAI-compatible Translation Provider，让用户接入便宜模型。
- 使用面向 Claude Code 的工程化翻译 prompt，保留代码、路径、命令、flag、错误信息、标识符和 git refs。
- 翻译用户输入时带上当前 role 的上一条 Claude Code 回复作为上下文，处理“继续”“按你说的改”“那个文件”等省略表达。
- 每个 role session 使用独立 FIFO 翻译队列，避免输出片段并发翻译导致乱序。
- 对输出做分类处理：自然语言翻译；代码、diff、日志、tool output、权限提示等默认保留原文或摘要，不做逐字误译。
- 对已经是用户语言或 CJK 的内容直接跳过翻译，避免来回翻译损坏含义。

这不是“让 Project Manager 承担翻译职责”。翻译是 VCM GUI/Backend 的辅助能力，由独立 Translation Provider 完成；Project Manager 仍专注需求澄清、任务拆分、角色调度和验收。

## 6. 核心概念

### 6.1 Project Manager

VibeCodingMaster 的核心角色是 Project Manager。

Project Manager 是面向用户的沟通者，也是面向 AI 角色的指令调度者。它不只是记录流程，而是负责把用户的业务语言逐步转成其他角色可以准确执行的命令。

它负责：

- 和用户对话，澄清需求。
- 把用户输入整理成 task brief 和 task spec。
- 判断任务严重级别。
- 选择 required role route。
- 决定下一步应该调用 architect、coder、reviewer 还是 specialist。
- 为每个角色准备准确、完整、边界清楚的 role command。
- 通过 VCM message bus / `vcmctl send` 调度角色，而不是要求用户复制 prompt。
- 确保 handoff artifacts 存在。
- 调度 Claude Code 的 architect、coder、reviewer session。
- 收集 validation evidence。
- 判断是否需要 Replan。
- 维护项目状态和最终验收。

它不应该成为一个“什么都自己做”的 coding session。

它发给其他角色的命令必须包含：

- role identity
- task spec path
- required input artifacts
- allowed scope
- public surface contract
- test contract
- stop conditions
- validation commands
- expected output artifact path
- escalation / Replan triggers

换句话说：

```text
Project Manager = user-facing conversation owner + role message orchestrator
```

它负责让每个 AI 角色“收到正确任务”，但不替代该角色完成任务。

### 6.1.1 VCM Message Bus

VCM Message Bus 是 PM 调度角色的产品主干。它不是文件监听器，也不是让角色直接写入其他 PTY；角色通过本地 `vcmctl` 调用 VCM backend API，backend 负责 policy check、持久化和投递。

推荐流程：

```text
project-manager Claude Code session
  -> vcmctl send --to coder --type task --body-file ...
  -> VCM backend MessageService
  -> persist message
  -> policy check
  -> manual mode: show approval card
  -> auto mode: write visible envelope to coder terminal

coder Claude Code session
  -> vcmctl reply --type blocked --body-file ...
  -> VCM backend MessageService
  -> persist message
  -> policy check
  -> manual mode: show approval card
  -> auto mode: write visible envelope to project-manager terminal
```

允许的最小通信矩阵：

| Sender | Allowed target | Allowed message types |
| --- | --- | --- |
| user | project-manager | user-request |
| project-manager | architect / coder / reviewer | task, question, review-request, revise, cancel |
| architect | project-manager | result, question, blocked |
| coder | project-manager | result, question, blocked |
| reviewer | project-manager | result, finding, blocked |

禁止：

- `coder -> architect`
- `architect -> coder`
- `reviewer -> coder`
- 任意角色伪造其他 task identity
- 任意角色为非当前 `taskSlug` 发消息

每条消息都必须可审计，至少持久化到：

```text
.vcm/messages/<task-slug>.jsonl
.ai/handoffs/<task-slug>/messages/<message-id>.md
```

### 6.1.2 Translation Assistant

Translation Assistant 是 embedded terminal 的旁路辅助层。它不替代 Claude Code terminal，也不伪装成 Claude Code 的一部分。

职责：

- 将用户语言输入转换为英文 terminal instruction。
- 将 Claude Code terminal output 持续转换为用户语言解释。
- 保留英文原文和翻译结果的对应关系。
- 使用上一条 Claude Code 回复作为可选上下文，提高短句、省略句和指代词的翻译质量。
- 用工程化 prompt 保留代码块、路径、命令、错误信息和标识符。
- 按 session 串行处理输出翻译，保持右侧翻译流与左侧 terminal 时序一致。
- 对已经是目标语言或 CJK 的内容跳过翻译。
- 避免把 ANSI control sequences、密码、token、二进制输出、超长日志原样发送给翻译模型。
- 在翻译不确定时标记 low confidence，并提示用户查看左侧英文原文。

基本交互：

```text
User writes Chinese in Translation Panel
  -> Translation Provider produces English instruction
  -> user reviews English preview by default
  -> VCM writes English instruction to Claude Code pty
  -> Claude Code outputs English
  -> Translation Provider translates output chunks to Chinese
  -> GUI shows translated stream in the right panel
```

Translation Assistant 有两种输入模式：

- `review-before-send`：默认。用户输入先翻译成英文预览，用户点击 Send 后才写入 Claude Code terminal。
- `auto-send`：可选。用户输入后自动翻译并发送给 Claude Code，适合低风险连续对话。

翻译策略：

- `zh-to-en-with-context` 使用当前 role 的 recent assistant output 作为 context，但 context 只用于消歧，不能把旧回复内容混入新指令。
- `en-to-zh` 必须先分类，再决定翻译、摘要、保留原文或跳过。
- `tool-output`、`code`、`diff`、`stack-trace`、`permission-prompt` 默认不逐字翻译。
- 每个 role session 的 output translation queue concurrency 固定为 1。
- 翻译失败只影响右侧 Translation Panel，不影响左侧 Claude Code terminal。

Raw Terminal Mode 必须始终可用：

- 当用户直接聚焦左侧 embedded terminal 时，键盘输入原样进入 Claude Code。
- 权限确认、方向键、快捷键、shell 控制字符、密码输入等不经过翻译。
- 翻译层不得拦截或改写 raw terminal keystrokes。

### 6.2 Task Spec

Task Spec 是用户需求进入工程系统的入口。

建议路径：

```text
.ai/task-specs/<task-slug>.md
```

标准结构：

```md
# Task Spec

## Goal
## Background
## Scope
## Non-goals
## Task Severity
## Required Role Route
## Handoff Directory
## Relevant Files
## File Responsibilities
## Public Surface Contract
## Test Contract
## Architecture Constraints
## Stop Conditions
## Expected Behavior
## Validation Commands
## Definition of Done
## Risks
## Questions
```

### 6.3 Architecture Plan

Architecture Plan 是 architect role 的输出。

建议路径：

```text
.ai/handoffs/<task-slug>/architecture-plan.md
```

它定义：

- task classification
- required role route
- modules and files
- file responsibilities
- public surface contract
- dependency direction
- data flow
- phases
- validation per phase
- rollback / replan triggers
- risks
- docs to update

### 6.4 Implementation Log

Implementation Log 是 coder role 的输出。

建议路径：

```text
.ai/handoffs/<task-slug>/implementation-log.md
```

它记录：

- files changed
- public surface changed
- tests added / updated
- validation run
- deviations from architecture plan
- follow-ups

### 6.5 Validation Log

Validation Log 是任务级验证证据。

建议路径：

```text
.ai/handoffs/<task-slug>/validation-log.md
```

它是单个任务的权威验证记录。  
`.ai/state/validation-log.md` 只是跨任务滚动索引。

### 6.6 Review Report

Review Report 是 reviewer role 的输出。

建议路径：

```text
.ai/handoffs/<task-slug>/review-report.md
```

它必须覆盖：

- role / handoff compliance
- scope review
- architecture review
- public contract review
- test review
- missing tests added
- validation evidence
- docs sync
- findings
- decision

### 6.7 Role Command

Role Command 是 Project Manager 为某个 AI 角色准备的 durable handoff artifact。

它不是普通聊天 prompt，而是由结构化上下文编译出来的任务命令。

V1 的稳定调度路径是 VCM message bus：PM 通过 `vcmctl send` 把任务消息发给目标角色，message 可以引用 role command artifact。旧的 GUI `Send Command` 只作为过渡和调试路径，不能成为长期主交互。

Role Command 的输入：

- user intent
- task spec
- required role route
- architecture plan
- public surface contract
- test contract
- handoff paths
- validation requirements
- stop conditions
- current task state

Role Command 必须写入当前 VCM task 的 canonical handoff directory：

```text
.ai/handoffs/<task-slug>/role-commands/<role>.md
```

Project Manager 不得为同一个 VCM task 创建或使用另一个 `.ai/handoffs/<other-task>/` 目录。如果 task slug 不对，Project Manager 必须停下来要求用户创建或选择正确的 VCM task。

Role Command 的输出形式：

```text
Start the architect role for task <task-slug>.

Read:
- <task spec path>
- <relevant docs>

Produce:
- .ai/handoffs/<task-slug>/architecture-plan.md

Rules:
- define public surface contract
- define test contract
- do not edit production code
- stop and escalate if ...
```

VibeCodingMaster 应保存 Role Command，方便后续审计、复现和优化；真正的角色间投递状态以 `.vcm/messages/<task-slug>.jsonl` 为准。

## 7. 任务分级与角色路由

VibeCodingMaster 根据任务类型自动推荐 role route。

| 等级 | 任务类型 | 示例 | 推荐路由 |
| --- | --- | --- | --- |
| T0 | trivial | 文案、注释、无行为变化的小配置 | `coder`，可选 review checklist |
| T1 | small scoped change | 单文件 bug、简单测试、已知模式修复 | `coder -> fresh review` 或 `coder -> reviewer` |
| T2 | ordinary feature | 有边界的多文件 feature、普通 PR | `architect -> coder -> reviewer -> architect docs sync -> PM commit/PR` |
| T3 | cross-module / architectural | 跨模块改动、重构、新 public surface | `architect -> coder -> reviewer -> architect docs sync -> PM commit/PR` |
| T4 | high-risk | auth、permission、payment、billing、schema、public API、security | `architect -> specialist -> coder -> reviewer -> architect docs sync -> human approval -> PM commit/PR` |
| T5 | large rewrite / greenfield | 新子系统、大迁移、长期重构 | `architect`，然后每个 phase 循环 `coder -> reviewer -> architect docs sync`，阶段或任务边界由 PM commit/PR |

当分类不明确时，选择更严格的路由。

V1 GUI 先提供软流程提示：根据 handoff artifacts 是否存在、是否仍是占位内容、是否通过标题 schema 检查，提示当前 gate 和下一步建议。它不在 V1 中硬拦截用户启动某个 role session。

## 8. 端到端工作流

### 8.1 新项目初始化

用户连接一个 repo 后，VibeCodingMaster 执行 Harness Check。这个步骤不是静默改项目，而是先检查、展示计划，再由用户确认是否安装或更新 VCM Harness。

```text
Connect repo
  -> record repo path in local app settings recentRepositoryPaths
  -> identify language, framework, package manager
  -> identify test commands
  -> inspect directory and module boundaries
  -> check CLAUDE.md
  -> check .claude/agents/project-manager.md
  -> check .claude/agents/architect.md
  -> check .claude/agents/coder.md
  -> check .claude/agents/reviewer.md
  -> check VCM managed block version
  -> check docs/ARCHITECTURE.md
  -> check docs/MODULE_MAP.md
  -> check docs/TESTING.md
  -> check module-local CLAUDE.md
  -> check validation tools
  -> check generated artifacts
  -> report harness gaps and planned VCM changes
```

输出 Project Harness Report：

- 当前 harness level。
- `CLAUDE.md` 是否存在，是否包含 VCM managed block。
- 4 个默认 role agent 是否存在，是否包含 VCM managed block。
- 每个文件的建议动作：`create` / `insert` / `update` / `ok`。
- 缺失的核心文档。
- 缺失的 validation commands。
- 高风险模块。
- 是否存在 generated artifact freshness check。
- 是否适合执行非平凡 AI coding。

如果用户点击 `Install / Update VCM Harness`，VCM 执行：

```text
Apply harness plan
  -> create missing CLAUDE.md if needed
  -> create missing .claude/agents/*.md if needed
  -> insert or update only <!-- VCM:BEGIN ... --> managed blocks in existing files
  -> never overwrite user-authored content outside managed blocks
  -> show changed files and actions
  -> recommend user review and commit
```

VCM managed block 格式：

```md
<!-- VCM:BEGIN version=1 -->
VCM-managed collaboration rules.
<!-- VCM:END -->
```

首次安装可能创建或修改：

```text
CLAUDE.md
.claude/agents/project-manager.md
.claude/agents/architect.md
.claude/agents/coder.md
.claude/agents/reviewer.md
```

默认模板职责：

- `CLAUDE.md`：共享 VCM 规则、canonical handoff directory、`vcmctl` 基本规则、高风险停止条件。
- `project-manager.md`：用户沟通入口、任务澄清、角色路由、`vcmctl send`、workflow gate、final acceptance / commit / PR。
- `architect.md`：architecture plan、module boundary、public/test contract、post-review docs sync / architecture drift check、`docs-sync-report.md`。
- `coder.md`：按 approved plan 实现、维护 implementation / validation logs、遇到范围或架构变化时回 PM。
- `reviewer.md`：独立 review、测试充分性、review report、发现 docs drift 时交回 PM。

Role sessions 的 VCM 协作规则必须从这些 repo-local 文件读取。VCM 不应在启动 Claude Code session 时把长段 messaging context 粘贴进 terminal。

安装完成后，GUI 必须告诉用户：

- VCM 创建了哪些文件。
- VCM 更新了哪些文件。
- 是否存在原本就 dirty 的工作区。
- 建议用户 review diff，并提交一个独立 commit，例如 `Install VCM harness rules`。

### 8.2 用户提出需求

用户输入自然语言：

```text
帮我把账单里的优惠券和部分退款逻辑修一下。
```

VibeCodingMaster 不直接让 Claude Code 编码，而是先澄清：

- 期望行为是什么？
- 哪些入口受影响？
- 是否允许改 public API？
- 是否允许改 schema？
- 是否涉及权限、支付、数据删除？
- 成功标准是什么？
- 需要保留哪些兼容行为？

### 8.3 生成 Task Spec

VibeCodingMaster 根据用户回答和代码库扫描生成 Task Spec。

关键要求：

- 至少定义 file responsibilities。
- 普通任务定义 public surface contract。
- 新增或修改 public function 定义 test contract。
- 高风险任务定义 human approval gate。

### 8.4 Preflight Architecture Review

VibeCodingMaster 调用 Claude Code architect session 或等价架构角色生成 `architecture-plan.md`。

随后可调用独立模型做 Preflight Review，例如 ChatGPT、Gemini 或 fresh Claude session。

Preflight Review 输出：

```text
Decision: approve / request_changes / block

Critical Issues:
Architecture Risks:
Public Contract Risks:
Missing Context:
Test Requirements:
Suggested Plan Changes:
Final Recommendation:
```

如果 decision 是 `request_changes`，回到 architect 修改计划。  
如果 decision 是 `block`，停止并请求用户或 human reviewer 决策。

### 8.5 Coder 执行

Coder role 只执行 approved plan。

执行 prompt 必须包含：

- task spec path
- architecture plan path
- scope
- public surface contract
- test contract
- validation commands
- stop conditions
- handoff log path

Coder 不能静默改变：

- scope
- public contract
- module responsibility
- architecture direction
- test strategy

如需改变，必须触发 Replan。

### 8.6 Validation

VibeCodingMaster 按任务风险选择验证层级：

```text
L0 Fast Checks
  format, lint, typecheck, architecture boundary, dependency rules

L1 Focused Unit / Contract Tests
  changed-file tests, public contract tests, regression tests

L2 Module / Integration Tests
  module service tests, DB integration, API contract

L3 Smoke E2E
  core user journeys, browser/API smoke flows

L4 Full Regression / Release Suite
  historical replay, visual, accessibility, perf, cross-browser
```

默认规则：

- T0：L0。
- T1：L0 + focused L1。
- T2：L0 + L1 + relevant L2。
- T3：L0 + L1 + L2。
- T4：L0 + L1 + L2 + relevant L3，release 前 L4。
- T5：每个 phase 有独立 validation plan。

### 8.7 Independent Review

Reviewer role 使用 fresh context 或独立 reviewer session。

Review 优先级：

1. correctness
2. security / permission risk
3. regressions
4. missing tests
5. architecture boundary violations
6. public contract mismatch
7. docs sync

Reviewer 可以做小范围、低风险、review-scoped fixes，例如：

- 增强测试断言。
- 增加小的边界测试。
- 修复测试 fixture。
- 修复明显 typo、import、lint。

Reviewer 不能接管中大型实现。如果发现业务逻辑或架构问题，必须退回 coder 或 architect。

### 8.8 Final Acceptance

VibeCodingMaster 的最终验收检查：

```text
behavior is correct
+ architecture is compliant
+ public contract is accurate
+ tests are sufficient
+ validation evidence exists
+ docs are synced
+ plan deviations are traceable
```

最终报告必须包含：

```text
Task severity:
Role sessions used:
Handoff artifacts:
Files changed:
Public surface changed:
Tests added/updated:
Validation run:
Architecture checks:
Docs updated:
Plan deviations:
Remaining risks:
Decision:
```

## 9. 产品功能模块

### 9.1 Chat Intake

负责和用户沟通，把自然语言变成工程需求。

能力：

- 识别任务类型。
- 判断风险等级。
- 追问关键需求。
- 识别 high-risk boundaries。
- 生成 task brief。

### 9.2 Task Spec Builder

负责生成和维护 `.ai/task-specs/<task-slug>.md`。

能力：

- scope / non-goals。
- severity classification。
- required role route。
- file responsibilities。
- public surface contract。
- test contract。
- validation commands。
- stop conditions。

### 9.3 Role Route Manager

负责根据任务分级选择 role route。

能力：

- 推荐 `architect / coder / reviewer / specialist`。
- 检查当前 session role 是否匹配。
- 阻止错误角色继续执行。
- 在 GUI 中引导用户启动或切换到正确 Claude Code role session。

### 9.4 Handoff Manager

负责管理 `.ai/handoffs/<task-slug>/`。

能力：

- 创建 handoff directory。
- 校验 artifact schema。
- 检查前置 artifact 是否存在。
- 汇总角色输出。
- 标记缺失或不一致内容。

### 9.5 Contract Manager

负责管理 public surface contract 和 test contract。

能力：

- 识别 public functions / module APIs。
- 记录输入、输出、副作用、错误行为、依赖规则。
- 检查代码变更是否修改 public surface。
- 提醒新增或更新 contract tests。
- 调用 `tools/check-public-surface` 和 `tools/check-contract-tests`。

### 9.6 Prompt Compiler

负责把 VibeCodingMaster 的结构化任务上下文编译成 AI 角色可以准确执行的完整命令。

它服务于 Project Manager，是 Project Manager “给其他角色发准确命令”的核心能力。

输入：

- 用户原始需求。
- Task Spec。
- Required Role Route。
- Architecture Plan。
- Public Surface Contract。
- Test Contract。
- Handoff Directory。
- Validation Commands。
- Stop Conditions。
- 当前任务状态。

输出：

- architect role command。
- coder role command。
- reviewer role command。
- specialist role command。
- human approval brief。

每个 role command 必须回答：

- 你是谁。
- 你要读什么。
- 你要产出什么。
- 你可以改什么。
- 你不能改什么。
- 什么情况下必须停止。
- 你必须运行或检查哪些验证。
- 你的完成标准是什么。

### 9.7 Session Cockpit

V1 的核心产品模块。负责在 GUI 中管理一个任务里的多个 Claude Code role sessions。

推荐结构：

```text
Task Workspace: <task-slug>

Role sessions:
  project-manager
  architect
  coder
  reviewer

Each role session:
  embedded terminal
  input channel
  output stream
  status badge
  role command link
  raw log link
  handoff artifact link
```

能力：

- 在页面中展示一个任务下的所有 role sessions。
- 允许用户用 tabs 或 split view 切换 `project-manager`、`architect`、`coder`、`reviewer`。
- 在每个 session 面板中嵌入真实 Claude Code 交互终端。
- 支持用户直接在当前 role session 中输入、确认权限、继续对话。
- 支持启动、停止、重启、恢复单个 role session。
- 展示每个 role session 的状态：not started / starting / running / waiting / blocked / done / crashed。
- 展示每个 role session 对应的 role command、raw log 和 handoff artifact。
- 支持 message timeline、manual approval cards、stage / reject role messages。
- 保留 role command link，作为长 handoff artifact 和兼容调试路径。
- 支持将 terminal output 持续写入 task logs。

原则：

- GUI 是主入口，终端编排是底层能力。
- 一个任务默认对应一个 session cockpit。
- 一个角色默认对应一个 Claude Code session。
- 多个 role session 可以同时存在，但写代码仍遵守 single-writer rule。
- VibeCodingMaster 负责 session lifecycle、可见性、artifact 管理和状态汇总，不替代 role agent 的专业判断。

### 9.8 Terminal Runtime Manager

负责在本地机器上托管 Claude Code 的交互式终端进程，并把输入输出桥接到 GUI。

V1 推荐：

```text
GUI frontend
  -> WebSocket
  -> local Node backend
  -> node-pty
  -> claude --agent <role> [permission option]
```

能力：

- 为每个 role 创建 pseudo-terminal。
- 将终端输出流式推送到前端 embedded terminal。
- 将用户键盘输入从前端写回对应 pty。
- 允许 backend 在用户触发时向 pty 写入短指令。
- 允许 backend 监听 pty output，并用于日志、状态和 GUI 提醒。
- 支持 resize。
- 支持进程退出、异常、重启和状态上报。
- 支持将 raw terminal stream 保存到 logs。

权限模式：

- GUI 在每个 role session 的 Start / Restart 上方提供权限选项。
- `默认`：不额外传权限参数，使用 Claude Code 默认权限行为。
- `bypassPermissions`：启动参数为 `--permission-mode bypassPermissions`。
- `--dangerously-skip-permissions`：启动参数为 `--dangerously-skip-permissions`。
- 选项只影响新启动或重启的 session，不自动改变已经运行中的 Claude Code 进程。

自动化边界：

- V1 可以程序化写入 terminal input，但必须经过 MessageService policy。
- manual mode 下，用户点击 `Stage` 只写入一行 prompt，不自动按 Enter。
- auto mode 下，只有在用户显式开启、未 paused、目标 session running、policy 通过时，才写入可见 message envelope 并提交。
- V1 可以程序化读取 terminal output，但只做 raw log、轻量状态和 UI 提醒。
- V1 不自动确认 Claude Code 权限提示。
- V1 允许用户在启动 session 时主动选择较宽松的 Claude Code 权限模式。
- V1 不允许 PM 绕过 message bus 直接无限制驱动 architect / coder / reviewer。
- V1 不根据 terminal output 自动执行高风险下一步。

### 9.9 Claude Code Adapter

负责生成 Claude Code role session 启动/恢复命令，并检查本机 Claude Code 可用性。

能力：

- 启动或恢复 architect session。
- 启动或恢复 coder session。
- 启动或恢复 reviewer session。
- 选择权限模式。
- 设置 VCM environment。
- 收集执行输出。
- 处理 Claude Code 交互式权限确认和等待状态。

V1 中，Claude Code Adapter 主要通过 Terminal Runtime Manager 工作。

### 9.10 Translation Layer

负责在 embedded terminal 旁边提供可开关的翻译工作层。

能力：

- 每个 role session 独立开启 / 关闭翻译。
- 开启后，Session Console 从单栏 terminal 变为左右分栏：
  - 左侧：原始 Claude Code embedded terminal。
  - 右侧：Translation Panel。
- 持续读取 VCM 已经接收到的 terminal output stream，过滤 ANSI/control chars 后按 chunk 处理。
- 对 chunk 做轻量分类，再决定翻译、摘要、保留原文或跳过。
- 将用户在 Translation Panel 输入的中文或其他语言转换为英文 instruction。
- 翻译用户输入时使用当前 role 的上一条 Claude Code 自然语言输出作为上下文。
- 默认让用户确认英文预览后再发送到 Claude Code。
- 支持 auto-send mode，但必须是用户显式开启。
- 每个 role session 使用独立 FIFO output translation queue，避免短 chunk 先完成导致顺序错乱。
- 支持暂停输出翻译，避免大日志造成成本失控。
- 支持复制原文、复制译文、复制英文 input draft。
- 支持查看翻译失败、跳过、截断和重试状态。

不做：

- 不修改 raw terminal output。
- 不修改 Claude Code 的真实上下文，除非用户发送英文 input draft。
- 不把翻译内容写入 handoff artifacts，除非用户或 PM 明确复制/引用。
- 不翻译代码块、diff、stack trace、命令输出中的关键 token；默认保留原文并提供简短说明。
- 不处理密码、secret、API key、private token 等敏感内容；检测到疑似敏感内容时跳过或脱敏。

推荐 chunk 策略：

```text
terminal output stream
  -> strip ANSI for translation copy
  -> preserve original output in terminal
  -> buffer until semantic boundary
       - prompt completed
       - blank line
       - bullet/list block
       - command finished
       - max chars reached
  -> classify chunk
       - prose
       - code/diff/log
       - tool output
       - permission prompt
       - error
       - already target language / CJK
  -> enqueue per-role FIFO translation job
  -> translate / summarize / preserve / skip
  -> append to Translation Panel
```

便宜模型策略：

- Translation Provider 独立于 Claude Code。
- 默认使用 OpenAI-compatible API 形态，允许接入便宜模型。
- 支持用户配置 provider、base URL、API key、model、timeout、max tokens、temperature。
- 默认低 temperature。
- 对高频 terminal output 做 batch / debounce。
- 对重复内容做去重。
- 对超长输出做摘要式翻译，而不是逐字翻译。

Prompt 策略：

- 采用 `cc-pm` 风格的三个 prompt slot：`zh-to-en`、`zh-to-en-with-context`、`en-to-zh`。
- `zh-to-en` 面向用户输入到 Claude Code 的英文工程指令。
- `zh-to-en-with-context` 包含上一条 Claude Code 回复和新输入，但要求模型只翻译新输入。
- `en-to-zh` 面向软件工程师阅读 Claude Code 输出，保留 Markdown、代码、路径、命令、flag、错误信息和标识符。
- 每个 slot 支持一个 `User prompt (empty = use default)` 完整覆盖；同时展示 `Default prompt (read-only)`。
- 如果模型返回可能误译或上下文不匹配的 warning，Translation Panel 必须进入 review-before-send 确认态。

### 9.11 Translation Provider Settings

负责管理翻译模型配置。

入口：

- 全局 Settings。
- Session Console 翻译开关旁的 `Translation Settings`。
- 首次开启翻译但未配置 provider 时弹出设置。

字段：

```text
enabled
providerType
baseUrl
apiKey
model
sourceLanguage
targetLanguage
workingLanguage
inputMode
translateOutput
translateUserInput
contextEnabled
preserveTechnicalTokens
skipCjkText
redactSecrets
maxChunkChars
requestTimeoutMs
temperature
prompts.zh-to-en
prompts.zh-to-en-with-context
prompts.en-to-zh
```

默认建议：

```text
sourceLanguage: auto
targetLanguage: user's UI language
workingLanguage: English
inputMode: review-before-send
translateOutput: on
translateUserInput: on
contextEnabled: on
preserveTechnicalTokens: on
skipCjkText: on
redactSecrets: on
temperature: 0.1
```

API key 处理：

- API key 只保存在本机。
- 本机设置统一保存在 `~/.vibe-coding-master/settings.json`，翻译配置位于 `translation` 字段。
- Settings API 会把已保存的 API key 返回给本地 GUI，用于在输入框中显示和继续编辑。
- 不写入 repo。
- 不写入 `.ai/handoffs/`。
- 不进入 git diff。
- V1 可以先存在 local app config；后续优先接 OS keychain。

设置页必须提供：

- `Test Connection`。
- `Estimate Cost` 或 token 使用提示。
- `Reset`。
- `Disable Translation`。
- `Clear Translation Panel`。
- Prompt settings：按 `zh-to-en`、`zh-to-en-with-context`、`en-to-zh` 三个 slot 展示用户 prompt 和默认 prompt。

### 9.12 Cross-Model Reviewer

负责让另一个 AI 模型审查计划或代码。

能力：

- Preflight Plan Review。
- Public Contract Review。
- Test Contract Review。
- Code Diff Review。
- Security Review。
- Architecture Review。

价值：

- 避免实现 session 自我确认。
- 在编码前发现方案问题。
- 在 PR 前发现遗漏测试、边界问题和架构漂移。

### 9.13 Validation Runner

负责验证命令管理。

能力：

- 推荐验证层级。
- 运行或指导运行 validation commands。
- 摘要失败日志。
- 要求失败后 rerun。
- 写入 task-level validation log。

### 9.14 Replan Controller

负责处理计划偏差。

能力：

- 识别 replan trigger。
- 冻结当前实现状态。
- 比较 plan 和 code reality。
- 生成选项：patch forward、partial rollback、full rollback。
- 记录用户或 human reviewer 的决策。
- 更新 task spec、architecture plan 和 docs。

### 9.15 Project Memory

负责项目长期状态。

文件：

```text
.ai/state/progress.md
.ai/state/decisions.md
.ai/state/validation-log.md
.ai/state/known-issues.md
.ai/state/scratch.md
```

能力：

- 记录 active tasks。
- 记录架构和设计决策。
- 记录 deferred findings。
- 记录 validation index。
- 清理 session-local scratch。

### 9.16 PR Assistant

负责把任务结果整理成 PR。

PR 描述应包含：

- task summary。
- task spec link。
- architecture plan link。
- files changed。
- public surface changed。
- tests added / updated。
- validation evidence。
- docs sync。
- remaining risks。

## 10. 信息架构

推荐 repo 结构：

```text
repo/
  CLAUDE.md

  docs/
    ARCHITECTURE.md
    MODULE_MAP.md
    TESTING.md
    SECURITY.md
    DEPENDENCY_RULES.md
    cc-best-practices.md
    product-design.md
    exec-plans/
      active/
      completed/

  .claude/
    settings.json
    skills/
    agents/
      architect.md
      coder.md
      reviewer.md
      optional/
        security-specialist.md
        migration-specialist.md
        performance-specialist.md
        frontend-qa.md
    commands/

  .ai/
    task-specs/
    handoffs/
    state/
    generated/

  tools/
    check-fast
    check-changed
    check-module
    check-e2e-smoke
    check-boundaries
    check-public-surface
    check-contract-tests
    check-generated-artifacts
    check-docs-freshness
    check-agent-rules
```

## 11. 关键界面

### 11.1 Project Dashboard

显示：

- 已连接 repo。
- active tasks。
- task severity。
- required role route。
- 每个任务的 session health。
- blocked tasks。
- recent validation failures。
- known issues。
- harness health。
- 最近打开的 role session。

### 11.2 Task Workspace

一个任务的主工作台。

左侧：

- 任务列表。
- 用户需求。
- task spec。
- required role route。
- open questions。

中间：

- role session tabs。
- embedded Claude Code terminal。
- 当前 role 的输入框和输出流。
- session toolbar：start / stop / restart / clear view / open log。
- role status：starting / running / waiting / blocked / done / crashed。
- acceptance checklist。

### 11.3 Session Console

显示单个 Claude Code role session 的完整交互界面：

- role name。
- agent command，例如 `claude --agent architect`。
- terminal viewport。
- terminal input。
- running / waiting / crashed 状态。
- last output time。
- raw log path。
- restart / stop / mark done 操作。

Session Console 必须支持 Claude Code 的交互式确认场景，例如权限确认、继续执行确认、失败后用户补充指令。

### 11.3.1 Translation Mode

Session Console 的 embedded terminal 旁边必须提供翻译开关。

关闭时：

```text
┌──────────────────────────────────────────────────────────────┐
│ Session Toolbar: role / status / permission / translation off │
├──────────────────────────────────────────────────────────────┤
│ Claude Code embedded terminal                                │
└──────────────────────────────────────────────────────────────┘
```

打开时：

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Session Toolbar: role / status / permission / translation on / settings     │
├──────────────────────────────────────┬───────────────────────────────────────┤
│ Claude Code embedded terminal         │ Translation Panel                     │
│ raw English input/output              │ translated output + translated input  │
│ accepts raw terminal keystrokes       │ user-language composer                │
└──────────────────────────────────────┴───────────────────────────────────────┘
```

Toolbar controls：

- `Translate` toggle。
- `Input mode` segmented control：`Review` / `Auto-send` / `Raw only`。
- `Output translation` toggle。
- `Use context` toggle。
- `Pause translation`。
- `Settings`。
- translation status：ready / translating / paused / failed / not configured。

Translation Panel 区域：

- Output translation stream：持续显示 Claude Code 输出的用户语言解释。
- Original chunk reference：允许展开查看对应英文原文。
- Source classification badge：prose / code / diff / log / tool output / skipped / summarized。
- User-language composer：用户输入中文或其他语言。
- English preview：默认展示即将发送给 Claude Code 的英文指令。
- Context hint：显示本次输入翻译是否使用上一条 Claude Code 回复作为上下文。
- Send controls：`Translate`、`Send English`、`Edit English`、`Send Raw`。
- Retry controls：对失败 chunk 或 input draft 重试。

默认交互：

```text
User types Chinese in Translation Panel
  -> VCM translates to English
  -> English preview appears
  -> User clicks Send English
  -> VCM writes the English text to Claude Code terminal and submits it
```

Auto-send 交互：

```text
User types Chinese in Translation Panel
  -> VCM translates to English
  -> VCM sends English text to Claude Code terminal automatically
```

Raw terminal 交互：

```text
User focuses left terminal
  -> all keystrokes go directly to Claude Code
  -> no translation, no interception
```

布局规则：

- 翻译开关打开后，左侧 terminal 不得小到不可用。
- Translation Panel 默认占 35%-45% 宽度，用户可拖拽调整。
- 小屏幕下可以改为上下分栏：terminal 在上，translation panel 在下。
- terminal 的 ANSI colors、光标、交互输入必须保持原样。
- 翻译输出不能覆盖或遮挡 Claude Code terminal。
- 关闭翻译时，terminal 恢复完整宽度；本次 Translation Panel entries 可保留到 session 关闭。

### 11.4 Handoff Files

V1 不在任务主界面展示独立 artifact panel。role commands、handoff artifacts 和 raw logs 仍保存在任务目录中，作为 Claude Code sessions 之间的文件级事实源；GUI 优先把空间留给 embedded terminal。

### 11.5 Contract View

显示当前任务涉及的 public surface：

- public function name。
- owner module。
- inputs。
- outputs。
- side effects。
- error behavior。
- dependency rules。
- existing tests。
- required tests。
- contract status。

### 11.6 Review Inbox

集中处理：

- Preflight Review findings。
- Code Review findings。
- Replan requests。
- Missing test warnings。
- Docs sync warnings。
- Human approval gates。

### 11.7 Harness Health

显示：

- root `CLAUDE.md` 是否存在。
- root `CLAUDE.md` 是否包含最新 VCM managed block。
- 4 个 role agent 是否存在。
- 4 个 role agent 是否包含最新 VCM managed block。
- module-local `CLAUDE.md` 覆盖率。
- architecture docs 是否存在。
- testing docs 是否存在。
- validation tools 是否存在。
- generated artifacts 是否 freshness-checked。
- hooks / CI gates 是否存在。
- known issues 是否过期。

可执行操作：

- `View Planned Changes`
- `Install / Update VCM Harness`
- `Refresh Harness Status`

应用后必须展示 changed files summary，并提示用户 review/commit。

### 11.8 Message Timeline and Orchestration Controls

Task Workspace 必须提供任务级 message timeline，让用户看到 PM 发出了什么、角色回复了什么、哪些消息等待处理。

显示：

- message id。
- from / to role。
- type：task / question / blocked / result / finding / review-request / revise / cancel。
- status：pending approval / queued / staged / delivered / failed / rejected / cancelled。
- artifact refs。
- failure reason。

控制：

- `Auto orchestration` toggle，默认 off。
- `Pause / Resume orchestration`。
- pending message approval cards。
- approval actions：`Stage`、`Reject`、`Edit`、`Open target role`。

Manual mode 行为：

```text
User clicks Stage
  -> VCM writes one line into target embedded terminal
  -> VCM does not append Enter
  -> user inspects terminal
  -> user presses Enter to execute
```

Stage 文本示例：

```text
Read and handle VCM message msg_123 at .ai/handoffs/demo-task/messages/msg_123.md
```

Auto mode 行为：

```text
PM / role sends message through vcmctl
  -> backend validates policy
  -> backend checks target session and orchestration state
  -> backend writes visible [VCM MESSAGE] envelope to target terminal
  -> backend appends Enter only when policy allows
```

VCM 不应隐藏角色间执行，也不应自动确认 Claude Code 权限提示。

## 12. 数据对象

### 12.1 Project

```json
{
  "id": "project_123",
  "name": "VibeCodingMaster",
  "repoPath": "/path/to/repo",
  "defaultBranch": "main",
  "harnessHealth": "partial",
  "vcmHarness": {
    "needsApply": true,
    "managedBlockVersion": 1,
    "plannedChanges": [
      {
        "path": "CLAUDE.md",
        "action": "insert"
      },
      {
        "path": ".claude/agents/project-manager.md",
        "action": "create"
      }
    ]
  },
  "validationCommands": [
    "tools/check-fast",
    "tools/check-changed"
  ]
}
```

### 12.2 Task

```json
{
  "id": "task_123",
  "slug": "coupon-partial-refund",
  "title": "Fix coupon and partial refund calculation",
  "severity": "T4",
  "status": "planning",
  "requiredRoleRoute": [
    "architect",
    "billing-specialist",
    "coder",
    "reviewer",
    "human-approval"
  ],
  "specPath": ".ai/task-specs/coupon-partial-refund.md",
  "handoffDirectory": ".ai/handoffs/coupon-partial-refund"
}
```

### 12.3 Public Contract

```json
{
  "symbol": "RefundService.calculateRefundAmount",
  "module": "billing",
  "signatureStatus": "unchanged",
  "inputs": ["invoiceId", "request"],
  "output": "Money",
  "sideEffects": [],
  "errorBehavior": ["throws when invoice is not refundable"],
  "dependencyRules": ["must not call payment adapter internals"],
  "requiredTests": [
    "happy path",
    "refund cannot exceed post-discount total",
    "invalid invoice state"
  ]
}
```

### 12.4 Review

```json
{
  "id": "review_123",
  "type": "preflight_plan",
  "reviewer": "cross_model_reviewer",
  "decision": "request_changes",
  "findings": [
    {
      "severity": "high",
      "category": "public_contract",
      "message": "The plan changes refund behavior but does not define consumer-facing contract tests."
    }
  ]
}
```

### 12.5 Role Session

```json
{
  "id": "session_architect_123",
  "claudeSessionId": "00000000-0000-4000-8000-000000000001",
  "taskSlug": "coupon-partial-refund",
  "role": "architect",
  "status": "running",
  "command": "claude --agent architect --permission-mode bypassPermissions",
  "permissionMode": "bypassPermissions",
  "terminalBackend": "node-pty",
  "logPath": ".ai/handoffs/coupon-partial-refund/logs/architect.log",
  "roleCommandPath": ".ai/handoffs/coupon-partial-refund/role-commands/architect.md",
  "handoffArtifactPath": ".ai/handoffs/coupon-partial-refund/architecture-plan.md",
  "startedAt": "2026-05-29T00:00:00+08:00",
  "lastOutputAt": "2026-05-29T00:03:14+08:00"
}
```

### 12.6 Terminal Event

```json
{
  "id": "evt_123",
  "sessionId": "session_architect_123",
  "type": "output",
  "timestamp": "2026-05-29T00:03:14+08:00",
  "data": "Architecture Summary..."
}
```

### 12.7 VCM Role Message

```json
{
  "id": "msg_123",
  "taskSlug": "coupon-partial-refund",
  "fromRole": "project-manager",
  "toRole": "coder",
  "type": "task",
  "body": "Read the architecture plan and implement phase 1.",
  "artifactRefs": [
    ".ai/handoffs/coupon-partial-refund/architecture-plan.md"
  ],
  "bodyPath": ".ai/handoffs/coupon-partial-refund/messages/msg_123.md",
  "status": "pending_approval",
  "createdAt": "2026-05-29T00:03:14+08:00"
}
```

### 12.8 VCM Orchestration State

```json
{
  "taskSlug": "coupon-partial-refund",
  "mode": "manual",
  "paused": false,
  "updatedAt": "2026-05-29T00:03:14+08:00"
}
```

如果 state file 不存在，VCM 必须按 `manual` mode、`paused: false` 处理。

### 12.9 Translation Settings

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
  "temperature": 0.1,
  "prompts": {
    "zh-to-en": "",
    "zh-to-en-with-context": "",
    "en-to-zh": ""
  }
}
```

安全规则：

- `apiKey` 不应出现在普通 JSON 导出示例里。
- V1 可以把 API key 存在本机 app config，后续迁移到 OS keychain。
- project repo 内不得保存 provider API key。
- translation settings 可以是全局配置；后续可支持 project override。

### 12.10 Translation Entry

```json
{
  "id": "tr_123",
  "taskSlug": "coupon-partial-refund",
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

状态：

```text
queued
translating
translated
skipped
failed
redacted
summarized
preserved
```

Translation Entry 只保存在前端/本地运行态，用于显示和重试；不写入 repo，也不进入 handoff artifacts。

`sourceKind` 建议枚举：

```text
prose
code
diff
log
tool-output
permission-prompt
error
already-target-language
sensitive
```

## 13. MVP 范围

### 13.1 V1 产品定位

V1 只做一件事：

> 做一个本地 GUI Session Cockpit，让用户可以在一个任务工作台中启动、切换、查看、输入和管理多个 Claude Code role sessions。

V1 的核心判断标准不是“CLI 是否能控制多个终端”，而是：

> 用户是否可以不离开 GUI，就完成多 Claude Code sessions 的创建、切换、沟通、观察、日志保存和 handoff artifact 查看。

### 13.2 V1 必须支持

1. 启动本地 GUI 应用。
2. 连接或选择本地 Git repo。
3. 检查本机是否安装 Claude Code。
4. 创建任务 workspace。
5. 为任务创建 handoff directory：
   - `.ai/handoffs/<task-slug>/`
   - `.ai/handoffs/<task-slug>/role-commands/`
   - `.ai/handoffs/<task-slug>/logs/`
6. 在 GUI 中展示 role session tabs：
   - `project-manager`
   - `architect`
   - `coder`
   - `reviewer`
7. 在对应 role session 中启动 Claude Code：
   - 首次启动：`claude --agent <role> --session-id <uuid>`
   - 恢复启动：`claude --agent <role> --resume <uuid>`
8. 在页面中嵌入每个 Claude Code session 的终端输出和输入。
9. 支持用户切换 role session 并直接沟通。
10. 支持 Claude Code 权限确认、等待用户输入、失败后补充指令等交互式场景。
11. 展示每个 role session 的状态：not started / starting / running / waiting / blocked / done / crashed。
12. 支持启动、停止、重启某个 role session。
13. 支持 Project Manager 通过 VCM message bus 调度其他角色。
14. 支持 `manual` orchestration mode，默认不自动执行角色消息。
15. 支持用户在 GUI 中检查、stage、reject role messages。
16. 支持可选 `auto` orchestration mode，但必须经过 backend policy check。
17. 支持在每个 embedded terminal 旁开启 Translation Mode。
18. Translation Mode 打开后，terminal 显示区左右分栏：左侧 Claude Code 原始 terminal，右侧翻译页。
19. 支持用便宜大模型持续翻译 Claude Code output。
20. 支持把用户在 Translation Panel 输入的中文或其他语言转换为英文并发送给 Claude Code。
21. 支持翻译模型 API 设置：provider、base URL、API key、model、语言、timeout、chunk 大小。
22. 支持翻译 prompt 保留代码、路径、命令、flag、错误信息、标识符和 git refs。
23. 支持用户输入翻译使用上一条 Claude Code 回复作为上下文。
24. 支持每个 role session 独立 FIFO 翻译队列，保持输出顺序。
25. 支持 output chunk 分类处理：prose 翻译，code/diff/log/tool output 默认保留或摘要。
26. 支持跳过已经是用户语言或 CJK 的内容。
27. 支持 Project Manager 生成 role command artifact，作为长 handoff 的 durable ref。
28. 将每个 role session 的 raw output 保存为日志。
29. 在 GUI 中查看 architecture-plan / implementation-log / validation-log / review-report。
30. 检查 handoff artifacts 是否存在、是否为空、是否包含必要标题。
31. 展示当前任务的状态摘要和下一步建议。
32. 在 `.vcm/sessions/<task-slug>.json` 中记录每个 role 的 `claudeSessionId`，支持异常中断后 Resume。
33. 保留 CLI 作为开发和调试入口；`vcmctl` 只作为 Claude Code role 调用 VCM 的本地桥接命令，不是用户主交互入口。

### 13.3 V1 明确不做

- SaaS 多用户协作。
- 企业权限和审计。
- 完整 Desktop 打包和自动更新。
- 自动生成完整 Task Spec。
- 自动做 Preflight Review。
- 自动做 Cross-Model Code Review。
- 自动判断 public contract 和 test contract。
- 自动运行 validation commands。
- 自动创建 PR。
- Jira / Linear / GitHub 双向同步。
- 云端 session 托管。
- 多 repo / 多任务并行调度。
- 多 worktree 自动管理。
- 让用户手动管理底层 terminal process。
- 保证翻译 100% 准确。
- 把翻译结果作为 repo 事实源。
- 自动把翻译结果写入 handoff artifacts。
- 在 raw terminal keystrokes 上做逐键翻译。
- 自动翻译或外发密码、API key、token、secret。

这些能力可以作为后续版本演进。V1 的判断标准不是“PM 流程是否全部自动化”，而是“GUI 是否让多 Claude Code role sessions 变得可见、可切换、可沟通、可恢复、可交接”。

### 13.4 V1 本地执行机制

推荐 V1 使用本地 Web GUI：

```text
Browser UI / Desktop shell
  -> local Node backend
  -> WebSocket terminal bridge
  -> node-pty
  -> claude --agent <role>
```

职责分离：

- Frontend 负责工作台、tabs、terminal viewport、状态展示。
- Backend 负责 repo 连接、进程生命周期、pty I/O、日志写入、artifact 读写。
- Claude Code role session 负责实际沟通和执行。
- Handoff artifacts 负责跨 session 传递稳定结果。

V1 的 terminal runtime 固定为：

```text
TerminalRuntime implementation = node-pty
```

后续如果要增强持久性，应优先改进本地 backend lifecycle、session registry、raw logs 和恢复体验，而不是引入额外终端复用层。

### 13.5 Controller-Mediated Role Messaging

推荐文件：

```text
.ai/handoffs/<task-slug>/
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
```

Project Manager 不直接无限制控制其他 Claude Code sessions。

正确模型：

```text
Project Manager session
  -> vcmctl send
  -> VCM backend validates message policy
  -> backend persists message and body file
  -> manual mode: GUI shows approval card
  -> user stages or rejects
  -> auto mode: backend writes visible envelope to target terminal
  -> target role executes
  -> non-PM role replies to PM through vcmctl
```

也就是说：

- PM 负责“决定是否调度、调度谁、发送什么 message”。
- GUI 负责让用户看见 message history、pending approvals 和 failures。
- Backend 负责 policy check、message persistence、staging / delivery。
- Role agent 负责执行命令并输出结果。
- Handoff artifacts 和 `.vcm/messages/<task-slug>.jsonl` 负责跨 session 传递稳定事实。

### 13.6 V1 交互形态

第一版应该是本地 GUI：

```text
Open VibeCodingMaster
  -> Select repo
  -> New task
  -> Start project-manager session
  -> Optional: turn on Translation Mode
  -> User writes in Translation Panel when useful
  -> VCM sends English working instructions to Claude Code
  -> PM clarifies task
  -> Start architect session
  -> PM sends architect message through VCM message bus
  -> View architecture-plan.md
  -> Start coder session
  -> PM sends coder message through VCM message bus
  -> View implementation-log.md and validation-log.md
  -> Start reviewer session
  -> PM sends reviewer message through VCM message bus
  -> View review-report.md
  -> Final acceptance
```

CLI 可以保留为：

- 启动 dev server。
- 调试 backend。
- 导出状态。
- 执行自动化 smoke test。

但用户主流程必须在 GUI 中完成。

## 14. 成功指标

### 14.1 V1 稳定性指标

- GUI 启动成功率。
- repo 连接成功率。
- role session 创建成功率。
- Claude Code role session 启动成功率。
- embedded terminal 输入输出成功率。
- WebSocket 断线重连成功率。
- role message 创建 / stage / delivery 成功率。
- translation provider 连接成功率。
- terminal output chunk 翻译成功率。
- translated input draft 发送成功率。
- session output 保存为 raw log 的成功率。
- stop / restart / recover 成功率。

### 14.2 流程指标

- 每个任务都有 GUI workspace 的比例。
- 每个 role session 都有 raw log 的比例。
- 每个 role command 都有 artifact 的比例。
- 用户能在 GUI 中查看 handoff artifacts 的比例。
- PM 能读取 architect / coder / reviewer 输出并生成状态摘要的比例。
- 用户在 role session 中手动介入后，VibeCodingMaster 能恢复 session 状态的比例。

### 14.3 用户体验指标

- 用户手写 prompt 长度下降。
- 用户可以清楚看到每个 role session 当前状态。
- 用户可以在 GUI 中切换到任意 Claude Code role session。
- 用户可以直接在 GUI 中输入、确认权限和继续对话。
- 用户可以在不离开 GUI 的情况下用自己的语言理解 Claude Code 输出。
- 用户可以把自己的语言输入转换为英文工作指令并发送给 Claude Code。
- 用户觉得多 Claude Code session 的切换和管理成本下降。
- 用户愿意用 VibeCodingMaster 启动下一次多角色任务。

## 15. 里程碑

### Phase 1：Local GUI Shell

- 创建本地 Web GUI 或 Desktop shell。
- 支持选择本地 repo。
- 显示 Project Dashboard。
- 显示 Task Workspace。
- 创建 `.vcm` 和 `.ai/handoffs/` 基础目录。

### Phase 2：Embedded Claude Code Sessions

- 使用 `node-pty` 启动 `claude --agent <role>`。
- 使用 xterm.js 嵌入 terminal。
- 支持 terminal input / output / resize。
- 支持 `project-manager / architect / coder / reviewer` tabs。
- 支持 stop / restart / crashed 状态。

### Phase 3：Task Artifacts Panel

- 创建 `.ai/handoffs/<task-slug>/`。
- 创建 `role-commands/` 和 `logs/`。
- 展示 architecture-plan / implementation-log / validation-log / review-report。
- 检查 handoff artifact 是否存在。
- 检查 handoff artifact schema completeness。
- 支持从 artifact 跳转到对应 role session。

### Phase 4：Message Bus Orchestration

- PM 通过 `vcmctl send` 创建 role messages。
- 非 PM role 通过 `vcmctl reply/result` 回 PM。
- Backend enforce PM-mediated policy。
- GUI 展示 message timeline 和 approval cards。
- Manual mode 下用户 stage / reject。
- Auto mode 下 backend 只在 policy 通过时投递 visible envelope。
- Backend 保存 raw logs、message snapshots 和 delivery state。

### Phase 5：Translation Mode

- 在 Session Toolbar 增加 `Translate` toggle。
- 打开后将 terminal 区域切成左侧 Claude Code terminal、右侧 Translation Panel。
- 提供 Translation Provider Settings。
- 支持 OpenAI-compatible provider、base URL、API key、model 配置。
- 支持 `Test Connection`。
- 实现工程化内置 prompt：保留代码、路径、命令、flag、错误信息、标识符和 git refs。
- 持续处理 Claude Code output chunks，并按 prose / code / diff / log / tool output / permission prompt 分类。
- 每个 role session 使用独立 FIFO queue 翻译 prose chunk，保持展示顺序。
- 对 code、diff、log、tool output 默认保留原文或摘要，不逐字翻译。
- 对已经是目标语言或 CJK 的 chunk 跳过翻译。
- 支持用户语言 input composer。
- 默认生成 English preview，用户确认后发送给 Claude Code。
- input translation 默认使用上一条 Claude Code 回复作为 context。
- 支持 auto-send mode。
- 支持 pause output translation、retry failed translation、clear panel。

### Phase 6：后续增强

- Task Spec Builder。
- public contract / test contract gate。
- Preflight Review。
- Cross-Model Code Review。
- validation runner。
- GitHub PR integration。
- session persistence hardening。
- Desktop packaging。

## 16. 主要风险

### 16.1 Claude Code 交互终端嵌入复杂

风险：Claude Code 是交互式终端程序，GUI 必须完整支持 ANSI output、键盘输入、resize、权限确认、长输出和等待用户输入。

应对：

- 使用 xterm.js 承载终端显示。
- 使用 node-pty 承载真实 pty。
- 保留 raw terminal stream。
- 支持用户直接在当前 session 面板中输入。
- 对 waiting / crashed / exited 状态做显式提示。

### 16.2 Session 持久性和恢复

风险：页面刷新、backend 重启或进程崩溃可能导致 session 丢失。

应对：

- Backend 持有 session registry。
- 原始输出全部保存到 logs。
- 关键结论以 handoff artifacts 为准。
- 页面刷新后从 backend 重新订阅 session。
- 后续增强本地 backend lifecycle、session metadata 和恢复体验。

### 16.3 多 session 资源和成本

风险：同时启动多个 Claude Code sessions 会消耗本地资源、上下文和 token。

应对：

- 默认按角色路由逐步启动 session。
- T0/T1 只启动 project-manager 和 coder。
- 未使用 role session 保持 not started。
- UI 显示运行中 session 和资源提示。

### 16.4 PM 直接控制其他 session 的权限过大

风险：如果 Project Manager agent 可以无限制向其他 session 写入指令，可能误发命令、覆盖用户输入或形成 agent 间失控循环。

应对：

- 采用 controller-mediated 模式。
- PM 只能通过 VCM message bus 调度其他角色。
- 非 PM 角色只能回复 PM。
- Manual mode 默认关闭自动执行，用户可 stage / reject。
- Auto mode 需要用户显式打开，并支持 pause。
- Backend 负责 policy check、message persistence 和 delivery state。
- 对高风险命令要求用户确认或回到 PM 询问用户。

### 16.5 流程过重

风险：用户只是想改一个小 bug，却被迫打开完整多角色工作台。

应对：

- T0/T1 提供 lightweight task mode。
- T0/T1 可以只启动 `project-manager` 和 `coder`。
- T2 以上才推荐完整 role route。
- UI 中默认折叠高级 contract 字段，但内部仍保留检查。

### 16.6 翻译不准确导致误操作

风险：便宜模型可能误译用户意图、命令、错误信息或 Claude Code 输出，导致 Claude Code 执行错误指令。

应对：

- 默认 `review-before-send`，显示英文预览。
- 用户可以编辑英文 draft。
- 用户输入翻译使用上一条 Claude Code 回复作为 context，但只翻译新输入。
- 对高风险词、删除、迁移、权限、支付、schema 等内容标记风险。
- 内置 prompt 必须保留代码、路径、命令、flag、错误信息、标识符和 git refs。
- code、diff、stack trace、tool output 默认保留或摘要，避免误译成错误命令。
- 翻译 panel 始终保留英文原文引用。
- 对低 confidence 翻译显示 warning。
- Raw terminal mode 始终可用，用户可以绕过翻译。

### 16.7 翻译成本失控

风险：Claude Code terminal output 很长，如果逐字持续翻译，会造成大量 token 成本和延迟。

应对：

- output translation 支持 pause。
- 每个 role session 使用 FIFO queue，避免并发请求放大成本和乱序。
- chunk 翻译做 debounce 和 batch。
- 超长日志默认摘要翻译。
- 重复输出去重。
- 已经是目标语言或 CJK 的内容跳过翻译。
- 设置 `maxChunkChars` 和 request timeout。
- UI 显示 token/cost usage hint。

### 16.8 隐私和密钥泄露

风险：terminal output 可能包含 API key、token、内部路径、日志和业务数据，翻译模型 API 可能是第三方服务。

应对：

- 首次开启翻译时提示输出会发送给 Translation Provider。
- 默认 `redactSecrets: on`。
- 检测疑似 secret、token、password、private key 时跳过或脱敏。
- API key 只保存在本机，不进 repo，不进 handoff artifacts。
- 支持关闭 output translation，只使用 input translation。
- 支持清除 Translation Panel entries。

### 16.9 AI Review 不可靠

风险：Reviewer 模型会误判、漏判或提出过度设计建议。

应对：

- 使用结构化 review output。
- 要求引用代码证据。
- 区分 block、request changes、suggestion。
- 高风险任务保留 human approval。

### 16.10 Handoff 成为形式主义

风险：角色交接文件被创建，但内容空洞。

应对：

- 用 schema check 检查关键字段。
- reviewer 检查 handoff compliance。
- final acceptance 把 handoff artifact 作为硬条件。
- UI 中直接显示 missing / incomplete / ok。

### 16.11 文档漂移

风险：VibeCodingMaster 生成大量文档，但后续不更新。

应对：

- `tools/check-docs-freshness`。
- Replan 时强制同步文档。
- PR template 加 docs sync checklist。
- 月度 harness review 删除无用文档。

### 16.12 和 Claude Code 原生能力重叠

风险：Claude Code 原生增强后，简单 prompt wrapper 或简单多终端管理被替代。

应对：

- 不把核心价值放在 prompt 美化。
- 不把核心价值放在 terminal 包装。
- 核心放在 GUI session cockpit、project orchestration、public contract、test contract、handoff、review gate、acceptance。

### 16.13 GUI 产品复杂度上升

风险：GUI、terminal runtime、backend process manager 一起做，复杂度高于 CLI。

应对：

- V1 只做本地单用户。
- V1 只做一个 repo、一个 task workspace 的核心路径。
- V1 不做自动 review、自动 validation、自动 PR。
- 先把 embedded Claude Code sessions 和 handoff artifact visibility 做扎实。

### 16.14 安全和权限边界不清

风险：用户以为 GUI 是 sandbox，但 Claude Code 实际仍在本地 repo 环境运行。

应对：

- 在 repo 连接和 session 启动前明确提示。
- 显示当前 repo path 和 branch。
- 高风险任务保留 human approval。
- 后续接入 Claude Code permissions/hooks。
- 不隐藏 Claude Code 的权限确认。

## 17. 产品判断

VibeCodingMaster 的机会不是做一个更会聊天的 Claude Code 外壳，而是做 Claude Code 之上的工程管理层。

最小可行定位：

> 面向 Claude Code 的本地 GUI 多 session 工作台。它用一个任务页面托管 project-manager、architect、coder、reviewer 等 Claude Code sessions，让用户可以切换沟通、查看输出、管理 handoff artifacts，并逐步用 public contract、contract tests、独立 review 和 human approval 管住高风险任务。

长期形态：

```text
Claude Code = coding engine
VibeCodingMaster = GUI session cockpit + project manager + harness manager + quality gatekeeper
```

如果 VibeCodingMaster 只做 prompt 优化，它很容易被插件或 Claude Code 原生能力替代。  
如果它只做 CLI 或 terminal 包装，也很难成为用户每天愿意打开的产品。  
如果它做到 GUI session cockpit、角色路由、handoff 管理、contract gate、validation evidence、review gate、Replan 和项目记忆，它就会成为 AI 编程团队的工程控制台。
