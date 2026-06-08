#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HARNESS_VERSION = "0.2.1-fixed";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = ".ai/vcm-harness-manifest.json";
const HTML_BLOCK_PATTERN = /<!-- VCM:BEGIN(?:\s+version=\d+)? -->[\s\S]*?<!-- VCM:END -->/m;
const HASH_BLOCK_PATTERN = /# VCM:BEGIN(?:\s+version=\d+)?\n[\s\S]*?# VCM:END/m;
const VCM_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ] || [ -z "\${VCM_API_URL:-}" ]; then exit 0; fi; node -e '"'"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let event={};try{event=s.trim()?JSON.parse(s):{};}catch{event={raw:s};}process.stdout.write(JSON.stringify({taskSlug:process.env.VCM_TASK_SLUG,role:process.env.VCM_ROLE,event}));});'"'"' | curl -fsS --max-time 2 -X POST "\${VCM_API_URL}/api/hooks/claude-code" -H "content-type: application/json" --data-binary @- >/dev/null || true'`;

const AGENT_FRONTMATTER = {
  "project-manager": {
    description: "User-facing VCM orchestration role for task clarification, role routing, handoffs, acceptance, and PR preparation."
  },
  architect: {
    description: "VCM architecture role for plans, module boundaries, public contracts, verifiable behavior, and docs sync."
  },
  coder: {
    description: "VCM implementation role for scoped code changes and focused tests."
  },
  reviewer: {
    description: "VCM independent review role for acceptance, test adequacy, scope checks, and risk findings."
  }
};

