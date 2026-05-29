# VibeCodingMaster 产品设计文档

版本：v0.1  
日期：2026-05-29  
状态：产品设计草案  
依据：`docs/cc-best-practices.md`

## 1. 产品定位

VibeCodingMaster 是面向 Claude Code 的 AI Project Manager 和 Harness Manager。

它把用户的自然语言需求转化为可计划、可执行、可验证、可审查、可沉淀的工程任务，并协调不同 AI 角色完成架构设计、编码实现、验证、Review、Replan 和项目记忆更新。

一句话：

> VibeCodingMaster 不是让用户写更长的 prompt，而是把 Claude Code 放进一个有角色、有契约、有测试、有交接、有验收的工程系统里。

核心闭环：

```text
user intent
  -> task clarification
  -> project manager command planning
  -> task severity classification
  -> task spec
  -> required role route
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
Project Manager = user-facing conversation owner + role command dispatcher
```

它负责让每个 AI 角色“收到正确任务”，但不替代该角色完成任务。

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

Role Command 是 Project Manager 发给每个 AI 角色的可执行指令。

它不是普通聊天 prompt，而是由结构化上下文编译出来的任务命令。

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

VibeCodingMaster 应保存每次发出的 Role Command，方便后续审计、复现和优化。

## 7. 任务分级与角色路由

VibeCodingMaster 根据任务类型自动推荐 role route。

| 等级 | 任务类型 | 示例 | 推荐路由 |
| --- | --- | --- | --- |
| T0 | trivial | 文案、注释、无行为变化的小配置 | `coder`，可选 review checklist |
| T1 | small scoped change | 单文件 bug、简单测试、已知模式修复 | `coder -> fresh review` 或 `coder -> reviewer` |
| T2 | ordinary feature | 有边界的多文件 feature、普通 PR | `architect -> coder -> reviewer` |
| T3 | cross-module / architectural | 跨模块改动、重构、新 public surface | `architect -> coder -> reviewer` |
| T4 | high-risk | auth、permission、payment、billing、schema、public API、security | `architect -> specialist -> coder -> reviewer -> human approval` |
| T5 | large rewrite / greenfield | 新子系统、大迁移、长期重构 | `architect`，然后每个 phase 循环 `coder -> reviewer`，阶段边界做 architect review |

当分类不明确时，选择更严格的路由。

## 8. 端到端工作流

### 8.1 新项目初始化

用户连接一个 repo 后，VibeCodingMaster 执行 Harness Scan：

```text
Scan repo
  -> identify language, framework, package manager
  -> identify test commands
  -> inspect directory and module boundaries
  -> check CLAUDE.md
  -> check docs/ARCHITECTURE.md
  -> check docs/MODULE_MAP.md
  -> check docs/TESTING.md
  -> check module-local CLAUDE.md
  -> check validation tools
  -> check generated artifacts
  -> report harness gaps
```

输出 Project Harness Report：

- 当前 harness level。
- 缺失的核心文档。
- 缺失的 validation commands。
- 高风险模块。
- 是否存在 generated artifact freshness check。
- 是否适合执行非平凡 AI coding。

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
- 引导用户启动正确 Claude Code role session。

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

### 9.7 Tmux Session Manager

V1 的核心执行层。负责用 tmux 管理多个 Claude Code role sessions。

推荐结构：

```text
tmux session: vcm-<task-slug>

windows:
  0 project-manager
  1 architect
  2 coder
  3 reviewer
  4 monitor
```

能力：

- 为每个任务创建一个 tmux session。
- 为 `project-manager`、`architect`、`coder`、`reviewer` 创建独立窗口。
- 在每个窗口启动对应的 Claude Code role session。
- 将 role command 下发到目标窗口。
- 捕获各窗口输出。
- 将输出保存为 task logs。
- 将关键输出同步到 handoff artifacts。
- 支持用户 attach 到 tmux session 手动干预。

原则：

