#!/usr/bin/env node

// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { renderArchitectHarnessRules } from "../templates/harness/architect-agent.js";
import {
  CODE_ROLE_DISALLOWED_TOOLS,
  REVIEWER_DISALLOWED_TOOLS
} from "../role-tool-policy.js";
import { renderCoderHarnessRules } from "../templates/harness/coder-agent.js";
import { renderCoderWorkerHarnessRules } from "../templates/harness/coder-worker-agent.js";
import { renderArchitectScaffoldWorkerHarnessRules } from "../templates/harness/architect-scaffold-worker-agent.js";
import {
  renderReviewerAgentRules,
  renderRequestGateReviewTool,
  renderTranslatorAgentRules,
  renderVcmGateReviewSkillRules
} from "../templates/harness/gate-review.js";
import { renderHarnessEngineerHarnessRules } from "../templates/harness/harness-engineer-agent.js";
import { renderRootClaudeHarnessRules } from "../templates/harness/claude-root.js";
import { renderGitignoreHarnessRules } from "../templates/harness/gitignore.js";
import { ensureVcmMemoryBlock } from "../templates/harness/memory-block.js";
import {
  renderLegacyProjectCodingStandardsTemplate,
  renderProjectCodingStandardsProjectSection,
  renderProjectCodingStandardsRules
} from "../templates/harness/project-coding-standards.js";
import { renderProjectGlossaryTemplate } from "../templates/harness/project-glossary.js";
import {
  renderLegacyProjectKnownIssuesTemplate,
  renderProjectKnownIssuesRules,
  renderProjectKnownIssuesSection
} from "../templates/harness/project-known-issues.js";
import { renderProjectManagerHarnessRules } from "../templates/harness/project-manager-agent.js";
import { renderPullRequestTemplateHarnessRules } from "../templates/harness/pull-request-template.js";
import { renderTesterHarnessRules } from "../templates/harness/tester-agent.js";
import { renderVcmArchitectureInterviewSkillRules } from "../templates/harness/vcm-architecture-interview-skill.js";
import { renderVcmCodeNavigationSkillRules } from "../templates/harness/vcm-code-navigation-skill.js";
import { renderVcmFinalAcceptanceSkillRules } from "../templates/harness/vcm-final-acceptance-skill.js";
import { renderVcmHarnessBootstrapSkillRules } from "../templates/harness/vcm-harness-bootstrap-skill.js";
import { renderVcmLongRunningValidationSkillRules } from "../templates/harness/vcm-long-running-validation-skill.js";
import { renderVcmProposeMemorySkillRules } from "../templates/harness/vcm-propose-memory-skill.js";
import { renderVcmReportHarnessIssueSkillRules } from "../templates/harness/vcm-report-harness-issue-skill.js";
import { renderVcmRouteMessageSkillRules } from "../templates/harness/vcm-route-message-skill.js";
import { renderAskUserTool, renderVcmAskUserSkillRules } from "../templates/harness/vcm-ask-user-skill.js";
import { renderUpdateTaskStateTool, renderVcmTaskStateSkillRules } from "../templates/harness/vcm-task-state-skill.js";
import { renderVcmWorkflowReviewSkillRules } from "../templates/harness/vcm-workflow-review-skill.js";
import { renderCheckScaffoldLedgerTool } from "../templates/harness/check-scaffold-ledger.js";
import {
  renderRequestArchitectRestartTool,
  renderRestartArchitectSkillRules
} from "../templates/harness/restart-architect-skill.js";
import { renderResolveDurableDocAssignmentTool } from "../templates/harness/resolve-durable-doc-assignment.js";
import { readVcmPackageVersion } from "../app-version.js";

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(CLI_DIR, "../../..");
const VCM_PACKAGE_VERSION = readVcmPackageVersion(APP_ROOT);
const MANIFEST_PATH = ".ai/vcm-harness-manifest.json";
const LEGACY_REVIEWER_AGENT_PATH = ".claude/agents/gate-reviewer.md";
const REVIEWER_AGENT_PATH = ".claude/agents/reviewer.md";
const HTML_BLOCK_PATTERN = /<!-- VCM:BEGIN(?:\s+version=\d+)? -->[\s\S]*?<!-- VCM:END -->/m;
const HASH_BLOCK_PATTERN = /# VCM:BEGIN(?:\s+version=\d+)?\n[\s\S]*?# VCM:END/m;
const LEGACY_CODEX_HARNESS_PATHS = [
  ".ai/codex",
  ".ai/codex-translator",
  ".claude/skills/vcm-codex-review-gate",
  ".ai/tools/request-codex-review"
];
const VCM_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ] || [ -z "\${VCM_API_URL:-}" ]; then exit 0; fi; node -e '"'"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let event={};try{event=s.trim()?JSON.parse(s):{};}catch{event={raw:s};}process.stdout.write(JSON.stringify({taskSlug:process.env.VCM_TASK_SLUG,role:process.env.VCM_ROLE,runtimeSessionToken:process.env.VCM_RUNTIME_SESSION_TOKEN,event}));});'"'"' | curl -fsS --max-time 2 -X POST "\${VCM_API_URL}/api/hooks/claude-code" -H "content-type: application/json" --data-binary @- >/dev/null || true'`;
const VCM_STOP_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ] || [ -z "\${VCM_API_URL:-}" ]; then exit 0; fi; node -e '"'"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let event={};try{event=s.trim()?JSON.parse(s):{};}catch{event={raw:s};}process.stdout.write(JSON.stringify({taskSlug:process.env.VCM_TASK_SLUG,role:process.env.VCM_ROLE,runtimeSessionToken:process.env.VCM_RUNTIME_SESSION_TOKEN,event}));});'"'"' | curl -fsS --retry 2 --retry-delay 1 --retry-all-errors --connect-timeout 1 --max-time 2 -X POST "\${VCM_API_URL}/api/hooks/claude-code/stop" -H "content-type: application/json" --data-binary @- || true'`;
const VCM_PERMISSION_REQUEST_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ] || [ -z "\${VCM_API_URL:-}" ]; then exit 0; fi; node -e '"'"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let event={};try{event=s.trim()?JSON.parse(s):{};}catch{event={raw:s};}process.stdout.write(JSON.stringify({taskSlug:process.env.VCM_TASK_SLUG,role:process.env.VCM_ROLE,runtimeSessionToken:process.env.VCM_RUNTIME_SESSION_TOKEN,event}));});'"'"' | curl -fsS --max-time 5 -X POST "\${VCM_API_URL}/api/hooks/claude-code/permission-request" -H "content-type: application/json" --data-binary @- || true'`;
const VCM_BASH_GUARD_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ]; then exit 0; fi; guard=""; repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"; if [ -n "$repo" ] && [ -f "$repo/.ai/tools/vcm-bash-guard" ]; then guard="$repo/.ai/tools/vcm-bash-guard"; else cwd="$(pwd -P 2>/dev/null || pwd)"; dir="$cwd"; while [ -n "$dir" ] && [ "$dir" != "/" ]; do if [ -f "$dir/.ai/tools/vcm-bash-guard" ]; then guard="$dir/.ai/tools/vcm-bash-guard"; break; fi; dir="$(dirname "$dir")"; done; if [ -z "$guard" ] && [ -n "\${CLAUDE_PROJECT_DIR:-}" ] && [ -f "\${CLAUDE_PROJECT_DIR}/.ai/tools/vcm-bash-guard" ]; then guard="\${CLAUDE_PROJECT_DIR}/.ai/tools/vcm-bash-guard"; fi; fi; [ -n "$guard" ] || exit 0; python3 "$guard" || exit 0'`;
const VCM_BASH_DEFAULT_TIMEOUT_MS = "600000";
const VCM_AUTO_MEMORY_ENABLED = false;
const VCM_HOOK_DEFINITIONS = [
  { eventName: "PreToolUse", matcher: "Bash", command: VCM_BASH_GUARD_HOOK_COMMAND, timeout: 10 },
  { eventName: "PreToolUse", matcher: "Write|Edit", command: VCM_BASH_GUARD_HOOK_COMMAND, timeout: 10 },
  { eventName: "UserPromptSubmit", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "PreToolUse", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "PostToolUse", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "PostToolUseFailure", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "PostToolBatch", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "SubagentStart", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "SubagentStop", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "Stop", command: VCM_STOP_HOOK_COMMAND, timeout: 10 },
  { eventName: "StopFailure", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "PreCompact", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "PostCompact", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "PermissionRequest", command: VCM_PERMISSION_REQUEST_HOOK_COMMAND, timeout: 5 }
];