const MANAGED_FILES = [
  {
    path: "CLAUDE.md",
    title: "CLAUDE.md",
    commentStyle: "html",
    category: "root-rules",
    blankLineBeforeEnd: true,
    content: `## VCM Start Here

- Use the durable project docs below as role-relevant project truth.
- Read module-local \`CLAUDE.md\` before editing a subdirectory if one exists.
- Use \`vcm-route-message\` whenever a VCM role hands off work, asks another role a question, reports a result, reports a blocker, or raises a finding. Follow its write-then-stop rule.
- Use \`vcm-long-running-validation\` for builds, browser checks, E2E tests, release suites, or any validation command that may take long enough for shell-completion callbacks to become unreliable. Do not end the current turn only to wait for a long-running shell callback.

## VCM Durable Project Docs

- \`docs/ARCHITECTURE.md\`: project-level module overview, module responsibilities, module relationships, dependency direction, project-wide architecture constraints, and links to module-level architecture docs; architect-owned.
- \`<module>/ARCHITECTURE.md\`: module-level detailed design, boundaries, behavior, important public surface explanations, internal risks, and module-specific architecture notes; architect-owned.
- \`docs/TESTING.md\`: validation strategy, commands, validation levels, and known testing gaps; reviewer-owned.
- \`docs/known-issues.md\`: durable known issues and accepted limitations; architect-owned.
- \`.ai/generated/module-index.json\`: generated module index; use it to find layers, modules, manifests, module docs, source files, test files, and workspace dependencies.
- \`.ai/generated/public-surface.json\`: generated crate-external public API index; use it to inspect module-to-module public interfaces and source evidence.

## VCM Task Flow

- Code changes use the full route: \`project-manager -> architect -> coder -> reviewer -> architect docs sync -> project-manager final acceptance\`.
- Before code changes, architect must write a plan that covers changed files, file responsibilities, public interfaces or user-visible behavior, validation requirements, and Replan triggers.
- Docs-only changes may use: \`project-manager -> architect -> project-manager final acceptance\`.
- Test-only or validation-only work may use: \`project-manager -> reviewer -> project-manager final acceptance\`.
- If a docs/test/validation-only task reveals required code, architecture, public contract, dependency, durable-doc, or test-strategy changes, route back through the full code-change flow.
- Keep role outputs under \`.ai/vcm/handoffs/\`.
- Runtime task records and handoffs under \`.ai/vcm/\` are temporary. Durable facts must move into code, tests, PR text, commit history, or long-term docs.
- Record current-task unresolved findings in \`.ai/vcm/handoffs/known-issues.md\`.

## VCM Validation Levels

- L0 fast checks: format, lint, typecheck, boundary, dependency, or other cheap project checks.
- L1 coder unit checks: changed behavior and direct regressions through project-defined unit tests.
- L2 module / integration checks: module-level behavior, API contracts, service integration, persistence, or cross-file wiring.
- L3 smoke E2E checks: core user journeys or critical browser/API flows.
- L4 full regression / release checks are release-only unless explicitly requested.

## VCM Worktree Policy

- Use one branch, one worktree, one handoff directory, and one PR or final patch per VCM-managed task.
- Roles work sequentially in the same task worktree.
- If \`git status\` shows uncommitted changes, commit them before handing off to another role.
`
  },
  {
    path: ".gitignore",
    title: ".gitignore",
    commentStyle: "hash",
    category: "ignore-rules",
    content: `# VCM runtime task metadata, handoffs, session records, logs, and task worktrees.
.ai/vcm/
.claude/worktrees/
`
  },
  {
    path: ".claude/agents/project-manager.md",
    title: "Project Manager Agent",
    agentName: "project-manager",
    commentStyle: "html",
    category: "core-agent",
    content: `
## VCM Project Manager Rules

### Role Scope

- You are the user-facing orchestration hub for this VCM-managed repository.
- Clarify the user's request, manage task flow, and choose the next role route.
- Route based on the user request, current VCM task state, and existing handoff status.
- Do not perform technical analysis; route technical, architectural, scope, contract, dependency, docs, and validation questions to architect.
- Do not implement non-trivial production code directly.

### Routing

- Use the routes defined in \`CLAUDE.md\`.
- Keep only one active role handoff at a time.
- Ask the user when user intent, priority, or approval is unclear.
- Ask the user when architect or reviewer reports a conflict with durable docs that requires user approval.

### Worktree

- Before dispatching work, confirm the current task repo root and branch.
- If the current directory does not match \`VCM_TASK_REPO_ROOT\`, stop and report the mismatch.
- Include the confirmed task repo root and branch in each role message.

### Dispatch

- Use the \`vcm-route-message\` skill for every role dispatch, question, result, blocker, or finding.
- Route messages contain PM-owned routing context only: target role, user request summary, known user constraints, source of truth, required next gate, skipped gates when applicable, required handoff inputs, expected artifact, stop conditions, and confirmed worktree information.
- Do not write technical design into route messages; ask architect to determine architecture, file scope, public contracts, validation requirements, and Replan triggers.
- For coder or reviewer messages, reference existing handoff artifacts instead of making new technical judgments.

### Phased Tasks

- When architect provides a phased plan, dispatch only one phase at a time.
- Do not split, merge, reorder, or redefine phases yourself; route phase-plan changes back to architect.
- Each coder phase must complete its assigned implementation before PM dispatches the next phase.
- Phase validation normally runs through L2; reserve full L3 validation for final task acceptance.
- Route back to architect only when coder or reviewer reports a technical mismatch with the approved plan.

### Flow Gates

- Track required handoff artifacts: architecture plan, task known issues, review report, docs-sync report, and final acceptance report.
- Advance to the next gate only when the current role reports complete or explicitly requests the next action.
- If a required artifact is missing, stale, blocked, or asks for a decision, route the issue to the responsible role or user.
- Request architect post-review docs sync after reviewer completes.

### Partial Role Results

- Treat partial, blocked, or continuation-needed role results as incomplete gates.
- If a role completes a coherent slice and the remaining work still matches the current route, dispatch the same role again.
- Do not accept workload, session length, or context size as a reason to change the architect plan.
- Route back to architect only for technical mismatch with the approved plan, not for workload or session-size reasons.
- Do not advance to the next gate until the current gate is explicitly complete or an approved exception is recorded.

### Final Acceptance

- Use the \`vcm-final-acceptance\` skill before declaring the task complete.
- Start final acceptance only after reviewer and docs-sync gates pass or an explicit exception is approved.
- Confirm required evidence exists: validation result, review decision, docs-sync decision, unresolved risks, known-issues disposition, and cleanup status.
- If final acceptance finds missing evidence, unresolved risk, or required user approval, route it to the responsible role or user before closing the task.

### PR Preparation

- Prepare or update a GitHub PR only after final acceptance passes.
- Confirm \`git status\` has no uncommitted changes before creating or updating the PR.
- Use \`.github/pull_request_template.md\` when present.
- Fill the PR body from final acceptance, review report, docs-sync report, known-issues disposition, and commits.
- Do not perform technical review or validation during PR preparation; route missing evidence to the responsible role.
- Create a draft PR by default unless the user requests a ready PR.
`
  },
  {
    path: ".claude/agents/architect.md",
    title: "Architect Agent",
    agentName: "architect",
    commentStyle: "html",
    category: "core-agent",
    blankLineBeforeEnd: true,
    content: `
## VCM Architect Rules

### Role Scope

- Own technical analysis, architecture planning, module boundaries, file responsibilities, public contracts, verifiable behavior, phase boundaries, behavior/contract proof points, risks, and Replan triggers.
- Own \`docs/known-issues.md\` promotion and durable issue updates.
- Own architecture docs sync across \`docs/ARCHITECTURE.md\` and affected \`<module>/ARCHITECTURE.md\` files.
- Do not implement production code.
- Do not design complete test cases, coverage matrices, or final validation strategy; reviewer owns independent test design, test adequacy, and validation confidence.
- Do not make product priority or approval decisions; route those questions back to project-manager.

### Planning Inputs

- Read the role message, durable plans when present, relevant handoff artifacts, \`docs/ARCHITECTURE.md\`, affected \`<module>/ARCHITECTURE.md\` files when present, and affected project docs before planning.
- Read \`.ai/generated/module-index.json\` when planning module scope, file scope, dependency direction, or phased work.
- Read \`.ai/generated/public-surface.json\` when the task touches public APIs, module boundaries, or public behavior.
- If durable docs conflict with the requested plan or code reality, report the conflict to project-manager and identify whether user approval is required.

### Architecture Plan

- Write \`.ai/vcm/handoffs/architecture-plan.md\` before coder work starts.
- The plan must cover changed files, task-local file responsibilities, affected modules, public interfaces or user-visible behavior, required behavior or contract proof points, docs impact, risks, and Replan triggers.
- For docs impact, state whether changes belong in \`docs/ARCHITECTURE.md\`, affected \`<module>/ARCHITECTURE.md\`, \`.ai/generated/public-surface.json\`, or no durable architecture doc.
- Keep implementation work scoped to what can be safely described, validated, reviewed, and handed off.

### Phase Planning

- Do not create phases for small, single-scope changes; use phases only when the task spans multiple modules, public contracts, migrations, high-risk integrations, or more work than one reliable coder handoff should carry.
- Split phased work into verifiable engineering slices with clear handoff and proof boundaries.
- Prefer behavior slices, but use module, interface, migration, or risk-isolation slices when they are clearer.
- Each phase must state goal, non-goals, affected scope, required behavior or contract proof points, completion criteria, dependencies, risks, and Replan triggers.
- Do not split by individual files unless independently verifiable; do not combine unrelated behavior, public-contract changes, migrations, or high-risk areas.

### Replan And Drift

- Replan only when project-manager routes a technical mismatch back to architect.
- Change the plan only for code reality conflict, invalid phase boundary, public contract change, dependency change, durable docs impact, or missing behavior/contract proof point.
- Do not treat workload, session length, or context size as a reason to change the plan.
- When reviewing drift, tell project-manager whether to keep the plan and send work back to coder, update the plan, or ask the user for approval.

### Docs Sync

- Perform docs sync only when project-manager requests it after reviewer completes.
- Update \`docs/ARCHITECTURE.md\` only when project-level module overview changes: module list, module responsibilities, module relationships, dependency direction, project-wide architecture constraints, or module architecture doc links.
- Update affected \`<module>/ARCHITECTURE.md\` when module-level detailed design changes: boundaries, behavior, important public surface explanations, internal risks, or module-specific architecture notes.
- Treat \`.ai/generated/public-surface.json\` as the full machine index for public surface. Verify or report its freshness when public APIs changed; do not replace it with prose in architecture docs.
- When module structure changes, require \`.ai/tools/generate-module-index --check\` or regeneration.
- When crate-external public APIs change, require \`.ai/tools/generate-public-surface --check\` or regeneration.
- Read \`.ai/vcm/handoffs/known-issues.md\` and promote confirmed unresolved issues to \`docs/known-issues.md\`.
- Write \`.ai/vcm/handoffs/docs-sync-report.md\` with decision, evidence reviewed, architecture drift check, docs updated, docs left unchanged, remaining documentation risks, and handoff notes.
`
  },
  {
    path: ".claude/agents/coder.md",
    title: "Coder Agent",
    agentName: "coder",
    commentStyle: "html",
    category: "core-agent",
    content: `
## VCM Coder Rules

### Role Scope

- Own implementation and baseline implementation tests inside the approved task scope, current phase, role message, and architecture plan.
- Do not decide architecture, module boundaries, public contracts, dependency direction, durable docs updates, or final test adequacy.

### Inputs

- Before editing, read the role message, the architecture plan, current phase when present, affected code/tests, and validation instructions from the role message or project docs.
- Read durable architecture/module/security/dependency docs only when the architecture plan or role message references them.
- Stop before editing when the architecture plan, role message, allowed write scope, public contract, or validation expectation is missing or unclear; reply to project-manager instead of inferring it.
- Use \`.ai/generated/module-index.json\` to locate approved module source and test files.
- Use \`.ai/generated/public-surface.json\` to avoid accidental public API drift.

### Implementation

- Make only the implementation changes needed for the approved scope.
- Do not weaken, delete, or skip tests to make validation pass.
- Record confirmed out-of-scope issues found during implementation in \`.ai/vcm/handoffs/known-issues.md\`.

### Generated Context

- Regenerate \`.ai/generated/module-index.json\` with \`.ai/tools/generate-module-index\` after module, manifest, source-file, or test-file changes.
- Regenerate \`.ai/generated/public-surface.json\` with \`.ai/tools/generate-public-surface\` after crate-external public API or public visibility changes.
- Do not hand-edit generated context files.

### Baseline Tests

- Add or update baseline unit tests for changed behavior: direct unit coverage, key happy path, key boundary or failure path when applicable.
- Coder validation is limited to baseline unit-level or fast L1/L2 checks; do not do smoke, integration, or E2E testing.
- If baseline unit tests cannot be run, explain the reason in the route message to project-manager.

### Replan And Continuation

- Stop and request Replan through project-manager when the approved plan conflicts with code reality.
- Request Replan only for architecture, public contract, dependency, phase-boundary, validation-boundary, or durable-doc changes that must be decided before implementation can continue.
- Do not request Replan because of workload, session length, or context size.
- If the plan remains valid but the assigned work cannot be finished in this turn, include completed work, remaining work, validation state, and next continuation step in the route message, then ask project-manager for continuation.
- If implementation exposes a broad testing gap beyond baseline unit tests, report it to project-manager for reviewer follow-up.
`
  },
  {
    path: ".claude/agents/reviewer.md",
    title: "Reviewer Agent",
    agentName: "reviewer",
    commentStyle: "html",
    category: "core-agent",
    content: `
## VCM Reviewer Rules

### Role Scope

- Own independent validation review, reviewer-owned test design, test implementation, test adequacy, \`docs/TESTING.md\`, and final validation confidence.
- Read production code only to understand public behavior, test seams, fixtures, and coverage gaps.
- Do not edit production code, decide architecture, or diagnose fixes beyond validation evidence.

### Inputs

- Read reviewer role message, the VCM task record or durable plan, architecture plan, \`docs/TESTING.md\`, relevant tests, fixtures, and validation docs.
- Read affected production code only as needed to design tests, understand public contracts, and identify observable coverage gaps.
- Use \`.ai/generated/module-index.json\` and \`.ai/generated/public-surface.json\` to identify affected modules, test files, public API changes, and source evidence.

### Validation Scope

- Validate behavior against the approved task scope, architecture plan, and public contracts through tests or observable behavior.
- Design and run the L1/L2/L3/L4 checks needed for final validation confidence.
- Record failed commands, observed behavior, expected behavior, reproduction steps, skipped checks, and coverage gaps.
- If validation fails or expected behavior is unclear, report the evidence to project-manager; architect owns diagnosis and next-step routing.
- Add or modify tests, fixtures, or test helpers needed for validation confidence.
- Update \`docs/TESTING.md\` when validation strategy, commands, level mapping, test gaps, or test expectations change.

### Phase Validation

- For phase review, run the strongest practical validation up to L2 that is relevant to the phase scope.
- Reserve full L3 E2E / browser / integration validation for the final phase or whole-task acceptance.
- Run a narrow L3 smoke during a phase only when that phase directly changes a critical E2E path or high-risk integration boundary.
- Treat architect-flagged public contracts, migrations, auth, data flow, routing, or dependency changes as inputs for reviewer-owned validation design.
- Record skipped L3 checks in \`.ai/vcm/handoffs/review-report.md\` with the reason and the planned final validation point.

### Outputs

- Write \`.ai/vcm/handoffs/review-report.md\` with decision, evidence reviewed, tests added or updated, commands run or checked, validation results, failed expectations, reproduction steps, skipped checks with reasons, coverage gaps, and required follow-ups.
- Record confirmed unresolved issues in \`.ai/vcm/handoffs/known-issues.md\` only when they should survive current-task cleanup.
`
  },
  {
    path: ".github/pull_request_template.md",
    title: "Pull Request Template",
    commentStyle: "html",
    category: "pull-request-template",
    content: `## Summary

## Validation

- Commands run or checked:
- Result:

## Review

- Reviewer decision:
- Final acceptance:

## Docs

- Durable docs updated or confirmed unchanged:
- Known issues disposition:

## Risks

## Checklist

- [ ] Final acceptance completed.
- [ ] Reviewer validation completed.
- [ ] Durable docs updated or confirmed unchanged.
- [ ] Known issues resolved or recorded.
- [ ] No uncommitted changes remain.
`
  }
];

