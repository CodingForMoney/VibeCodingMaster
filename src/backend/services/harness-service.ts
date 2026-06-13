import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  HarnessApplyResult,
  HarnessBootstrapCheck,
  HarnessBootstrapSession,
  HarnessBootstrapStatusReport,
  HarnessFileAction,
  HarnessFileKind,
  HarnessFileStatus,
  HarnessPlannedChange,
  HarnessStatusReport,
  StartHarnessBootstrapRequest,
  StartHarnessBootstrapResult
} from "../../shared/types/harness.js";
import type { ClaudePermissionMode } from "../../shared/types/session.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { renderArchitectHarnessRules } from "../templates/harness/architect-agent.js";
import { renderCoderHarnessRules } from "../templates/harness/coder-agent.js";
import {
  renderCodexAgentsHarnessRules,
  renderCodexArchitecturePlanPrompt,
  renderCodexConfigHarnessRules,
  renderCodexFinalDiffPrompt,
  renderCodexReviewResultSchema,
  renderCodexValidationAdequacyPrompt,
  renderRequestCodexReviewTool,
  renderVcmCodexReviewGateSkillRules
} from "../templates/harness/codex-review.js";
import { renderRootClaudeHarnessRules } from "../templates/harness/claude-root.js";
import { renderGitignoreHarnessRules } from "../templates/harness/gitignore.js";
import { renderProjectManagerHarnessRules } from "../templates/harness/project-manager-agent.js";
import { renderPullRequestTemplateHarnessRules } from "../templates/harness/pull-request-template.js";
import { renderReviewerHarnessRules } from "../templates/harness/reviewer-agent.js";
import { renderVcmFinalAcceptanceSkillRules } from "../templates/harness/vcm-final-acceptance-skill.js";
import { renderVcmHarnessBootstrapSkillRules } from "../templates/harness/vcm-harness-bootstrap-skill.js";
import { renderVcmLongRunningValidationSkillRules } from "../templates/harness/vcm-long-running-validation-skill.js";
import { renderVcmRouteMessageSkillRules } from "../templates/harness/vcm-route-message-skill.js";
import type { ProjectService } from "./project-service.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import { VcmError } from "../errors.js";

const execFileAsync = promisify(execFile);
const BOOTSTRAP_TASK_SLUG = "__vcm-harness-bootstrap__";
const BOOTSTRAP_RUNTIME_ROLE = "project-manager";
const BOOTSTRAP_LOG_PATH = ".ai/vcm/bootstrap/bootstrap.log";
const BOOTSTRAP_SESSION_PATH = ".ai/vcm/bootstrap/session.json";

export interface HarnessService {
  getHarnessStatus(repoRoot: string): Promise<HarnessStatusReport>;
  applyHarness(repoRoot: string): Promise<HarnessApplyResult>;
  getBootstrapStatus(repoRoot: string): Promise<HarnessBootstrapStatusReport>;
  startHarnessBootstrap(repoRoot: string, input?: StartHarnessBootstrapRequest): Promise<StartHarnessBootstrapResult>;
}

export interface HarnessServiceDeps {
  fs: FileSystemAdapter;
  runtime?: TerminalRuntime;
  projectService?: Pick<ProjectService, "loadConfig">;
  apiUrl?: string;
  now?: () => string;
  runFixedInstaller?: (repoRoot: string) => Promise<HarnessApplyResult>;
}

interface HarnessFileDefinition {
  kind: HarnessFileKind;
  path: string;
  title: string;
  frontmatter?: string;
  commentStyle?: "html" | "hash";
  ownership?: "managed-block" | "whole-file" | "raw-file";
  blankLineBeforeEnd?: boolean;
  renderRules(): string;
}

interface HarnessFileAnalysis {
  definition: HarnessFileDefinition;
  status: HarnessFileStatus;
  plannedChange?: HarnessPlannedChange;
  nextContent?: string;
}

export const VCM_HARNESS_VERSION = 1;