const AGENT_FRONTMATTER = {
  "project-manager": {
    description: "User-facing VCM orchestration role for task clarification, role routing, handoffs, acceptance, and PR preparation.",
    tools: "Read, Grep, Glob, Bash, Edit, Write, Skill"
  },
  architect: {
    description: "VCM architecture role for plans, module boundaries, public contracts, verifiable behavior, and docs sync.",
    disallowedTools: CODE_ROLE_DISALLOWED_TOOLS.join(", "),
    skills: ["vcm-code-navigation"]
  },
  coder: {
    description: "VCM implementation role for scoped code changes and focused tests.",
    disallowedTools: CODE_ROLE_DISALLOWED_TOOLS.join(", ")
  },
  tester: {
    description: "VCM testing role for validation, test adequacy, approved-scope validation, and risk findings.",
    tools: "Read, Grep, Glob, Bash, Edit, Write, Skill"
  },
  reviewer: {
    description: "VCM independent gate review role for architecture plans, validation adequacy, and code diffs.",
    disallowedTools: REVIEWER_DISALLOWED_TOOLS.join(", ")
  },
  translator: {
    description: "VCM task-scoped translation tool role for conversation translation, file translation, bootstrap, and memory updates."
  },
  "harness-engineer": {
    description: "VCM task-scoped harness maintenance role for harness diagnosis, diff proposals, and VCM issue drafts.",
    tools: "Read, Grep, Glob, Bash, Edit, Write, Skill"
  },
  "vcm-coder-worker": {
    description: "Bounded VCM implementation worker for assigned modules, files, and VCM:CODE markers from Coder.",
    model: "inherit"
  },
  "vcm-architect-scaffold-worker": {
    description: "Foreground Architect worker for exact scaffold execution and scaffold validation.",
    model: "opus",
    effort: "xhigh"
  }
};