const DURABLE_DOC_TEMPLATES = [
  {
    path: "docs/ARCHITECTURE.md",
    content: `# Architecture
`
  },
  {
    path: "docs/TESTING.md",
    content: `# Testing
`
  },
  {
    path: "docs/known-issues.md",
    content: `# Known Issues
`
  }
];

const WHOLE_FILES = [
  {
    path: ".ai/tools/generate-module-index",
    category: "generated-context-tool",
    mode: 0o755,
    templatePath: "scripts/harness-tools/generate-module-index"
  },
  {
    path: ".ai/tools/generate-public-surface",
    category: "generated-context-tool",
    mode: 0o755,
    templatePath: "scripts/harness-tools/generate-public-surface"
  },
  {
    path: ".claude/skills/vcm-final-acceptance/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: `---
name: vcm-final-acceptance
description: Use when project-manager is ready to decide whether a VCM-managed task can be accepted, returned for follow-up, or blocked for a decision.
---

# VCM Final Acceptance Skill

## Purpose

Use this skill when project-manager is ready to decide whether a VCM-managed task can be accepted, returned for follow-up, or blocked for a decision.

This skill is a final evidence audit. It does not replace architect docs sync, reviewer validation acceptance, coder implementation responsibility, or user approval for high-risk decisions.

Project-manager must not use this skill to perform technical design review, implementation review, source-code analysis, or test adequacy analysis. Missing or conflicting evidence must be routed to the responsible role.

## Required Inputs

Read the relevant task evidence before deciding:

- original user request, PM route message, or durable plan when present
- \`.ai/vcm/handoffs/architecture-plan.md\` when the task required architect planning
- \`.ai/vcm/handoffs/review-report.md\` when reviewer validation was required
- \`.ai/vcm/handoffs/docs-sync-report.md\` when durable docs could be affected
- \`.ai/vcm/handoffs/known-issues.md\` when unresolved findings were recorded
- current \`git status\` and changed file list
- relevant long-term docs only when needed to confirm that a docs-sync artifact exists and names the correct durable docs

## Evidence Audit

Check whether the required role evidence exists, is current, and gives a clear decision.

Acceptable evidence must show:

- architect plan or docs-sync decision when architecture, public contracts, durable docs, or known issues changed
- reviewer decision and validation evidence when code, behavior, tests, or generated context changed
- known-issues disposition when unresolved findings were recorded
- explicit user approval for accepted high-risk decisions or intentionally skipped required gates

## File Scope Audit

Do not claim to prove that every diff hunk exactly matches the task.

Review the changed file list only, then classify files:

- expected files: directly named by the user request, route message, durable plan, or architecture plan
- supporting files: tests, fixtures, generated context, docs, or wiring needed for expected files
- approved deviations: files explained by Replan, reviewer follow-up, docs-sync, or explicit user / project-manager approval
- unexplained files: files with no traceable reason in the task evidence
- high-risk unexpected files: auth, permissions, payment, billing, schema, migrations, data deletion, secrets, dependencies, lockfiles, broad generated artifacts, or broad formatting churn

Unexplained files must be routed for explanation, follow-up, or removal before normal acceptance.

High-risk unexpected files require explicit user approval or architect Replan before acceptance.

## Acceptance Checks

Check:

- required route was followed, or an explicit exception is recorded
- required handoff artifacts exist and are current
- architecture plan completion, Replan, or architect follow-up decision is recorded
- reviewer report records validation commands, results, skipped checks with reasons, and an acceptable decision
- docs-sync report records docs updated, docs intentionally left unchanged, or required follow-up
- known issues are either resolved, promoted to durable docs by architect, or explicitly accepted
- temporary task state is ready to clean after durable facts are promoted

## Decisions

Choose exactly one:

- accepted
- accepted-with-known-risks
- needs-coder-follow-up
- needs-architect-replan
- needs-docs-sync
- blocked-by-user-decision

Do not accept when required role evidence is missing, reviewer findings are unresolved, docs sync is missing for durable changes, known-issues disposition is missing, or unexplained high-risk files remain.

## Output

Write or update:

\`\`\`text
.ai/vcm/handoffs/final-acceptance.md
\`\`\`

Use this structure:

\`\`\`md
# Final Acceptance: <task>

## Decision

accepted | accepted-with-known-risks | needs-coder-follow-up | needs-architect-replan | needs-docs-sync | blocked-by-user-decision

## Evidence Reviewed

## File Scope

### Expected Files

### Supporting Files

### Approved Deviations

### Unexplained Files

### High-Risk Unexpected Files

## Validation Summary

## Review And Docs Sync

## Cleanup Readiness

## Final User Summary
\`\`\`

The final user summary should be concise and include files changed, validation, docs updates, open risks, and next action.
`
  },
  {
    path: ".claude/skills/vcm-harness-bootstrap/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: `---
name: vcm-harness-bootstrap
description: Use when VCM needs AI-assisted project understanding to finish or refresh project-specific harness content.
---

# VCM Harness Bootstrap Skill

## Purpose

Use this skill when VCM needs AI-assisted project understanding to finish or refresh project-specific harness content.

This skill is an operating procedure. It does not replace the deterministic VCM installer.

## Boundaries

- Read the repository before drafting project-specific harness content.
- Do not edit product source, product tests, package manifests, lockfiles, deployment config, or secrets.
- Do not own managed-block writes, hook merging, manifest migrations, uninstall behavior, or deterministic skeleton creation; VCM backend owns those.
- Do not create new validation wrapper tools during bootstrap.

## Procedure

1. Generate context when supported: run \`.ai/tools/generate-module-index\`, then run \`.ai/tools/generate-public-surface\` after \`module-index.json\` exists.
2. Inspect the project:  read \`README.md\`, read \`CLAUDE.md\`, durable project docs, project manifests/config, source layout, tests, and existing validation commands.
3. Fill project context: add or update non-managed project facts in \`CLAUDE.md\` above the VCM managed block.
4. Fill durable docs: update \`docs/ARCHITECTURE.md\`, module-level \`ARCHITECTURE.md\` files, and \`docs/TESTING.md\` with detailed project-specific content.
5. Preserve user-authored content and VCM managed blocks.
6. Report evidence, unknowns, confirmation-needed areas, generation failures, and recommended deterministic VCM actions.

## Typical Outputs

- \`CLAUDE.md\` project context and project constraints outside the VCM managed block
- \`docs/ARCHITECTURE.md\`
- \`docs/TESTING.md\`
- \`docs/known-issues.md\` only for confirmed durable issues
- module-level \`ARCHITECTURE.md\` files
- \`.ai/generated/module-index.json\`
- \`.ai/generated/public-surface.json\`

## Output Requirements

### \`CLAUDE.md\`

- Write only project-specific facts outside the VCM managed block.
- Include project type, architecture shape, important constraints, and local conventions when verified or strongly inferred.
- Do not edit, duplicate, or summarize the VCM managed block.

### Generated Context

- Run \`.ai/tools/generate-module-index\` when the generator exists and the project is supported.
- Run \`.ai/tools/generate-public-surface\` only after \`.ai/generated/module-index.json\` exists.
- If generation fails or the project is unsupported, report the reason. Do not invent generated artifacts.

### \`docs/ARCHITECTURE.md\`

- Document the project-level module overview, module responsibilities, module relationships, dependency direction, and project-wide constraints.
- Link to module-level \`ARCHITECTURE.md\` files when present.
- Explain generated-context ownership, especially that \`.ai/generated/public-surface.json\` is the machine index for crate-external public APIs.

### Module-Level \`ARCHITECTURE.md\`

- Create or update one module-level \`ARCHITECTURE.md\` for each clear module boundary.
- Document module boundaries, responsibilities, allowed dependencies, important behavior, important public surface explanations, risks, and update triggers.
- Keep complete public API listings in \`.ai/generated/public-surface.json\`; module docs should explain meaning and design intent, not duplicate the full generated index.

### \`docs/TESTING.md\`

- Document validation levels, project-native validation commands, unit/integration test placement, generated-context freshness checks, and known testing gaps.
- Keep reviewer ownership of validation strategy and testing documentation clear.

## Final Summary

Include:

- files reviewed
- files drafted or updated
- verified claims
- inferred claims
- unknowns
- needs human confirmation
- suggested validation commands
- recommended next harness steps
`
  },
  {
    path: ".claude/skills/vcm-long-running-validation/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: `---
name: vcm-long-running-validation
description: Use for builds, browser checks, E2E tests, release suites, or any validation command that may take long enough for shell-completion callbacks to become unreliable.
---

# VCM Long-Running Validation Skill

Use this skill for builds, browser checks, E2E tests, release suites, or any command that may take long enough for shell-completion callbacks to become unreliable.

## Rule

Do not end the current turn only to wait for a long-running shell callback.

Use a bounded file-backed job instead.

## Protocol

1. Start the command through \`.ai/tools/run-long-check\`.
2. Write job state under \`.ai/vcm/jobs/<job-id>/\`.
3. Run \`.ai/tools/watch-job <job-id> --timeout <duration>\` in the same turn.
4. Treat success, failure, and timeout as explicit results.
5. Read the final status and relevant log tail.
6. Record command, result, duration, and required follow-up wherever the caller normally records command evidence.

Example:

\`\`\`bash
.ai/tools/run-long-check -- cargo test --workspace
.ai/tools/watch-job <job-id> --timeout 20m
\`\`\`

## Job Files

\`\`\`text
.ai/vcm/jobs/<job-id>/command.json
.ai/vcm/jobs/<job-id>/status.json
.ai/vcm/jobs/<job-id>/stdout.log
.ai/vcm/jobs/<job-id>/stderr.log
\`\`\`

## Timeout

Timeout is not "unknown". It is a command result.

On timeout:

- summarize the latest log tail
- record the timeout in \`status.json\`
- report whether the timed-out process was stopped
- do not mark the command as passed

\`watch-job\` should attempt to stop the timed-out command process group. If termination cannot be confirmed, say so in the summary.

## Cleanup

\`.ai/vcm/jobs/**\` is runtime state. Delete it after the command result and useful log evidence have been recorded where needed.
`
  },
  {
    path: ".claude/skills/vcm-route-message/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: `---
name: vcm-route-message
description: Use when a VCM role needs to hand off work, ask a question, report a result, report a blocker, or raise a finding to another VCM role.
---

# VCM Route Message Skill

## Purpose

Use this skill when a VCM role needs to hand work, ask a question, report a result, report a blocker, or raise a finding to another VCM role.

This skill writes a route file. It does not deliver the message. VCM backend delivery is triggered later by Claude Code hooks.

## Route Policy

Use only routes allowed by the current VCM role rules and task approval.

Allowed message types:

- task
- question
- revise
- cancel
- result
- blocked
- finding

## Route File

Write or update exactly one file:

\`\`\`text
.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
\`\`\`

The file name is authoritative. Do not put from/to in frontmatter and do not create alternate message paths.

If the same route file already contains a not-yet-delivered message, update that file instead of creating a fragmented follow-up.

## Message Format

\`\`\`md
---
type: task
artifact_refs:
  - .ai/vcm/handoffs/architecture-plan.md
  - docs/plans/example.md
---

Summary:
...

Request or result:
...

Evidence:
...

Expected next action:
...
\`\`\`

Use the smallest body that is complete. Include artifact refs instead of copying long documents.

## Required Body Content

- why this message exists
- what the target role should do or what result is being reported
- source of truth or artifact references
- validation or documentation state when relevant
- blocker, decision needed, or next step when relevant

## Turn Rule

After writing or updating the route file, end the current Claude Code turn immediately.

Do not:

- send another message to the same target role in the same turn
- poll route files
- start a shell loop
- wait for another role's answer
- paste directly into another role terminal
- use Claude Code Task/Subagent for VCM role delegation

VCM scans pending route files after the Stop hook and delivers later replies in a new turn.

## Recovery

If delivery is manual, blocked, or the target role is busy, leave the route file non-empty. Do not clear it yourself unless the user or VCM controller has explicitly confirmed manual handling.
`
  },
  {
    path: ".ai/tools/run-long-check",
    category: "runtime-tool",
    mode: 0o755,
    content: `#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


def root_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\\n")
    tmp.replace(path)


def job_id() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{timestamp}-{uuid.uuid4().hex[:8]}"


def start_job(command: list[str]) -> int:
    root = root_dir()
    job = job_id()
    directory = root / ".ai/vcm/jobs" / job
    directory.mkdir(parents=True, exist_ok=False)

    (directory / "command.json").write_text(
        json.dumps({"command": command, "cwd": "."}, indent=2, sort_keys=True) + "\\n"
    )
    write_json(
        directory / "status.json",
        {
            "jobId": job,
            "status": "queued",
            "command": command,
            "cwd": ".",
            "startedAt": None,
            "finishedAt": None,
            "exitCode": None,
            "durationSeconds": None,
            "workerPid": None,
            "processId": None,
        },
    )

    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--worker", job],
        cwd=root,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    print(f"job: {job}")
    print(f"watch: .ai/tools/watch-job {job}")
    return 0


def run_worker(job: str) -> int:
    root = root_dir()
    directory = root / ".ai/vcm/jobs" / job
    command_path = directory / "command.json"
    status_path = directory / "status.json"

    payload = json.loads(command_path.read_text())
    command = payload["command"]
    started = time.time()
    started_at = now_iso()

    with (directory / "stdout.log").open("wb") as stdout, (directory / "stderr.log").open("wb") as stderr:
        process = subprocess.Popen(
            command,
            cwd=root,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
        )
        write_json(
            status_path,
            {
                "jobId": job,
                "status": "running",
                "command": command,
                "cwd": ".",
                "startedAt": started_at,
                "finishedAt": None,
                "exitCode": None,
                "durationSeconds": None,
                "workerPid": os.getpid(),
                "processId": process.pid,
            },
        )
        exit_code = process.wait()

    duration = round(time.time() - started, 3)
    current = json.loads(status_path.read_text())
    if current.get("status") == "timeout":
        current["processExitCode"] = exit_code
        current["processFinishedAt"] = now_iso()
        current["processDurationSeconds"] = duration
        write_json(status_path, current)
        return 0

    write_json(
        status_path,
        {
            "jobId": job,
            "status": "success" if exit_code == 0 else "failed",
            "command": command,
            "cwd": ".",
            "startedAt": started_at,
            "finishedAt": now_iso(),
            "exitCode": exit_code,
            "durationSeconds": duration,
            "workerPid": os.getpid(),
            "processId": process.pid,
        },
    )
    return 0


def main() -> int:
    if len(sys.argv) >= 3 and sys.argv[1] == "--worker":
        return run_worker(sys.argv[2])

    if len(sys.argv) < 3 or sys.argv[1] != "--":
        print("Usage: .ai/tools/run-long-check -- <command> [args...]", file=sys.stderr)
        return 2

    return start_job(sys.argv[2:])


if __name__ == "__main__":
    raise SystemExit(main())
`
  },
  {
    path: ".ai/tools/watch-job",
    category: "runtime-tool",
    mode: 0o755,
    content: `#!/usr/bin/env python3
import argparse
import json
import os
import signal
import time
from datetime import datetime, timezone
from pathlib import Path


def root_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def parse_duration(value: str) -> float:
    value = value.strip().lower()
    if value.endswith("ms"):
        return float(value[:-2]) / 1000
    if value.endswith("s"):
        return float(value[:-1])
    if value.endswith("m"):
        return float(value[:-1]) * 60
    if value.endswith("h"):
        return float(value[:-1]) * 3600
    return float(value)


def read_status(path: Path) -> dict:
    return json.loads(path.read_text())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\\n")
    tmp.replace(path)


def started_duration(status: dict) -> float | None:
    started_at = status.get("startedAt")
    if not started_at:
        return None
    try:
        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return round((datetime.now(timezone.utc) - started).total_seconds(), 3)


def process_group_exists(pid: int) -> bool:
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def stop_process(pid: int, signal_value: signal.Signals) -> str:
    try:
        os.killpg(pid, signal_value)
        return "process-group"
    except ProcessLookupError:
        return "not-running"
    except PermissionError:
        try:
            os.kill(pid, signal_value)
            return "process"
        except ProcessLookupError:
            return "not-running"
        except PermissionError:
            return "permission-denied"


def stop_process_group(pid: int) -> str:
    if not process_group_exists(pid) and not process_exists(pid):
        return "not-running"

    mode = stop_process(pid, signal.SIGTERM)
    if mode in {"not-running", "permission-denied"}:
        return mode

    deadline = time.time() + 2
    while time.time() < deadline:
        still_running = process_group_exists(pid) if mode == "process-group" else process_exists(pid)
        if not still_running:
            return f"terminated-{mode}"
        time.sleep(0.1)

    kill_mode = stop_process(pid, signal.SIGKILL)
    if kill_mode == "not-running":
        return f"terminated-{mode}"
    if kill_mode == "permission-denied":
        return "permission-denied"
    return f"killed-{kill_mode}"


def tail(path: Path, lines: int = 40) -> str:
    if not path.is_file():
        return ""
    content = path.read_text(errors="replace").splitlines()
    return "\\n".join(content[-lines:])


def print_summary(job_id: str, status: dict, directory: Path) -> None:
    print(f"job: {job_id}")
    print(f"status: {status.get('status')}")
    print(f"exitCode: {status.get('exitCode')}")
    print(f"durationSeconds: {status.get('durationSeconds')}")
    if status.get("status") == "timeout":
        print(f"timeoutSeconds: {status.get('timeoutSeconds')}")
        print(f"processStopResult: {status.get('processStopResult')}")

    if status.get("status") in {"failed", "timeout"}:
        stdout_tail = tail(directory / "stdout.log")
        stderr_tail = tail(directory / "stderr.log")
        if stdout_tail:
            print("\\nstdout tail:")
            print(stdout_tail)
        if stderr_tail:
            print("\\nstderr tail:")
            print(stderr_tail)


def main() -> int:
    parser = argparse.ArgumentParser(description="Watch a file-backed long-running validation job.")
    parser.add_argument("job_id")
    parser.add_argument("--timeout", default="10m")
    parser.add_argument("--interval", default="1s")
    args = parser.parse_args()

    timeout = parse_duration(args.timeout)
    interval = parse_duration(args.interval)
    directory = root_dir() / ".ai/vcm/jobs" / args.job_id
    status_path = directory / "status.json"

    deadline = time.time() + timeout
    last_status: dict | None = None

    while time.time() <= deadline:
        if status_path.is_file():
            last_status = read_status(status_path)
            if last_status.get("status") in {"success", "failed"}:
                print_summary(args.job_id, last_status, directory)
                return 0 if last_status.get("status") == "success" else 1
        time.sleep(interval)

    timeout_status = dict(last_status or {})
    process_id = timeout_status.get("processId")
    stop_result = "no-process-id"
    if isinstance(process_id, int):
        stop_result = stop_process_group(process_id)

    timeout_status.update(
        {
            "jobId": args.job_id,
            "status": "timeout",
            "finishedAt": now_iso(),
            "exitCode": None,
            "durationSeconds": started_duration(timeout_status),
            "timeoutSeconds": timeout,
            "processStopResult": stop_result,
        }
    )
    if directory.is_dir():
        write_json(status_path, timeout_status)
    print_summary(args.job_id, timeout_status, directory)
    return 124


if __name__ == "__main__":
    raise SystemExit(main())
`
  }
];