const MANAGED_BLOCK_PATTERN = /<!-- VCM:BEGIN(?:\s+version=(\d+))? -->[\s\S]*?<!-- VCM:END -->/m;
const HASH_MANAGED_BLOCK_PATTERN = /# VCM:BEGIN(?:\s+version=(\d+))?\n[\s\S]*?# VCM:END/m;
const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
const VCM_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ] || [ -z "\${VCM_API_URL:-}" ]; then exit 0; fi; node -e '"'"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let event={};try{event=s.trim()?JSON.parse(s):{};}catch{event={raw:s};}process.stdout.write(JSON.stringify({taskSlug:process.env.VCM_TASK_SLUG,role:process.env.VCM_ROLE,event}));});'"'"' | curl -fsS --max-time 2 -X POST "\${VCM_API_URL}/api/hooks/claude-code" -H "content-type: application/json" --data-binary @- >/dev/null || true'`;
const VCM_STOP_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ] || [ -z "\${VCM_API_URL:-}" ]; then exit 0; fi; node -e '"'"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let event={};try{event=s.trim()?JSON.parse(s):{};}catch{event={raw:s};}process.stdout.write(JSON.stringify({taskSlug:process.env.VCM_TASK_SLUG,role:process.env.VCM_ROLE,event}));});'"'"' | curl -fsS --max-time 5 -X POST "\${VCM_API_URL}/api/hooks/claude-code/stop" -H "content-type: application/json" --data-binary @- || true'`;
const VCM_PERMISSION_REQUEST_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ] || [ -z "\${VCM_API_URL:-}" ]; then exit 0; fi; node -e '"'"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let event={};try{event=s.trim()?JSON.parse(s):{};}catch{event={raw:s};}process.stdout.write(JSON.stringify({taskSlug:process.env.VCM_TASK_SLUG,role:process.env.VCM_ROLE,event}));});'"'"' | curl -fsS --max-time 5 -X POST "\${VCM_API_URL}/api/hooks/claude-code/permission-request" -H "content-type: application/json" --data-binary @- || true'`;
const VCM_BASH_GUARD_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ]; then exit 0; fi; exec python3 "\${CLAUDE_PROJECT_DIR:-.}/.ai/tools/vcm-bash-guard"'`;
const VCM_BASH_DEFAULT_TIMEOUT_MS = "600000";
const VCM_HOOK_DEFINITIONS: ReadonlyArray<{ eventName: string; matcher?: string; command: string; timeout: number }> = [
  { eventName: "PreToolUse", matcher: "Bash", command: VCM_BASH_GUARD_HOOK_COMMAND, timeout: 10 },
  { eventName: "UserPromptSubmit", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "Stop", command: VCM_STOP_HOOK_COMMAND, timeout: 10 },
  { eventName: "PermissionRequest", command: VCM_PERMISSION_REQUEST_HOOK_COMMAND, timeout: 5 }
];

const HARNESS_FILES: HarnessFileDefinition[] = [
  {
    kind: "root-claude",
    path: "CLAUDE.md",
    title: "CLAUDE.md",
    blankLineBeforeEnd: true,
    renderRules: renderRootClaudeHarnessRules
  },
  {
    kind: "gitignore",
    path: ".gitignore",
    title: ".gitignore",
    commentStyle: "hash",
    renderRules: renderGitignoreHarnessRules
  },
  {
    kind: "pull-request-template",
    path: ".github/pull_request_template.md",
    title: "Pull Request Template",
    renderRules: renderPullRequestTemplateHarnessRules
  },
  {
    kind: "skill-vcm-route-message",
    path: ".claude/skills/vcm-route-message/SKILL.md",
    title: "VCM Route Message Skill",
    frontmatter: renderSkillFrontmatter(
      "vcm-route-message",
      "Use when a VCM role needs to hand off work, ask a question, report a result, report a blocker, or raise a finding to another VCM role."
    ),
    ownership: "whole-file",
    renderRules: renderVcmRouteMessageSkillRules
  },
  {
    kind: "skill-vcm-final-acceptance",
    path: ".claude/skills/vcm-final-acceptance/SKILL.md",
    title: "VCM Final Acceptance Skill",
    frontmatter: renderSkillFrontmatter(
      "vcm-final-acceptance",
      "Use when project-manager is ready to decide whether a VCM-managed task can be accepted, returned for follow-up, or blocked for a decision."
    ),
    ownership: "whole-file",
    renderRules: renderVcmFinalAcceptanceSkillRules
  },
  {
    kind: "skill-vcm-harness-bootstrap",
    path: ".claude/skills/vcm-harness-bootstrap/SKILL.md",
    title: "VCM Harness Bootstrap Skill",
    frontmatter: renderSkillFrontmatter(
      "vcm-harness-bootstrap",
      "Use when VCM needs AI-assisted project understanding to finish or refresh project-specific harness content."
    ),
    ownership: "whole-file",
    renderRules: renderVcmHarnessBootstrapSkillRules
  },
  {
    kind: "skill-vcm-long-running-validation",
    path: ".claude/skills/vcm-long-running-validation/SKILL.md",
    title: "VCM Long-Running Validation Skill",
    frontmatter: renderSkillFrontmatter(
      "vcm-long-running-validation",
      "Use for builds, browser checks, E2E tests, release suites, or any validation command that may take long enough for shell-completion callbacks to become unreliable."
    ),
    ownership: "whole-file",
    renderRules: renderVcmLongRunningValidationSkillRules
  },
  {
    kind: "skill-vcm-codex-review-gate",
    path: ".claude/skills/vcm-codex-review-gate/SKILL.md",
    title: "VCM Codex Review Gate Skill",
    frontmatter: renderSkillFrontmatter(
      "vcm-codex-review-gate",
      "Use when project-manager reaches a Codex Review Gate or receives a VCM Codex Review callback."
    ),
    ownership: "whole-file",
    renderRules: renderVcmCodexReviewGateSkillRules
  },
  {
    kind: "codex-agents",
    path: ".ai/codex/AGENTS.md",
    title: "VCM Codex Reviewer",
    renderRules: renderCodexAgentsHarnessRules
  },
  {
    kind: "codex-config",
    path: ".ai/codex/config.toml",
    title: "VCM Codex Config",
    ownership: "raw-file",
    renderRules: renderCodexConfigHarnessRules
  },
  {
    kind: "codex-prompt-architecture-plan",
    path: ".ai/codex/prompts/architecture-plan-gate.md",
    title: "Codex Architecture Plan Gate Prompt",
    ownership: "raw-file",
    renderRules: renderCodexArchitecturePlanPrompt
  },
  {
    kind: "codex-prompt-validation-adequacy",
    path: ".ai/codex/prompts/validation-adequacy-gate.md",
    title: "Codex Validation Adequacy Gate Prompt",
    ownership: "raw-file",
    renderRules: renderCodexValidationAdequacyPrompt
  },
  {
    kind: "codex-prompt-final-diff",
    path: ".ai/codex/prompts/final-diff-gate.md",
    title: "Codex Final Diff Gate Prompt",
    ownership: "raw-file",
    renderRules: renderCodexFinalDiffPrompt
  },
  {
    kind: "codex-review-schema",
    path: ".ai/codex/schemas/codex-review-result.schema.json",
    title: "Codex Review Result Schema",
    ownership: "raw-file",
    renderRules: renderCodexReviewResultSchema
  },
  {
    kind: "tool-request-codex-review",
    path: ".ai/tools/request-codex-review",
    title: "Request Codex Review Tool",
    ownership: "raw-file",
    renderRules: renderRequestCodexReviewTool
  },
  {
    kind: "agent-project-manager",
    path: ".claude/agents/project-manager.md",
    title: "Project Manager Agent",
    frontmatter: renderAgentFrontmatter(
      "project-manager",
      "User-facing VCM orchestration role for task clarification, role routing, handoffs, acceptance, and PR preparation."
    ),
    renderRules: renderProjectManagerHarnessRules
  },
  {
    kind: "agent-architect",
    path: ".claude/agents/architect.md",
    title: "Architect Agent",
    blankLineBeforeEnd: true,
    frontmatter: renderAgentFrontmatter(
      "architect",
      "VCM architecture role for plans, module boundaries, public contracts, verifiable behavior, and docs sync."
    ),
    renderRules: renderArchitectHarnessRules
  },
  {
    kind: "agent-coder",
    path: ".claude/agents/coder.md",
    title: "Coder Agent",
    frontmatter: renderAgentFrontmatter(
      "coder",
      "VCM implementation role for scoped code changes and focused tests."
    ),
    renderRules: renderCoderHarnessRules
  },
  {
    kind: "agent-reviewer",
    path: ".claude/agents/reviewer.md",
    title: "Reviewer Agent",
    frontmatter: renderAgentFrontmatter(
      "reviewer",
      "VCM independent review role for acceptance, test adequacy, scope checks, and risk findings."
    ),
    renderRules: renderReviewerHarnessRules
  }
];