const REQUIRED_AGENT_DISALLOWED_TOOLS = {
  architect: CODE_ROLE_DISALLOWED_TOOLS,
  coder: CODE_ROLE_DISALLOWED_TOOLS,
  reviewer: REVIEWER_DISALLOWED_TOOLS
};
const REQUIRED_AGENT_TOOLS = {
  "project-manager": ["Skill"],
  tester: ["Skill"],
  "harness-engineer": ["Skill"]
};
const REQUIRED_AGENT_SKILLS = {
  architect: ["vcm-code-navigation"]
};
const REMOVED_AGENT_SKILLS = {
  coder: ["vcm-code-navigation"],
  reviewer: ["vcm-code-navigation"]
};

const MANAGED_FILES = [
  {
    path: "CLAUDE.md",
    title: "CLAUDE.md",
    commentStyle: "html",
    category: "root-rules",
    blankLineBeforeEnd: true,
    memoryBlock: true,
    content: renderRootClaudeHarnessRules()
  },
  {
    path: "docs/CODING_STANDARDS.md",
    title: "Coding Standards",
    commentStyle: "html",
    category: "project-coding-standards",
    content: renderProjectCodingStandardsRules(),
    contentAfterBlock: renderProjectCodingStandardsProjectSection(),
    legacyWholeFile: renderLegacyProjectCodingStandardsTemplate()
  },
  {
    path: "docs/known-issues.md",
    title: "Known Issues",
    commentStyle: "html",
    category: "project-known-issues",
    content: renderProjectKnownIssuesRules(),
    contentAfterBlock: renderProjectKnownIssuesSection(),
    legacyWholeFile: renderLegacyProjectKnownIssuesTemplate()
  },
  {
    path: ".gitignore",
    title: ".gitignore",
    commentStyle: "hash",
    category: "ignore-rules",
    content: renderGitignoreHarnessRules()
  },
  {
    path: ".claude/agents/project-manager.md",
    title: "Project Manager Agent",
    agentName: "project-manager",
    commentStyle: "html",
    category: "core-agent",
    memoryBlock: true,
    content: renderProjectManagerHarnessRules()
  },
  {
    path: ".claude/agents/architect.md",
    title: "Architect Agent",
    agentName: "architect",
    commentStyle: "html",
    category: "core-agent",
    blankLineBeforeEnd: true,
    memoryBlock: true,
    content: renderArchitectHarnessRules()
  },
  {
    path: ".claude/agents/coder.md",
    title: "Coder Agent",
    agentName: "coder",
    commentStyle: "html",
    category: "core-agent",
    memoryBlock: true,
    content: renderCoderHarnessRules()
  },
  {
    path: ".claude/agents/tester.md",
    title: "Tester Agent",
    agentName: "tester",
    commentStyle: "html",
    category: "core-agent",
    memoryBlock: true,
    content: renderTesterHarnessRules()
  },
  {
    path: ".github/pull_request_template.md",
    title: "Pull Request Template",
    commentStyle: "html",
    category: "pull-request-template",
    content: renderPullRequestTemplateHarnessRules()
  },
  {
    path: ".claude/agents/reviewer.md",
    title: "Reviewer Agent",
    agentName: "reviewer",
    commentStyle: "html",
    category: "reviewer-agent",
    memoryBlock: true,
    content: renderReviewerAgentRules()
  },
  {
    path: ".claude/agents/translator.md",
    title: "Translator Agent",
    agentName: "translator",
    commentStyle: "html",
    category: "agent-translator",
    content: renderTranslatorAgentRules()
  },
  {
    path: ".claude/agents/harness-engineer.md",
    title: "Harness Engineer Agent",
    agentName: "harness-engineer",
    commentStyle: "html",
    category: "agent-harness-engineer",
    memoryBlock: true,
    content: renderHarnessEngineerHarnessRules()
  },
  {
    path: ".claude/agents/vcm-coder-worker.md",
    title: "VCM Coder Worker Agent",
    agentName: "vcm-coder-worker",
    commentStyle: "html",
    category: "agent-coder-worker",
    content: renderCoderWorkerHarnessRules()
  },
  {
    path: ".claude/agents/vcm-architect-scaffold-worker.md",
    title: "VCM Architect Scaffold Worker Agent",
    agentName: "vcm-architect-scaffold-worker",
    commentStyle: "html",
    category: "agent-architect-scaffold-worker",
    content: renderArchitectScaffoldWorkerHarnessRules()
  }
];