const LEGACY_FLAT_SKILL_FILES = [
  {
    path: ".claude/skills/vcm-final-acceptance.md",
    replacementPath: ".claude/skills/vcm-final-acceptance/SKILL.md"
  },
  {
    path: ".claude/skills/vcm-harness-bootstrap.md",
    replacementPath: ".claude/skills/vcm-harness-bootstrap/SKILL.md"
  },
  {
    path: ".claude/skills/vcm-long-running-validation.md",
    replacementPath: ".claude/skills/vcm-long-running-validation/SKILL.md"
  },
  {
    path: ".claude/skills/vcm-route-message.md",
    replacementPath: ".claude/skills/vcm-route-message/SKILL.md"
  }
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.projectRoot) {
    fail("Missing project root.");
  }

  const projectRoot = path.resolve(args.projectRoot);
  const dryRun = args.dryRun;
  const operations = [];

  await assertDirectory(projectRoot, "Project root");

  const manifest = await buildManifest(projectRoot);
  await installManifest({ projectRoot, manifest, dryRun, operations });
  for (const definition of MANAGED_FILES) {
    await installManagedFile({ projectRoot, definition, dryRun, operations });
  }
  for (const template of DURABLE_DOC_TEMPLATES) {
    await installDurableDocTemplate({ projectRoot, template, dryRun, operations });
  }
  await installClaudeSettings({ projectRoot, dryRun, operations });
  for (const directory of fixedDirectories()) {
    await ensureDirectory({ projectRoot, relativePath: directory, dryRun, operations });
  }
  for (const file of WHOLE_FILES) {
    await installWholeFile({ projectRoot, file, dryRun, operations });
  }
  await removeLegacyFlatSkillFiles({ projectRoot, dryRun, operations });

  printReport({ projectRoot, dryRun, operations });
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    help: false,
    projectRoot: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    }
    if (args.projectRoot) {
      fail(`Unexpected argument: ${arg}`);
    }
    args.projectRoot = arg;
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/install-vcm-harness.mjs <project-root>
  node scripts/install-vcm-harness.mjs <project-root> --dry-run