export function createHarnessService(deps: HarnessServiceDeps): HarnessService {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async getHarnessStatus(repoRoot) {
      const analyses = await analyzeHarnessFiles(deps.fs, repoRoot);
      return renderHarnessStatus(analyses);
    },
    async applyHarness(repoRoot) {
      if (deps.runFixedInstaller) {
        return deps.runFixedInstaller(repoRoot);
      }

      const analyses = await analyzeHarnessFiles(deps.fs, repoRoot);
      const changedFiles: HarnessPlannedChange[] = [];

      for (const analysis of analyses) {
        if (analysis.status.action === "ok" || !analysis.nextContent) {
          continue;
        }
        await deps.fs.writeText(resolveHarnessPath(repoRoot, analysis.definition.path), analysis.nextContent);
        if (analysis.plannedChange) {
          changedFiles.push(analysis.plannedChange);
        }
      }

      return {
        version: VCM_HARNESS_VERSION,
        changedFiles,
        message: changedFiles.length === 0
          ? "VCM Harness is already up to date."
          : "VCM Harness updated. Review these files and commit the harness changes before starting long-running work."
      };
    },
    async getBootstrapStatus(repoRoot) {
      return getHarnessBootstrapStatus(deps, repoRoot, now);
    },
    async startHarnessBootstrap(repoRoot, input = {}) {
      if (!deps.runtime || !deps.projectService) {
        throw new VcmError({
          code: "HARNESS_BOOTSTRAP_UNAVAILABLE",
          message: "Harness bootstrap sessions are not available in this VCM runtime.",
          statusCode: 501
        });
      }

      const currentStatus = await getHarnessBootstrapStatus(deps, repoRoot, now);
      if (currentStatus.session?.status === "running") {
        return {
          status: currentStatus,
          session: currentStatus.session,
          prompt: buildHarnessBootstrapPrompt(repoRoot)
        };
      }
      if (!currentStatus.canStart) {
        throw new VcmError({
          code: "HARNESS_BOOTSTRAP_NOT_READY",
          message: "Install the fixed VCM harness before running harness bootstrap.",
          statusCode: 409
        });
      }

      const config = await deps.projectService.loadConfig(repoRoot);
      const claudeSessionId = randomUUID();
      const command = buildClaudeStartCommand(config.claudeCommand, "default", claudeSessionId);
      const logPath = path.join(repoRoot, BOOTSTRAP_LOG_PATH);
      const runtimeSession = await deps.runtime.createSession({
        taskSlug: BOOTSTRAP_TASK_SLUG,
        role: BOOTSTRAP_RUNTIME_ROLE,
        command: command.command,
        args: command.args,
        cwd: repoRoot,
        env: {
          VCM_API_URL: deps.apiUrl,
          VCM_TASK_REPO_ROOT: repoRoot,
          VCM_HARNESS_BOOTSTRAP: "1",
          VCM_SESSION_ID: claudeSessionId
        },
        cols: input.cols,
        rows: input.rows,
        logPath
      });
      const timestamp = now();
      const session: HarnessBootstrapSession = {
        id: runtimeSession.id,
        claudeSessionId,
        status: runtimeSession.status === "crashed" ? "crashed" : runtimeSession.status === "exited" ? "exited" : "running",
        command: command.display,
        cwd: repoRoot,
        logPath: BOOTSTRAP_LOG_PATH,
        startedAt: runtimeSession.startedAt,
        updatedAt: timestamp,
        lastOutputAt: runtimeSession.lastOutputAt,
        exitCode: runtimeSession.exitCode
      };
      await persistHarnessBootstrapSession(deps.fs, repoRoot, session);

      const prompt = buildHarnessBootstrapPrompt(repoRoot);
      await submitTerminalInput(deps.runtime, runtimeSession.id, prompt);
      const nextStatus = await getHarnessBootstrapStatus(deps, repoRoot, now);

      return {
        status: {
          ...nextStatus,
          session
        },
        session,
        prompt
      };
    }
  };
}