- 一个任务默认一个 tmux session。
- 一个角色默认一个 window。
- 多个 role session 可以同时存在，但写代码仍遵守 single-writer rule。
- VibeCodingMaster 负责终端编排，不替代 role agent 的专业判断。

### 9.8 Claude Code Adapter

负责将 Prompt Compiler 生成的 role command 交给 Claude Code 执行，或生成可复制的 Claude Code prompt。

能力：

- 启动或引导用户启动 architect session。
- 启动或引导用户启动 coder session。
- 启动或引导用户启动 reviewer session。
- 注入 artifact paths。
- 注入 stop conditions。
- 收集执行输出。

V1 中，Claude Code Adapter 主要通过 Tmux Session Manager 工作。它不直接实现翻译功能；翻译由 `project-manager` agent 根据自己的 role prompt 完成。

### 9.9 Cross-Model Reviewer

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

### 9.10 Validation Runner

负责验证命令管理。

能力：

- 推荐验证层级。
- 运行或指导运行 validation commands。
- 摘要失败日志。
- 要求失败后 rerun。
- 写入 task-level validation log。

### 9.11 Replan Controller

负责处理计划偏差。

能力：

- 识别 replan trigger。
- 冻结当前实现状态。
- 比较 plan 和 code reality。
- 生成选项：patch forward、partial rollback、full rollback。
- 记录用户或 human reviewer 的决策。
- 更新 task spec、architecture plan 和 docs。

### 9.12 Project Memory

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

### 9.13 PR Assistant

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

- active tasks。
- task severity。
- required role route。
- current role。
- blocked tasks。
- recent validation failures。
- known issues。
- harness health。

### 11.2 Task Workspace

一个任务的主工作台。

左侧：

- 用户需求。
- task spec。
- open questions。

中间：

- role route。
- architecture plan。
- implementation log。
- validation log。
- review report。

右侧：

- public contract。
- test contract。
- stop conditions。
- remaining risks。
- acceptance checklist。

### 11.3 Contract View

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

### 11.4 Review Inbox

集中处理：

- Preflight Review findings。
- Code Review findings。
- Replan requests。
- Missing test warnings。
- Docs sync warnings。
- Human approval gates。

### 11.5 Harness Health

显示：

- root `CLAUDE.md` 是否存在。
- module-local `CLAUDE.md` 覆盖率。
- architecture docs 是否存在。
- testing docs 是否存在。
- validation tools 是否存在。
- generated artifacts 是否 freshness-checked。
- role agents 是否存在。
- hooks / CI gates 是否存在。
- known issues 是否过期。

## 12. 数据对象

### 12.1 Project