Installs only fixed VCM harness content.

This deterministic installer handles VCM-owned managed blocks, VCM-owned whole
files, VCM Claude settings hooks, generic long-running helper tools, and the
harness manifest. It also creates blank durable project doc templates when
missing and installs Rust generated-context generator tools. It does not copy
example project docs, generated context artifacts, module-level architecture
docs, or task runtime handoff artifacts.`);
}

async function buildManifest(projectRoot) {
  const current = await readOptionalJson(path.join(projectRoot, MANIFEST_PATH));
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    manager: "vcm",
    harnessVersion: HARNESS_VERSION,
    installMode: "fixed",
    installedAt: typeof current?.installedAt === "string" ? current.installedAt : now,
    updatedAt: now,
    runtimeRoots: [
      ".ai/vcm/",
      ".claude/worktrees/"
    ],
    entries: [
      manifestEntry(MANIFEST_PATH, "file", "harness-manifest", "whole-file"),
      ...MANAGED_FILES.map((file) => managedEntry(file)),
      {
        path: ".claude/settings.json",
        entryType: "file",
        category: "claude-settings",
        ownership: "json-merge",
        source: "vcm-template",
        lifecycle: "long-term",
        jsonOwnership: {
          topLevelKeys: ["hooks"],
          hookMatchers: ["VCM"]
        },
        uninstall: {
          action: "remove-owned-json-keys",
          requiresConfirmation: false
        }
      },
      ...fixedDirectories().map((directory) => manifestEntry(directory, "directory", directoryCategory(directory), "vcm-created")),
      ...WHOLE_FILES.map((file) => ({
        path: file.path,
        entryType: "file",
        category: file.category,
        ownership: "whole-file",
        source: "vcm-template",
        lifecycle: file.category === "runtime-tool" ? "conditional-long-term" : "long-term",
        uninstall: {
          action: "delete-file-if-unchanged",
          requiresConfirmation: false
        }
      })),
      derivedGeneratedContextEntry(".ai/generated/module-index.json", ".ai/tools/generate-module-index"),
      derivedGeneratedContextEntry(".ai/generated/public-surface.json", ".ai/tools/generate-public-surface")
    ]
  };
}

function derivedGeneratedContextEntry(pathName, source) {
  return {
    path: pathName,
    entryType: "file",
    category: "generated-context",
    ownership: "derived-artifact",
    source,
    lifecycle: "derived",
    uninstall: {
      action: "delete-derived-artifact",
      requiresConfirmation: false
    }
  };
}

function manifestEntry(pathName, entryType, category, ownership) {
  return {
    path: pathName,
    entryType,
    category,
    ownership,
    source: "vcm-template",
    lifecycle: "long-term"
  };
}

function managedEntry(file) {
  return {
    path: file.path,
    entryType: "file",
    category: file.category,
    ownership: "managed-block",
    source: "vcm-template",
    lifecycle: "long-term",
    marker: {
      type: file.commentStyle === "hash" ? "hash-comment" : "html",
      begin: file.commentStyle === "hash" ? "# VCM:BEGIN version=1" : "<!-- VCM:BEGIN version=1 -->",
      end: file.commentStyle === "hash" ? "# VCM:END" : "<!-- VCM:END -->"
    },
    uninstall: {
      action: "remove-managed-block",
      requiresConfirmation: false
    }
  };
}

function fixedDirectories() {
  return [
    ".claude/agents/",
    ".claude/skills/",
    ".claude/skills/vcm-final-acceptance/",
    ".claude/skills/vcm-harness-bootstrap/",
    ".claude/skills/vcm-long-running-validation/",
    ".claude/skills/vcm-route-message/",
    ".ai/tools/",
    ".ai/generated/"
  ];
}

function directoryCategory(directory) {
  if (directory === ".claude/agents/") {
    return "agent-directory";
  }
  if (directory === ".claude/skills/") {
    return "skill-directory";
  }
  if (directory.startsWith(".claude/skills/")) {
    return "skill-directory";
  }
  if (directory === ".ai/generated/") {
    return "generated-context-directory";
  }
  return "harness-tool-directory";
}

async function installManifest({ projectRoot, manifest, dryRun, operations }) {
  const targetPath = path.join(projectRoot, MANIFEST_PATH);
  const currentManifest = await readOptionalJson(targetPath);

  if (currentManifest && manifestBodyEqual(currentManifest, manifest)) {
    operations.push(skip(MANIFEST_PATH, "unchanged"));
    return;
  }

  await writeIfChanged({
    targetPath,
    relativePath: MANIFEST_PATH,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    mode: 0o644,
    dryRun,
    operations,
    action: "write fixed harness manifest"
  });
}

async function installManagedFile({ projectRoot, definition, dryRun, operations }) {
  const targetPath = resolveInside(projectRoot, definition.path);
  const block = renderManagedBlock(definition);
  const currentContent = await readOptionalText(targetPath);
  let nextContent;

  if (currentContent === undefined || currentContent.trim() === "") {
    nextContent = renderNewManagedFile(definition, block);
  } else {
    const pattern = definition.commentStyle === "hash" ? HASH_BLOCK_PATTERN : HTML_BLOCK_PATTERN;
    nextContent = pattern.test(currentContent)
      ? currentContent.replace(pattern, block)
      : `${currentContent.trimEnd()}\n\n${block}\n`;
  }

  await writeIfChanged({
    targetPath,
    relativePath: definition.path,
    content: ensureTrailingNewline(nextContent),
    mode: 0o644,
    dryRun,
    operations,
    action: "install fixed managed block"
  });
}

async function installDurableDocTemplate({ projectRoot, template, dryRun, operations }) {
  const targetPath = resolveInside(projectRoot, template.path);
  const currentContent = await readOptionalText(targetPath);
  if (currentContent !== undefined) {
    operations.push(skip(template.path, "exists"));
    return;
  }

  await writeIfChanged({
    targetPath,
    relativePath: template.path,
    content: ensureTrailingNewline(template.content),
    mode: 0o644,
    dryRun,
    operations,
    action: "create durable doc template"
  });
}

function renderManagedBlock(definition) {
  const body = definition.content.trimEnd();
  const endSpacing = definition.blankLineBeforeEnd ? "\n\n" : "\n";
  if (definition.commentStyle === "hash") {
    return `# VCM:BEGIN version=1\n${body}${endSpacing}# VCM:END`;
  }
  return `<!-- VCM:BEGIN version=1 -->\n${body}${endSpacing}<!-- VCM:END -->`;
}