async function analyzeHarnessFiles(fs: FileSystemAdapter, repoRoot: string): Promise<HarnessFileAnalysis[]> {
  const analyses: HarnessFileAnalysis[] = [];

  for (const definition of HARNESS_FILES) {
    analyses.push(await analyzeHarnessFile(fs, repoRoot, definition));
  }
  analyses.push(await analyzeClaudeSettingsFile(fs, repoRoot));

  return analyses;
}

async function analyzeHarnessFile(
  fs: FileSystemAdapter,
  repoRoot: string,
  definition: HarnessFileDefinition
): Promise<HarnessFileAnalysis> {
  const absolutePath = resolveHarnessPath(repoRoot, definition.path);
  const expectedContent = definition.ownership === "whole-file" || definition.ownership === "raw-file"
    ? renderWholeHarnessFile(definition)
    : undefined;
  const expectedBlock = definition.ownership === "whole-file" || definition.ownership === "raw-file"
    ? undefined
    : renderManagedBlock(definition, definition.renderRules());
  const managedBlockPattern = definition.ownership === "whole-file" || definition.ownership === "raw-file"
    ? undefined
    : getManagedBlockPattern(definition);
  const exists = await fs.pathExists(absolutePath);

  if (!exists) {
    return {
      definition,
      status: {
        kind: definition.kind,
        path: definition.path,
        exists: false,
        hasManagedBlock: false,
        action: "create"
      },
      plannedChange: {
        path: definition.path,
        action: "create",
        reason: "File is missing; VCM will create a recommended default."
      },
      nextContent: expectedContent ?? renderNewHarnessFile(definition, expectedBlock ?? "")
    };
  }

  const currentContent = await fs.readText(absolutePath);
  if (expectedContent !== undefined) {
    const action: HarnessFileAction = currentContent === expectedContent ? "ok" : "update";
    return {
      definition,
      status: {
        kind: definition.kind,
        path: definition.path,
        exists: true,
        hasManagedBlock: false,
        action
      },
      plannedChange: action === "ok"
        ? undefined
        : {
          path: definition.path,
          action,
          reason: "VCM whole-file content differs from the recommended baseline."
        },
      nextContent: action === "ok" ? undefined : expectedContent
    };
  }

  if (!expectedBlock || !managedBlockPattern) {
    throw new Error(`Invalid harness definition: ${definition.path}`);
  }

  const match = currentContent.match(managedBlockPattern);
  if (!match) {
    return {
      definition,
      status: {
        kind: definition.kind,
        path: definition.path,
        exists: true,
        hasManagedBlock: false,
        action: "insert"
      },
      plannedChange: {
        path: definition.path,
        action: "insert",
        reason: "File exists but does not contain VCM managed rules."
      },
      nextContent: `${currentContent.trimEnd()}\n\n${expectedBlock}\n`
    };
  }

  const managedVersion = match[1] ? Number(match[1]) : undefined;
  const currentBlock = match[0];
  const action: HarnessFileAction = currentBlock === expectedBlock ? "ok" : "update";

  return {
    definition,
    status: {
      kind: definition.kind,
      path: definition.path,
      exists: true,
      hasManagedBlock: true,
      managedVersion,
      action
    },
    plannedChange: action === "ok"
      ? undefined
      : {
          path: definition.path,
          action,
          reason: managedVersion === VCM_HARNESS_VERSION
            ? "VCM managed rules differ from the current recommended template."
            : `VCM managed block version is ${managedVersion ?? "missing"}; current version is ${VCM_HARNESS_VERSION}.`
        },
    nextContent: action === "ok"
      ? undefined
      : currentContent.replace(managedBlockPattern, expectedBlock)
  };
}