const DURABLE_DOC_TEMPLATES = [
  {
    path: "docs/GLOSSARY.md",
    content: renderProjectGlossaryTemplate()
  },
  {
    path: "docs/ARCHITECTURE.md",
    content: "# Architecture\n"
  },
  {
    path: "docs/TESTING.md",
    content: "# Testing\n"
  },
];

const PROJECT_OWNED_FILES = [
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
  }
];

const WHOLE_FILES = [
  {
    path: ".ai/tools/check-durable-docs",
    category: "durable-docs-tool",
    mode: 0o755,
    templatePath: "scripts/harness-tools/check-durable-docs"
  },
  {
    path: ".claude/skills/vcm-architecture-interview/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Architecture Interview Skill",
      "vcm-architecture-interview",
      "Use when Architect must confirm user-owned behavior and contract decisions before architecture planning.",
      renderVcmArchitectureInterviewSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-code-navigation/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Code Navigation Skill",
      "vcm-code-navigation",
      "Use when Architect must resolve code symbols, references, implementations, call hierarchies, or bounded dependency paths.",
      renderVcmCodeNavigationSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-final-acceptance/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Final Acceptance Skill",
      "vcm-final-acceptance",
      "Use when project-manager is ready to close a complete VCM code-delivery flow.",
      renderVcmFinalAcceptanceSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-harness-bootstrap/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Harness Bootstrap Skill",
      "vcm-harness-bootstrap",
      "Use when VCM needs AI-assisted project understanding to finish or refresh project-specific harness content.",
      renderVcmHarnessBootstrapSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-long-running-validation/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Long-Running Validation Skill",
      "vcm-long-running-validation",
      "Use for builds, browser checks, E2E tests, release suites, or any validation command that may take long enough for shell-completion callbacks to become unreliable.",
      renderVcmLongRunningValidationSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-route-message/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Route Message Skill",
      "vcm-route-message",
      "Use when project-manager dispatches a VCM role or when a VCM role reports a question, result, blocker, or finding back to project-manager.",
      renderVcmRouteMessageSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-ask-user/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Ask User Skill",
      "vcm-ask-user",
      "Use whenever project-manager asks the user a question and must pause the workflow.",
      renderVcmAskUserSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-task-state/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Task State Skill",
      "vcm-task-state",
      "Use only as project-manager to declare the current task workflow checkpoint to VCM.",
      renderVcmTaskStateSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-workflow-review/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Workflow Review Skill",
      "vcm-workflow-review",
      "Use before every project-manager dispatch to Architect, Coder, or Tester so VCM can approve the workflow transition.",
      renderVcmWorkflowReviewSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-gate-review/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Gate Review Skill",
      "vcm-gate-review",
      "Use when project-manager reaches a Gate Review trigger or receives a VCM Gate Review callback.",
      renderVcmGateReviewSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-report-harness-issue/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Report Harness Issue Skill",
      "vcm-report-harness-issue",
      "Use when a VCM role notices a reusable harness problem and needs to record feedback for Harness Engineer review.",
      renderVcmReportHarnessIssueSkillRules()
    )
  },
  {
    path: ".claude/skills/vcm-propose-memory/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "VCM Propose Memory Skill",
      "vcm-propose-memory",
      "Use only when VCM requests a role memory proposal during Task Harness Review.",
      renderVcmProposeMemorySkillRules()
    )
  },
  {
    path: ".claude/skills/restart-architect/SKILL.md",
    category: "skill",
    mode: 0o644,
    content: renderSkillFile(
      "Restart Architect Skill",
      "restart-architect",
      "Use after Architect completes and commits architecture planning and scaffold work.",
      renderRestartArchitectSkillRules()
    )
  },
  {
    path: ".ai/tools/request-gate-review",
    category: "runtime-tool",
    mode: 0o755,
    content: renderRequestGateReviewTool()
  },
  {
    path: ".ai/tools/vcm-ask-user",
    category: "runtime-tool",
    mode: 0o755,
    content: renderAskUserTool()
  },
  {
    path: ".ai/tools/update-task-state",
    category: "runtime-tool",
    mode: 0o755,
    content: renderUpdateTaskStateTool()
  },
  {
    path: ".ai/tools/check-scaffold-ledger",
    category: "runtime-tool",
    mode: 0o755,
    content: renderCheckScaffoldLedgerTool()
  },
  {
    path: ".ai/tools/request-architect-restart",
    category: "runtime-tool",
    mode: 0o755,
    content: renderRequestArchitectRestartTool()
  },
  {
    path: ".ai/tools/resolve-durable-doc-assignment",
    category: "runtime-tool",
    mode: 0o755,
    content: renderResolveDurableDocAssignmentTool()
  },
  {
    path: ".ai/tools/run-long-check",
    category: "runtime-tool",
    mode: 0o755,
    templatePath: "scripts/harness-tools/run-long-check"
  },
  {
    path: ".ai/tools/watch-job",
    category: "runtime-tool",
    mode: 0o755,
    templatePath: "scripts/harness-tools/watch-job"
  },
  {
    path: ".ai/tools/vcm-bash-guard",
    category: "runtime-tool",
    mode: 0o755,
    templatePath: "scripts/harness-tools/vcm-bash-guard"
  },
  {
    path: ".ai/tools/vcm-artifact",
    category: "runtime-tool",
    mode: 0o755,
    templatePath: "scripts/harness-tools/vcm-artifact"
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

  await migrateReviewerAgent({ projectRoot, dryRun, operations });
  const manifest = await buildManifest(projectRoot);
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
  for (const file of PROJECT_OWNED_FILES) {
    await installProjectOwnedFile({ projectRoot, file, dryRun, operations });
  }
  await removeLegacyFlatSkillFiles({ projectRoot, dryRun, operations });
  await removeLegacyCodexHarnessPaths({ projectRoot, dryRun, operations });
  await installManifest({
    projectRoot,
    manifest,
    dryRun,
    operations,
    forceWrite: hasRealHarnessChange(operations)
  });

  printReport({ projectRoot, dryRun, operations });
}