function renderNewManagedFile(definition, block) {
  if (definition.agentName) {
    const frontmatter = AGENT_FRONTMATTER[definition.agentName];
    return `---\nname: ${definition.agentName}\ndescription: ${frontmatter.description}\ntools: Read, Grep, Glob, Bash, Edit, Write\n---\n\n# ${definition.title}\n\n${block}\n`;
  }
  return `# ${definition.title}\n\n${block}\n`;
}

async function installClaudeSettings({ projectRoot, dryRun, operations }) {
  const targetPath = path.join(projectRoot, ".claude/settings.json");
  const current = await readOptionalJson(targetPath) ?? {};
  if (!isPlainObject(current)) {
    fail(`Target JSON is not an object: ${targetPath}`);
  }

  const next = mergeVcmHooks(current);
  await writeIfChanged({
    targetPath,
    relativePath: ".claude/settings.json",
    content: `${JSON.stringify(next, null, 2)}\n`,
    mode: 0o644,
    dryRun,
    operations,
    action: "merge VCM Claude hooks"
  });
}

function mergeVcmHooks(settings) {
  const next = structuredClone(settings);
  const hooks = isPlainObject(next.hooks) ? { ...next.hooks } : {};

  for (const [eventName, eventMatchers] of Object.entries(hooks)) {
    if (!Array.isArray(eventMatchers)) {
      continue;
    }
    const remaining = eventMatchers.filter((matcher) => !isOwnedHookMatcher(matcher));
    if (remaining.length > 0) {
      hooks[eventName] = remaining;
    } else {
      delete hooks[eventName];
    }
  }

  for (const eventName of ["UserPromptSubmit", "Stop"]) {
    hooks[eventName] = [
      ...(Array.isArray(hooks[eventName]) ? hooks[eventName] : []),
      {
        hooks: [
          {
            type: "command",
            command: VCM_HOOK_COMMAND,
            timeout: 5
          }
        ]
      }
    ];
  }

  next.hooks = hooks;
  return next;
}