function renderHarnessStatus(analyses: HarnessFileAnalysis[]): HarnessStatusReport {
  const files = analyses.map((analysis) => analysis.status);
  const plannedChanges = analyses
    .map((analysis) => analysis.plannedChange)
    .filter((change): change is HarnessPlannedChange => Boolean(change));

  return {
    version: VCM_HARNESS_VERSION,
    files,
    needsApply: plannedChanges.length > 0,
    plannedChanges,
    warnings: plannedChanges.length > 0
      ? ["Review and commit VCM Harness changes before starting long-running work."]
      : []
  };
}

function renderManagedBlock(definition: HarnessFileDefinition, rules: string): string {
  const endSpacing = definition.blankLineBeforeEnd ? "\n\n" : "\n";
  if (definition.commentStyle === "hash") {
    return `# VCM:BEGIN version=${VCM_HARNESS_VERSION}\n${rules.trimEnd()}${endSpacing}# VCM:END`;
  }

  return `<!-- VCM:BEGIN version=${VCM_HARNESS_VERSION} -->\n${rules.trimEnd()}${endSpacing}<!-- VCM:END -->`;
}

function getManagedBlockPattern(definition: HarnessFileDefinition): RegExp {
  return definition.commentStyle === "hash"
    ? HASH_MANAGED_BLOCK_PATTERN
    : MANAGED_BLOCK_PATTERN;
}

function renderNewHarnessFile(definition: HarnessFileDefinition, block: string): string {
  const frontmatter = definition.frontmatter
    ? `${definition.frontmatter.trimEnd()}\n\n`
    : "";
  return `${frontmatter}# ${definition.title}\n\n${block}\n`;
}

function renderWholeHarnessFile(definition: HarnessFileDefinition): string {
  if (definition.ownership === "raw-file") {
    return ensureTrailingNewline(definition.renderRules().trimEnd());
  }
  return ensureTrailingNewline(renderNewHarnessFile(definition, definition.renderRules().trimEnd()));
}

async function analyzeClaudeSettingsFile(fs: FileSystemAdapter, repoRoot: string): Promise<HarnessFileAnalysis> {
  const definition: HarnessFileDefinition = {
    kind: "claude-settings",
    path: CLAUDE_SETTINGS_PATH,
    title: "Claude Code Settings",
    renderRules: () => ""
  };
  const absolutePath = resolveHarnessPath(repoRoot, CLAUDE_SETTINGS_PATH);
  const exists = await fs.pathExists(absolutePath);
  const current = exists
    ? parseJsonObject(await fs.readText(absolutePath))
    : {};
  const next = withVcmClaudeHooks(current);
  const currentContent = exists
    ? `${JSON.stringify(current, null, 2)}\n`
    : "";
  const nextContent = `${JSON.stringify(next, null, 2)}\n`;
  const action: HarnessFileAction = exists
    ? currentContent === nextContent ? "ok" : "update"
    : "create";

  return {
    definition,
    status: {
      kind: "claude-settings",
      path: CLAUDE_SETTINGS_PATH,
      exists,
      hasManagedBlock: false,
      action
    },
    plannedChange: action === "ok"
      ? undefined
      : {
          path: CLAUDE_SETTINGS_PATH,
          action,
          reason: exists
            ? "Claude Code hook settings do not contain the VCM hook bridge."
            : "Claude Code hook settings are missing; VCM will create them."
        },
    nextContent: action === "ok" ? undefined : nextContent
  };
}