async function migrateReviewerAgent({ projectRoot, dryRun, operations }) {
  const legacyPath = resolveInside(projectRoot, LEGACY_REVIEWER_AGENT_PATH);
  const legacyContent = await readOptionalText(legacyPath);
  if (legacyContent === undefined) {
    return;
  }

  const reviewerPath = resolveInside(projectRoot, REVIEWER_AGENT_PATH);
  const reviewerContent = await readOptionalText(reviewerPath);
  if (dryRun) {
    operations.push(plan(
      LEGACY_REVIEWER_AGENT_PATH,
      reviewerContent === undefined
        ? `rename to ${REVIEWER_AGENT_PATH}`
        : `delete after ${REVIEWER_AGENT_PATH} was installed`
    ));
    return;
  }

  if (reviewerContent === undefined) {
    const migratedContent = legacyContent
      .replace(/^name:[ \t]*gate-reviewer[ \t]*$/m, "name: reviewer")
      .replace(/^# Gate Reviewer Agent[ \t]*$/m, "# Reviewer Agent");
    await fs.mkdir(path.dirname(reviewerPath), { recursive: true });
    await fs.writeFile(reviewerPath, migratedContent, "utf8");
  }
  await fs.rm(legacyPath, { force: true });
  operations.push(done(
    LEGACY_REVIEWER_AGENT_PATH,
    reviewerContent === undefined
      ? `renamed to ${REVIEWER_AGENT_PATH}`
      : `deleted after ${REVIEWER_AGENT_PATH} was installed`
  ));
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
missing and installs generated-context tools for Rust and npm workspace projects. It does not copy
example project docs, generated context artifacts, module-level architecture
docs, or task runtime handoff artifacts.`);
}

async function buildManifest(projectRoot) {
  const current = await readOptionalJson(path.join(projectRoot, MANIFEST_PATH));
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    manager: "vcm",
    harnessVersion: VCM_PACKAGE_VERSION,
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
          topLevelKeys: ["hooks", "env"],
          hookMatchers: ["VCM"],
          envKeys: ["BASH_DEFAULT_TIMEOUT_MS"]
        },
        uninstall: {
          action: "remove-owned-json-keys",
          requiresConfirmation: false
        }
      },
      ...fixedDirectories().map((directory) => manifestEntry(directory, "directory", directoryCategory(directory), "vcm-created")),
      manifestEntry("docs/GLOSSARY.md", "file", "project-glossary", "project-owned"),
      manifestEntry("docs/CODING_STANDARDS.md", "file", "project-coding-standards", "project-owned"),
      ...PROJECT_OWNED_FILES.map((file) => ({
        path: file.path,
        entryType: "file",
        category: file.category,
        ownership: "project-owned",
        source: "vcm-template",
        lifecycle: "long-term"
      })),
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
    ".claude/skills/vcm-ask-user/",
    ".claude/skills/vcm-task-state/",
    ".claude/skills/vcm-workflow-review/",
    ".claude/skills/vcm-gate-review/",
    ".claude/skills/vcm-report-harness-issue/",
    ".claude/skills/vcm-propose-memory/",
    ".claude/skills/restart-architect/",
    ".ai/vcm/translations/",
    ".ai/vcm/gate-reviews/",
    ".ai/tools/",
    ".ai/generated/"
  ];
}

function directoryCategory(directory) {
  if (directory === ".claude/agents/") {
    return "agent-directory";
  }
  if (directory === ".claude/skills/" || directory.startsWith(".claude/skills/")) {
    return "skill-directory";
  }
  if (directory === ".ai/generated/") {
    return "generated-context-directory";
  }
  return "harness-tool-directory";
}

async function installManifest({ projectRoot, manifest, dryRun, operations, forceWrite = false }) {
  const targetPath = path.join(projectRoot, MANIFEST_PATH);
  const currentManifest = await readOptionalJson(targetPath);

  if (currentManifest && manifestBodyEqual(currentManifest, manifest)) {
    operations.push(skip(MANIFEST_PATH, "unchanged"));
    return;
  }
  if (!forceWrite && currentManifest && manifestBodyEqual(currentManifest, manifest, { ignoreHarnessVersion: true })) {
    operations.push(skip(MANIFEST_PATH, "version-only change ignored"));
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
    if (pattern.test(currentContent)) {
      nextContent = currentContent.replace(pattern, block);
    } else {
      nextContent = migrateLegacyManagedFile(definition, currentContent, block)
        ?? `${currentContent.trimEnd()}\n\n${block}\n`;
    }
  }
  if (definition.memoryBlock) {
    nextContent = ensureVcmMemoryBlock(nextContent);
  }
  for (const requiredTool of REQUIRED_AGENT_TOOLS[definition.agentName] ?? []) {
    nextContent = ensureAgentAllowedTool(nextContent, requiredTool);
  }
  const requiredDisallowedTools = REQUIRED_AGENT_DISALLOWED_TOOLS[definition.agentName];
  if (requiredDisallowedTools) {
    nextContent = ensureAgentDisallowedTools(nextContent, requiredDisallowedTools);
  }
  for (const requiredSkill of REQUIRED_AGENT_SKILLS[definition.agentName] ?? []) {
    nextContent = ensureAgentSkill(nextContent, requiredSkill);
  }
  for (const removedSkill of REMOVED_AGENT_SKILLS[definition.agentName] ?? []) {
    nextContent = removeAgentSkill(nextContent, removedSkill);
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
  const suffix = definition.contentAfterBlock?.trim();
  if (definition.agentName) {
    const frontmatter = AGENT_FRONTMATTER[definition.agentName];
    const toolPolicy = frontmatter.disallowedTools
      ? `disallowedTools: ${frontmatter.disallowedTools}`
      : `tools: ${frontmatter.tools ?? "Read, Grep, Glob, Bash, Edit, Write"}`;
    const model = frontmatter.model ? `\nmodel: ${frontmatter.model}` : "";
    const effort = frontmatter.effort ? `\neffort: ${frontmatter.effort}` : "";
    const skills = frontmatter.skills?.length
      ? `\nskills:\n${frontmatter.skills.map((skill) => `  - ${skill}`).join("\n")}`
      : "";
    return `---\nname: ${definition.agentName}\ndescription: ${frontmatter.description}\n${toolPolicy}${model}${effort}${skills}\n---\n\n# ${definition.title}\n\n${block}${suffix ? `\n\n${suffix}` : ""}\n`;
  }
  return `# ${definition.title}\n\n${block}${suffix ? `\n\n${suffix}` : ""}\n`;
}