function isOwnedHookMatcher(matcher) {
  if (!isPlainObject(matcher) || !Array.isArray(matcher.hooks)) {
    return false;
  }
  return matcher.hooks.some((hook) => {
    if (!isPlainObject(hook)) {
      return false;
    }
    const command = typeof hook.command === "string" ? hook.command : "";
    return command.includes("VCM") ||
      command.includes("/api/hooks/claude-code") ||
      command.includes("hook-event");
  });
}

async function ensureDirectory({ projectRoot, relativePath, dryRun, operations }) {
  const targetPath = resolveInside(projectRoot, relativePath);
  if (await pathExists(targetPath)) {
    operations.push(skip(relativePath, "exists"));
    return;
  }
  if (dryRun) {
    operations.push(plan(relativePath, "create fixed directory"));
    return;
  }
  await fs.mkdir(targetPath, { recursive: true });
  operations.push(done(relativePath, "created fixed directory"));
}

async function installWholeFile({ projectRoot, file, dryRun, operations }) {
  const content = await wholeFileContent(file);
  await writeIfChanged({
    targetPath: resolveInside(projectRoot, file.path),
    relativePath: file.path,
    content: ensureTrailingNewline(content),
    mode: file.mode,
    dryRun,
    operations,
    action: "write fixed VCM file"
  });
}