function parseJsonObject(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function withVcmClaudeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = isPlainObject(settings.hooks)
    ? { ...settings.hooks }
    : {};

  for (const [eventName, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const cleaned = value.filter((entry) => !isVcmHookMatcher(entry));
    if (cleaned.length > 0) {
      hooks[eventName] = cleaned;
    } else {
      delete hooks[eventName];
    }
  }

  for (const definition of VCM_HOOK_DEFINITIONS) {
    const existingMatchers = Array.isArray(hooks[definition.eventName])
      ? hooks[definition.eventName] as unknown[]
      : [];
    hooks[definition.eventName] = [
      ...existingMatchers.filter((entry) => !isVcmHookMatcher(entry)),
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

  const env = isPlainObject(settings.env) ? { ...settings.env } : {};
  env.BASH_DEFAULT_TIMEOUT_MS = VCM_BASH_DEFAULT_TIMEOUT_MS;

  return {
    ...settings,
    hooks,
    env
  };
}

function isVcmHookMatcher(value: unknown): boolean {
  if (!isPlainObject(value) || !Array.isArray(value.hooks)) {
    return false;
  }
  return value.hooks.some((hook) => {
    if (!isPlainObject(hook)) {
      return false;
    }
    if (typeof hook.command !== "string") {
      return false;
    }
    return hook.command.includes("VCM") ||
      hook.command.includes("/api/hooks/claude-code") ||
      hook.command.includes("hook-event");
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderAgentFrontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ntools: Read, Grep, Glob, Bash, Edit, Write\n---`;
}

function renderSkillFrontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---`;
}

function resolveHarnessPath(repoRoot: string, relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function getHarnessBootstrapStatus(
  deps: HarnessServiceDeps,
  repoRoot: string,
  now: () => string
): Promise<HarnessBootstrapStatusReport> {
  const moduleIndex = await readOptionalJsonObject(deps.fs, repoRoot, ".ai/generated/module-index.json");
  const checks: HarnessBootstrapCheck[] = [
    await checkFixedHarness(deps.fs, repoRoot),
    await checkProjectContext(deps.fs, repoRoot),
    checkGeneratedJson(moduleIndex, ".ai/generated/module-index.json", "module-index", "Module index"),
    checkGeneratedJson(
      await readOptionalJsonObject(deps.fs, repoRoot, ".ai/generated/public-surface.json"),
      ".ai/generated/public-surface.json",
      "public-surface",
      "Public surface"
    ),
    await checkFilledMarkdown(deps.fs, repoRoot, "docs/ARCHITECTURE.md", "Project architecture", "project-architecture"),
    await checkModuleArchitectureDocs(deps.fs, repoRoot, moduleIndex),
    await checkFilledMarkdown(deps.fs, repoRoot, "docs/TESTING.md", "Testing doc", "testing-doc")
  ];
  const session = await getCurrentHarnessBootstrapSession(deps, repoRoot, now);
  const fixedHarnessReady = checks[0]?.status === "ok";
  const projectChecks = checks.slice(1);
  const projectComplete = projectChecks.every((check) => check.status === "ok");
  const projectStarted = projectChecks.some((check) => check.status === "ok" || check.status === "incomplete");
  const status = !fixedHarnessReady
    ? "not_ready"
    : session?.status === "running"
      ? "running"
      : projectComplete
        ? "complete"
        : projectStarted
          ? "incomplete"
          : "not_started";

  return {
    status,
    canStart: fixedHarnessReady && session?.status !== "running",
    checks,
    session,
    warnings: bootstrapWarnings(status, checks, session)
  };
}

async function checkFixedHarness(fs: FileSystemAdapter, repoRoot: string): Promise<HarnessBootstrapCheck> {
  const requiredPaths = [
    "CLAUDE.md",
    ".ai/vcm-harness-manifest.json",
    ".claude/skills/vcm-harness-bootstrap/SKILL.md",
    ".ai/tools/generate-module-index",
    ".ai/tools/generate-public-surface"
  ];
  const missing: string[] = [];

  for (const relativePath of requiredPaths) {
    if (!await fs.pathExists(resolveHarnessPath(repoRoot, relativePath))) {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    return {
      key: "fixed-harness",
      label: "Fixed harness",
      status: "missing",
      detail: `Missing ${missing.length}: ${missing.join(", ")}`
    };
  }

  const rootClaude = await readOptionalText(fs, repoRoot, "CLAUDE.md");
  if (!rootClaude?.includes("<!-- VCM:BEGIN")) {
    return {
      key: "fixed-harness",
      label: "Fixed harness",
      status: "incomplete",
      path: "CLAUDE.md",
      detail: "CLAUDE.md is missing the VCM managed block."
    };
  }

  return {
    key: "fixed-harness",
    label: "Fixed harness",
    status: "ok",
    detail: "Fixed VCM files are installed."
  };
}

async function checkProjectContext(fs: FileSystemAdapter, repoRoot: string): Promise<HarnessBootstrapCheck> {
  const content = await readOptionalText(fs, repoRoot, "CLAUDE.md");
  if (!content) {
    return {
      key: "project-context",
      label: "Project context",
      status: "missing",
      path: "CLAUDE.md"
    };
  }

  const projectOwnedContent = content.split("<!-- VCM:BEGIN")[0]?.trim() ?? "";
  if (!projectOwnedContent) {
    return {
      key: "project-context",
      label: "Project context",
      status: "missing",
      path: "CLAUDE.md",
      detail: "No project-specific content above the VCM managed block."
    };
  }
  if (!/^## Project Context\b/m.test(projectOwnedContent)) {
    return {
      key: "project-context",
      label: "Project context",
      status: "incomplete",
      path: "CLAUDE.md",
      detail: "Add a Project Context section above the VCM managed block."
    };
  }

  return {
    key: "project-context",
    label: "Project context",
    status: isFilledMarkdown(projectOwnedContent) ? "ok" : "incomplete",
    path: "CLAUDE.md"
  };
}

function checkGeneratedJson(
  payload: Record<string, unknown> | undefined,
  relativePath: string,
  kind: "module-index" | "public-surface",
  label: string
): HarnessBootstrapCheck {
  const key = kind === "module-index" ? "module-index" : "public-surface";
  if (!payload) {
    return {
      key,
      label,
      status: "missing",
      path: relativePath
    };
  }
  if (payload.kind !== kind) {
    return {
      key,
      label,
      status: "incomplete",
      path: relativePath,
      detail: `Expected kind "${kind}".`
    };
  }
  if (typeof payload.generatedBy !== "string" || !payload.generatedBy) {
    return {
      key,
      label,
      status: "incomplete",
      path: relativePath,
      detail: "Missing generatedBy."
    };
  }
  return {
    key,
    label,
    status: "ok",
    path: relativePath
  };
}

async function checkFilledMarkdown(
  fs: FileSystemAdapter,
  repoRoot: string,
  relativePath: string,
  label: string,
  key: HarnessBootstrapCheck["key"]
): Promise<HarnessBootstrapCheck> {
  const content = await readOptionalText(fs, repoRoot, relativePath);
  if (!content) {
    return {
      key,
      label,
      status: "missing",
      path: relativePath
    };
  }

  return {
    key,
    label,
    status: isFilledMarkdown(content) ? "ok" : "incomplete",
    path: relativePath,
    detail: isFilledMarkdown(content) ? undefined : "Only a blank or very short template was found."
  };
}

async function checkModuleArchitectureDocs(
  fs: FileSystemAdapter,
  repoRoot: string,
  moduleIndex: Record<string, unknown> | undefined
): Promise<HarnessBootstrapCheck> {
  if (!moduleIndex) {
    return {
      key: "module-architecture",
      label: "Module architecture docs",
      status: "unknown",
      detail: "Run module-index generation first."
    };
  }

  const moduleDocs = getModuleArchitectureDocPaths(moduleIndex);
  if (moduleDocs.length === 0) {
    return {
      key: "module-architecture",
      label: "Module architecture docs",
      status: "unknown",
      detail: "module-index.json does not list module architecture docs."
    };
  }

  let missing = 0;
  let incomplete = 0;
  for (const relativePath of moduleDocs) {
    const content = await readOptionalText(fs, repoRoot, relativePath);
    if (!content) {
      missing += 1;
    } else if (!isFilledMarkdown(content)) {
      incomplete += 1;
    }
  }

  if (missing === 0 && incomplete === 0) {
    return {
      key: "module-architecture",
      label: "Module architecture docs",
      status: "ok",
      detail: `${moduleDocs.length} module docs found.`
    };
  }

  return {
    key: "module-architecture",
    label: "Module architecture docs",
    status: "incomplete",
    detail: `${missing} missing, ${incomplete} incomplete, ${moduleDocs.length} expected.`
  };
}

function getModuleArchitectureDocPaths(moduleIndex: Record<string, unknown>): string[] {
  const layers = Array.isArray(moduleIndex.layers) ? moduleIndex.layers : [];
  const paths = new Set<string>();
  for (const layer of layers) {
    if (!isPlainObject(layer) || !Array.isArray(layer.modules)) {
      continue;
    }
    for (const moduleEntry of layer.modules) {
      if (!isPlainObject(moduleEntry)) {
        continue;
      }
      const architectureDoc = moduleEntry.architectureDoc;
      if (typeof architectureDoc === "string" && architectureDoc.trim()) {
        paths.add(architectureDoc);
      }
    }
  }
  return [...paths].sort();
}

function isFilledMarkdown(content: string): boolean {
  const meaningfulLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return meaningfulLines.join("\n").length >= 120;
}

async function getCurrentHarnessBootstrapSession(
  deps: HarnessServiceDeps,
  repoRoot: string,
  now: () => string
): Promise<HarnessBootstrapSession | undefined> {
  const persisted = await loadPersistedHarnessBootstrapSession(deps.fs, repoRoot);
  const runtimeSession = deps.runtime
    ?.listSessions(BOOTSTRAP_TASK_SLUG)
    .find((session) => session.id === persisted?.id || session.status === "running");

  if (runtimeSession) {
    const session: HarnessBootstrapSession = {
      id: runtimeSession.id,
      claudeSessionId: persisted?.claudeSessionId ?? runtimeSession.id,
      status: runtimeSession.status === "crashed" ? "crashed" : runtimeSession.status === "exited" ? "exited" : "running",
      command: persisted?.command ?? "claude",
      cwd: persisted?.cwd ?? repoRoot,
      logPath: persisted?.logPath ?? BOOTSTRAP_LOG_PATH,
      startedAt: runtimeSession.startedAt,
      updatedAt: now(),
      lastOutputAt: runtimeSession.lastOutputAt,
      exitCode: runtimeSession.exitCode
    };
    await persistHarnessBootstrapSession(deps.fs, repoRoot, session);
    return session;
  }

  if (persisted?.status === "running") {
    return {
      ...persisted,
      status: "resumable",
      updatedAt: now()
    };
  }
  return undefined;
}

async function loadPersistedHarnessBootstrapSession(
  fs: FileSystemAdapter,
  repoRoot: string
): Promise<HarnessBootstrapSession | undefined> {
  const payload = await readOptionalJsonObject(fs, repoRoot, BOOTSTRAP_SESSION_PATH);
  if (!payload) {
    return undefined;
  }
  if (
    typeof payload.id !== "string" ||
    typeof payload.claudeSessionId !== "string" ||
    typeof payload.command !== "string" ||
    typeof payload.cwd !== "string" ||
    typeof payload.logPath !== "string" ||
    typeof payload.updatedAt !== "string"
  ) {
    return undefined;
  }
  const status = payload.status;
  if (status !== "running" && status !== "exited" && status !== "crashed" && status !== "resumable") {
    return undefined;
  }

  return {
    id: payload.id,
    claudeSessionId: payload.claudeSessionId,
    status,
    command: payload.command,
    cwd: payload.cwd,
    logPath: payload.logPath,
    startedAt: typeof payload.startedAt === "string" ? payload.startedAt : undefined,
    updatedAt: payload.updatedAt,
    lastOutputAt: typeof payload.lastOutputAt === "string" ? payload.lastOutputAt : undefined,
    exitCode: typeof payload.exitCode === "number" || payload.exitCode === null ? payload.exitCode : undefined
  };
}

async function persistHarnessBootstrapSession(
  fs: FileSystemAdapter,
  repoRoot: string,
  session: HarnessBootstrapSession
): Promise<void> {
  await fs.writeJsonAtomic(resolveHarnessPath(repoRoot, BOOTSTRAP_SESSION_PATH), session);
}

async function readOptionalText(
  fs: FileSystemAdapter,
  repoRoot: string,
  relativePath: string
): Promise<string | undefined> {
  const absolutePath = resolveHarnessPath(repoRoot, relativePath);
  try {
    return await fs.readText(absolutePath);
  } catch {
    return undefined;
  }
}

async function readOptionalJsonObject(
  fs: FileSystemAdapter,
  repoRoot: string,
  relativePath: string
): Promise<Record<string, unknown> | undefined> {
  const content = await readOptionalText(fs, repoRoot, relativePath);
  if (!content?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function bootstrapWarnings(
  status: HarnessBootstrapStatusReport["status"],
  checks: HarnessBootstrapCheck[],
  session: HarnessBootstrapSession | undefined
): string[] {
  const warnings: string[] = [];
  if (status === "not_ready") {
    warnings.push("Install or update the fixed VCM harness before running harness bootstrap.");
  }
  if (session?.status === "resumable") {
    warnings.push("The previous bootstrap terminal is no longer active; start bootstrap again or finish the remaining files manually.");
  }
  const unknownChecks = checks.filter((check) => check.status === "unknown");
  if (unknownChecks.length > 0) {
    warnings.push(`Some bootstrap checks are waiting on generated context: ${unknownChecks.map((check) => check.label).join(", ")}.`);
  }
  return warnings;
}

function buildClaudeStartCommand(
  command = "claude",
  permissionMode: ClaudePermissionMode = "default",
  claudeSessionId: string
): { command: string; args: string[]; display: string } {
  const args = ["--session-id", claudeSessionId];
  if (permissionMode === "bypassPermissions") {
    args.push("--permission-mode", "bypassPermissions");
  }
  return {
    command,
    args,
    display: `${command} ${args.join(" ")}`
  };
}

function buildHarnessBootstrapPrompt(repoRoot: string): string {
  return `Use the vcm-harness-bootstrap skill to finish the VCM harness bootstrap for this repository.

Repository root:
${repoRoot}

Required work:
- Run .ai/tools/generate-module-index when available.
- Run .ai/tools/generate-public-surface after module-index.json exists.
- Add or update project-specific Project Context and Project Constraints in CLAUDE.md above the VCM managed block.
- Fill docs/ARCHITECTURE.md with project-level module overview, responsibilities, relationships, dependency direction, project-wide constraints, and links to module-level architecture docs.
- Create or update module-level ARCHITECTURE.md files for clear module boundaries listed by module-index.json.
- Fill docs/TESTING.md with project-native validation levels, commands, validation selection rules, final-validation cleanup, test layout, integration/E2E case lists, generated-context freshness checks, and known testing gaps.

Boundaries:
- Do not edit product source, product tests, package manifests, lockfiles, deployment config, secrets, or VCM managed blocks.
- Preserve user-authored content.
- Do not create new validation wrapper tools.

Final response:
Summarize files reviewed, files updated, generated artifacts, verified claims, inferred claims, unknowns, confirmation-needed items, and suggested validation commands.`;
}

export function createScriptFixedHarnessInstaller(
  scriptPath = path.resolve(process.cwd(), "scripts/install-vcm-harness.mjs")
): (repoRoot: string) => Promise<HarnessApplyResult> {
  return async (repoRoot) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, repoRoot], {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024
      });
      const output = `${String(stdout).trim()}${String(stderr).trim() ? `\n${String(stderr).trim()}` : ""}`.trim();
      return {
        version: VCM_HARNESS_VERSION,
        changedFiles: parseFixedInstallerChanges(String(stdout)),
        message: output || "VCM fixed harness install completed."
      };
    } catch (caught) {
      const error = caught as { message?: string; stdout?: string | Buffer; stderr?: string | Buffer };
      const details = [error.message, String(error.stdout ?? "").trim(), String(error.stderr ?? "").trim()]
        .filter(Boolean)
        .join("\n");
      throw new VcmError({
        code: "HARNESS_INSTALL_FAILED",
        message: "VCM fixed harness install failed.",
        statusCode: 500,
        hint: details || undefined
      });
    }
  };
}

function parseFixedInstallerChanges(output: string): HarnessPlannedChange[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^DONE\s+(.+?)\s+-\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      path: match[1],
      action: match[2].includes("create") || match[2].includes("created") ? "create" : "update",
      reason: match[2]
    }));
}