function ensureAgentDisallowedTools(content, requiredTools) {
  const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!frontmatterMatch) {
    return content;
  }

  const withoutAllowedTools = frontmatterMatch[0].replace(/^tools:\s*.*\r?\n?/m, "");
  const disallowedMatch = withoutAllowedTools.match(/^disallowedTools:\s*(.*)$/m);
  const existing = disallowedMatch?.[1]
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean) ?? [];
  const disallowedTools = [...new Set([...existing, ...requiredTools])].join(", ");
  const nextFrontmatter = disallowedMatch
    ? withoutAllowedTools.replace(disallowedMatch[0], `disallowedTools: ${disallowedTools}`)
    : withoutAllowedTools.replace(/\r?\n---$/, `\ndisallowedTools: ${disallowedTools}\n---`);
  return content.replace(frontmatterMatch[0], nextFrontmatter);
}

function ensureAgentAllowedTool(content, requiredTool) {
  const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!frontmatterMatch) {
    return content;
  }

  const frontmatter = frontmatterMatch[0];
  const toolsMatch = frontmatter.match(/^tools:\s*(.*)$/m);
  if (toolsMatch) {
    const existing = toolsMatch[1]
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
    if (existing.includes(requiredTool)) {
      return content;
    }
    return content.replace(
      frontmatter,
      frontmatter.replace(toolsMatch[0], `tools: ${[...existing, requiredTool].join(", ")}`)
    );
  }

  const disallowedMatch = frontmatter.match(/^disallowedTools:\s*(.*)$/m);
  if (!disallowedMatch) {
    return content;
  }
  const disallowedTools = disallowedMatch[1]
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool && tool !== requiredTool);
  const nextFrontmatter = disallowedTools.length > 0
    ? frontmatter.replace(disallowedMatch[0], `disallowedTools: ${disallowedTools.join(", ")}`)
    : frontmatter.replace(/^disallowedTools:\s*.*\r?\n?/m, "");
  return content.replace(frontmatter, nextFrontmatter);
}