```json
{
  "id": "project_123",
  "name": "VibeCodingMaster",
  "repoPath": "/path/to/repo",
  "defaultBranch": "main",
  "harnessHealth": "partial",
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

## 13. MVP 范围

### 13.1 V1 产品定位

V1 只做一件事：

> 用 tmux 管理多个 Claude Code role sessions，让 `project-manager`、`architect`、`coder`、`reviewer` 可以在同一个任务上下文中被启动、观察、下发指令和交接结果。

V1 不在产品层做翻译功能。  
用户输入和 Claude Code 输出的中英翻译，交给 `.claude/agents/project-manager.md` 中定义的 Project Manager 角色完成。

### 13.2 V1 必须支持

1. 连接本地 git repo。
2. 检查本机是否安装 `tmux` 和 Claude Code。
3. 创建任务级 tmux session：`vcm-<task-slug>`。
4. 在 tmux 中创建 role windows：
   - `project-manager`
   - `architect`
   - `coder`
   - `reviewer`
   - `monitor`
5. 在对应窗口启动 Claude Code role session：
   - `claude --agent project-manager`
   - `claude --agent architect`
   - `claude --agent coder`
   - `claude --agent reviewer`
6. 创建 `.ai/handoffs/<task-slug>/`。
7. 创建 `.ai/handoffs/<task-slug>/role-commands/`。
8. 将 Project Manager 生成的 role command 下发给目标窗口。
9. 捕获 architect / coder / reviewer 窗口输出。
10. 将原始 session output 保存为日志。
11. 将关键结果同步到 handoff artifacts。
12. 展示每个 role session 的状态：idle / running / waiting / blocked / done。
13. 支持用户 attach 到 tmux session 手动查看和干预。
14. 支持停止、重启、恢复某个 role window。

### 13.3 V1 明确不做

- 产品层翻译管线。
- 独立翻译模型调用。
- 自动生成完整 Task Spec。
- 自动做 Preflight Review。
- 自动做 Cross-Model Code Review。
- 自动判断 public contract 和 test contract。
- 自动运行 validation commands。
- 自动创建 PR。
- Jira / Linear / GitHub 双向同步。
- SaaS 多用户协作。
- 企业权限和审计。

这些能力可以作为后续版本演进。V1 的判断标准不是“PM 流程是否全部自动化”，而是“tmux 多 Claude Code role sessions 是否能稳定启动、互相交接、被观察、被下发命令”。

### 13.4 Tmux 交互机制

VibeCodingMaster 不应该让 Project Manager 直接无限制控制其他 Claude Code sessions。推荐采用 controller-mediated 模式：

```text
Project Manager agent
  -> writes role command artifact
  -> VibeCodingMaster controller reads artifact
  -> controller sends command to target tmux window
  -> architect/coder/reviewer agent executes
  -> controller captures target window output
  -> controller writes raw log and updates handoff artifact
  -> Project Manager reads logs/artifacts and summarizes to user
```

也就是说：

- PM 负责“决定发什么命令”。
- VibeCodingMaster 负责“把命令发到哪个 tmux window”。
- role agent 负责“执行命令并输出结果”。
- handoff artifacts 负责“跨 session 传递稳定结果”。

推荐文件：

```text
.ai/handoffs/<task-slug>/
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
```

### 13.5 V1 交互形态

第一版可以是本地 CLI：

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
vcm stop <task-slug>
```

后续再叠加 Web UI / Desktop UI。

## 14. 成功指标

### 14.1 V1 稳定性指标

- tmux session 创建成功率。
- role windows 创建成功率。
- Claude Code role session 启动成功率。
- role command 下发成功率。
- session output 捕获成功率。
- attach / detach / restart 成功率。

### 14.2 流程指标

- 每个任务都有 task-level tmux session 的比例。
- 每个 role session 都有 raw log 的比例。
- 每个 role command 都有 artifact 的比例。
- PM 能读取 architect / coder / reviewer 输出并生成状态摘要的比例。
- 用户手动介入后，VibeCodingMaster 能恢复 session 状态的比例。

### 14.3 用户体验指标

- 用户手写 prompt 长度下降。
- 用户可以清楚看到每个 role session 当前状态。
- 用户可以随时 attach 到 tmux 查看原始 Claude Code session。
- 用户觉得多 Claude Code session 的切换和管理成本下降。
- 用户愿意用 VibeCodingMaster 启动下一次多角色任务。

## 15. 里程碑

### Phase 1：tmux 多 Claude Code Session 管理

- 检查 `tmux` 和 Claude Code 可用性。
- 创建 task-level tmux session。
- 创建 `project-manager / architect / coder / reviewer / monitor` windows。
- 在窗口中启动对应 `claude --agent <role>`。
- 支持 attach / detach / stop / restart。
- 支持 role session 状态展示。

### Phase 2：Role Command 下发和输出捕获

- 创建 `role-commands/`。
- 将 role command 下发到指定 tmux window。
- 捕获指定 window 的输出。
- 保存 raw session logs。
- 支持 PM 读取 logs 和 handoff artifacts。

### Phase 3：Handoff Artifacts 同步