async function removeLegacyFlatSkillFiles({ projectRoot, dryRun, operations }) {
  const wholeFilesByPath = new Map(WHOLE_FILES.map((file) => [file.path, file]));
  for (const legacy of LEGACY_FLAT_SKILL_FILES) {
    const targetPath = resolveInside(projectRoot, legacy.path);
    const currentContent = await readOptionalText(targetPath);
    if (currentContent === undefined) {
      continue;
    }

    const replacement = wholeFilesByPath.get(legacy.replacementPath);
    if (!replacement) {
      operations.push(skip(legacy.path, "missing replacement skill definition"));
      continue;
    }

    const replacementContent = ensureTrailingNewline(await wholeFileContent(replacement));
    const legacyExpectedContent = ensureTrailingNewline(stripSkillFrontmatter(replacementContent));
    if (currentContent !== replacementContent && currentContent !== legacyExpectedContent) {
      operations.push(skip(legacy.path, "legacy flat skill file differs; left in place"));
      continue;
    }

    if (dryRun) {
      operations.push(plan(legacy.path, "delete legacy flat skill file"));
      continue;
    }

    await fs.rm(targetPath, { force: true });
    operations.push(done(legacy.path, "deleted legacy flat skill file"));
  }
}

function stripSkillFrontmatter(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n\n/, "");
}

async function wholeFileContent(file) {
  if (typeof file.content === "string") {
    return file.content;
  }
  if (typeof file.templatePath === "string") {
    const templateAbsolutePath = path.join(SCRIPT_DIR, "..", file.templatePath);
    const content = await readOptionalText(templateAbsolutePath);
    if (content === undefined) {
      fail(`Missing bundled harness template: ${file.templatePath}`);
    }
    return content;
  }
  fail(`Whole file entry has no content: ${file.path}`);
}

async function writeIfChanged({ targetPath, relativePath, content, mode, dryRun, operations, action }) {
  const currentContent = await readOptionalText(targetPath);
  if (currentContent === content) {
    operations.push(skip(relativePath, "unchanged"));
    return;
  }

  if (dryRun) {
    operations.push(plan(relativePath, action));
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
  if (mode !== undefined) {
    await fs.chmod(targetPath, mode);
  }
  operations.push(done(relativePath, action));
}

async function readOptionalJson(absolutePath) {
  const content = await readOptionalText(absolutePath);
  if (content === undefined || content.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    fail(`Invalid JSON file: ${absolutePath}\n${error.message}`);
  }
}

async function readOptionalText(absolutePath) {
  return fs.readFile(absolutePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

async function assertDirectory(absolutePath, label) {
  const stat = await fs.stat(absolutePath).catch((error) => {
    if (error.code === "ENOENT") {
      fail(`${label} not found: ${absolutePath}`);
    }
    throw error;
  });
  if (!stat.isDirectory()) {
    fail(`${label} is not a directory: ${absolutePath}`);
  }
}

async function pathExists(absolutePath) {
  return fs.stat(absolutePath).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  );
}

function manifestBodyEqual(left, right) {
  const normalizedLeft = { ...left };
  const normalizedRight = { ...right };
  delete normalizedLeft.installedAt;
  delete normalizedLeft.updatedAt;
  delete normalizedRight.installedAt;
  delete normalizedRight.updatedAt;
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function resolveInside(root, relativePath) {
  if (path.isAbsolute(relativePath)) {
    fail(`Path must be relative: ${relativePath}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    fail(`Path escapes root: ${relativePath}`);
  }
  const resolved = path.resolve(root, normalized);
  if (!isInside(root, resolved) && resolved !== root) {
    fail(`Path escapes root: ${relativePath}`);
  }
  return resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function plan(pathName, action) {
  return { status: "plan", path: pathName, action };
}

function done(pathName, action) {
  return { status: "done", path: pathName, action };
}

function skip(pathName, reason) {
  return { status: "skip", path: pathName, action: reason };
}

function printReport({ projectRoot, dryRun, operations }) {
  console.log(`${dryRun ? "Dry-run" : "Applied"} VCM fixed harness install`);
  console.log(`Project: ${projectRoot}`);

  for (const operation of operations) {
    console.log(`${operation.status.toUpperCase()} ${operation.path} - ${operation.action}`);
  }

  if (dryRun) {
    console.log("No files changed. Re-run without --dry-run to apply.");
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  console.error(`VCM fixed harness install failed: ${message}`);
  process.exit(1);
}

await main();