function ensureAgentSkill(content, requiredSkill) {
  const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!frontmatterMatch) {
    return content;
  }

  const frontmatter = frontmatterMatch[0];
  const skillsMatch = frontmatter.match(/^skills:[ \t]*(?:\r?\n((?:\s+-\s+[^\r\n]+\r?\n?)*))?/m);
  if (!skillsMatch) {
    return content.replace(
      frontmatter,
      frontmatter.replace(/\r?\n---$/, `\nskills:\n  - ${requiredSkill}\n---`)
    );
  }

  const listedSkills = (skillsMatch[1] ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s+-\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
  if (listedSkills.includes(requiredSkill)) {
    return content;
  }

  const nextSkills = `${skillsMatch[0].trimEnd()}\n  - ${requiredSkill}`;
  return content.replace(frontmatter, frontmatter.replace(skillsMatch[0], nextSkills));
}

function removeAgentSkill(content, removedSkill) {
  const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!frontmatterMatch) {
    return content;
  }

  const frontmatter = frontmatterMatch[0];
  const skillsMatch = frontmatter.match(/^skills:[ \t]*(?:\r?\n((?:\s+-\s+[^\r\n]+\r?\n?)*))?/m);
  if (!skillsMatch) {
    return content;
  }

  const listedSkills = (skillsMatch[1] ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s+-\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
  const remainingSkills = listedSkills.filter((skill) => skill !== removedSkill);
  if (remainingSkills.length === listedSkills.length) {
    return content;
  }

  const lineEnding = skillsMatch[0].includes("\r\n") ? "\r\n" : "\n";
  const replacement = remainingSkills.length > 0
    ? `skills:${lineEnding}${remainingSkills.map((skill) => `  - ${skill}`).join(lineEnding)}${lineEnding}`
    : "";
  return content.replace(frontmatter, frontmatter.replace(skillsMatch[0], replacement));
}