- 创建 `.ai/handoffs/<task-slug>/`。
- 同步 architecture-plan / implementation-log / review-report。
- 检查 handoff artifact 是否存在。
- 在 monitor 窗口展示当前任务状态。

### Phase 4：基础任务流

- PM 发 architect command。
- PM 读取 architect 输出。
- PM 发 coder command。
- PM 读取 coder 输出。
- PM 发 reviewer command。
- PM 读取 reviewer 输出。
- PM 给用户中文状态摘要。

### Phase 5：后续增强

- Task Spec Builder。
- public contract / test contract gate。
- Preflight Review。
- Cross-Model Code Review。
- validation runner。
- GitHub PR integration。
- Web UI / Desktop UI。

## 16. 主要风险

### 16.1 tmux 自动化脆弱

风险：tmux 是终端层自动化，可能遇到输出截断、Claude Code 等待用户确认、窗口状态不同步、用户手动输入导致状态漂移。

应对：

- 原始输出全部保存到 logs。
- 关键结论以 handoff artifacts 为准。
- 长 role command 先写入文件，再让目标 session 读取文件，避免长文本粘贴失败。
- 明确 session 状态：idle / running / waiting / blocked / done。
- 允许用户随时 attach 到 tmux 手动接管。

### 16.2 PM 直接控制其他 session 的权限过大

风险：如果 Project Manager agent 直接运行 `tmux send-keys` 控制其他 agent，可能误发命令、覆盖用户输入或形成 agent 间失控循环。

应对：

- 采用 controller-mediated 模式。
- PM 只产出 role command artifact。
- VibeCodingMaster controller 负责发送命令和捕获输出。
- 对高风险命令要求用户确认。
- 默认只允许 PM 读取 logs 和 handoff artifacts，不直接操作其他 pane。

### 16.3 流程过重

风险：用户只是想改一个小 bug，却被迫填完整工程流程。

应对：

- T0/T1 可以只启动 `project-manager` 和 `coder`。
- T2 以上才强制完整 role route。
- UI 中默认折叠高级 contract 字段，但内部仍保留检查。

### 16.4 AI Review 不可靠

风险：Reviewer 模型会误判、漏判或提出过度设计建议。

应对：

- 使用结构化 review output。
- 要求引用代码证据。
- 区分 block、request changes、suggestion。
- 高风险任务保留 human approval。

### 16.5 Handoff 成为形式主义

风险：角色交接文件被创建，但内容空洞。

应对：

- 用 schema check 检查关键字段。
- reviewer 检查 handoff compliance。
- final acceptance 把 handoff artifact 作为硬条件。

### 16.6 文档漂移

风险：VibeCodingMaster 生成大量文档，但后续不更新。

应对：

- `tools/check-docs-freshness`。
- Replan 时强制同步文档。
- PR template 加 docs sync checklist。
- 月度 harness review 删除无用文档。

### 16.7 和 Claude Code 原生能力重叠

风险：Claude Code 原生增强后，简单 prompt wrapper 被替代。

应对：

- 不把核心价值放在 prompt 美化。
- 核心放在 project orchestration、public contract、test contract、handoff、review gate、acceptance。

## 17. 产品判断

VibeCodingMaster 的机会不是做一个更会聊天的 Claude Code 外壳，而是做 Claude Code 之上的工程管理层。

最小可行定位：

> 面向 Claude Code 的 AI Project Manager。它用聊天理解需求，用角色制和 handoff 管理工作流，用 public contract 和 contract tests 控制质量，用独立 AI review 和 human approval 管住高风险任务。

长期形态：

```text
Claude Code = coding engine
VibeCodingMaster = project manager + harness manager + quality gatekeeper
```

如果 VibeCodingMaster 只做 prompt 优化，它很容易被插件或 Claude Code 原生能力替代。  
如果它做到角色路由、handoff 管理、contract gate、validation evidence、review gate、Replan 和项目记忆，它就会成为 AI 编程团队的工程控制台。