function migrateLegacyManagedFile(definition, currentContent, block) {
  const legacyContent = definition.legacyWholeFile?.trimEnd();
  if (!legacyContent) {
    return undefined;
  }
  const current = currentContent.trimEnd();
  if (current !== legacyContent && !current.startsWith(`${legacyContent}\n`)) {
    return undefined;
  }
  const projectContent = current.slice(legacyContent.length).trim();
  return renderNewManagedFile({
    ...definition,
    contentAfterBlock: projectContent || definition.contentAfterBlock
  }, block);
}

function renderSkillFile(title, name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${title}\n\n${body.trimEnd()}\n`;
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
    action: "merge VCM Claude settings"
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

  for (const definition of VCM_HOOK_DEFINITIONS) {
    hooks[definition.eventName] = [
      ...(Array.isArray(hooks[definition.eventName]) ? hooks[definition.eventName] : []),
      {
        ...(definition.matcher ? { matcher: definition.matcher } : {}),
        hooks: [
          {
            type: "command",
            command: definition.command,
            timeout: definition.timeout
          }
        ]
      }
    ];
  }

  next.hooks = hooks;

  const env = isPlainObject(next.env) ? { ...next.env } : {};
  env.BASH_DEFAULT_TIMEOUT_MS = VCM_BASH_DEFAULT_TIMEOUT_MS;
  next.env = env;
  next.autoMemoryEnabled = VCM_AUTO_MEMORY_ENABLED;

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

async function installProjectOwnedFile({ projectRoot, file, dryRun, operations }) {
  const targetPath = resolveInside(projectRoot, file.path);
  if (await pathExists(targetPath)) {
    operations.push(skip(file.path, "exists; project-owned"));
    return;
  }

  const content = await wholeFileContent(file);
  await writeIfChanged({
    targetPath,
    relativePath: file.path,
    content: ensureTrailingNewline(content),
    mode: file.mode,
    dryRun,
    operations,
    action: "seed project-owned VCM file"
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

async function removeLegacyCodexHarnessPaths({ projectRoot, dryRun, operations }) {
  for (const relativePath of LEGACY_CODEX_HARNESS_PATHS) {
    const targetPath = resolveInside(projectRoot, relativePath);
    if (!await pathExists(targetPath)) {
      continue;
    }
    if (dryRun) {
      operations.push(plan(relativePath, "delete legacy Codex harness path"));
      continue;
    }

    await fs.rm(targetPath, { recursive: true, force: true });
    operations.push(done(relativePath, "deleted legacy Codex harness path"));
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
    const templateAbsolutePath = path.join(APP_ROOT, file.templatePath);
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

function manifestBodyEqual(left, right, options = {}) {
  const normalizedLeft = { ...left };
  const normalizedRight = { ...right };
  delete normalizedLeft.installedAt;
  delete normalizedLeft.updatedAt;
  delete normalizedRight.installedAt;
  delete normalizedRight.updatedAt;
  if (options.ignoreHarnessVersion) {
    delete normalizedLeft.harnessVersion;
    delete normalizedRight.harnessVersion;
  }
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function hasRealHarnessChange(operations) {
  return operations.some((operation) =>
    operation.path !== MANIFEST_PATH &&
    (operation.status === "done" || operation.status === "plan")
  );
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
