import path from "node:path";
import type {
  HarnessApplyResult,
  HarnessFileAction,
  HarnessFileKind,
  HarnessFileStatus,
  HarnessPlannedChange,
  HarnessStatusReport
} from "../../shared/types/harness.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { renderArchitectHarnessRules } from "../templates/harness/architect-agent.js";
import { renderCoderHarnessRules } from "../templates/harness/coder-agent.js";
import { renderRootClaudeHarnessRules } from "../templates/harness/claude-root.js";
import { renderGitignoreHarnessRules } from "../templates/harness/gitignore.js";
import { renderKnownIssuesDocHarnessRules } from "../templates/harness/known-issues-doc.js";
import { renderProjectManagerHarnessRules } from "../templates/harness/project-manager-agent.js";
import { renderPullRequestTemplateHarnessRules } from "../templates/harness/pull-request-template.js";
import { renderReviewerHarnessRules } from "../templates/harness/reviewer-agent.js";
import { renderVcmFinalAcceptanceSkillRules } from "../templates/harness/vcm-final-acceptance-skill.js";
import { renderVcmHarnessBootstrapSkillRules } from "../templates/harness/vcm-harness-bootstrap-skill.js";
import { renderVcmHarnessMaintenanceSkillRules } from "../templates/harness/vcm-harness-maintenance-skill.js";
import { renderVcmLongRunningValidationSkillRules } from "../templates/harness/vcm-long-running-validation-skill.js";
import { renderVcmRouteMessageSkillRules } from "../templates/harness/vcm-route-message-skill.js";

export interface HarnessService {
  getHarnessStatus(repoRoot: string): Promise<HarnessStatusReport>;
  applyHarness(repoRoot: string): Promise<HarnessApplyResult>;
}

export interface HarnessServiceDeps {
  fs: FileSystemAdapter;
}

interface HarnessFileDefinition {
  kind: HarnessFileKind;
  path: string;
  title: string;
  frontmatter?: string;
  commentStyle?: "html" | "hash";
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
const VCM_HOOK_EVENTS = ["UserPromptSubmit", "Stop"] as const;

const HARNESS_FILES: HarnessFileDefinition[] = [
  {
    kind: "root-claude",
    path: "CLAUDE.md",
    title: "CLAUDE.md",
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
    kind: "docs-known-issues",
    path: "docs/known-issues.md",
    title: "Known Issues",
    renderRules: renderKnownIssuesDocHarnessRules
  },
  {
    kind: "pull-request-template",
    path: ".github/pull_request_template.md",
    title: "Pull Request Template",
    renderRules: renderPullRequestTemplateHarnessRules
  },
  {
    kind: "skill-vcm-route-message",
    path: ".claude/skills/vcm-route-message.md",
    title: "VCM Route Message Skill",
    renderRules: renderVcmRouteMessageSkillRules
  },
  {
    kind: "skill-vcm-final-acceptance",
    path: ".claude/skills/vcm-final-acceptance.md",
    title: "VCM Final Acceptance Skill",
    renderRules: renderVcmFinalAcceptanceSkillRules
  },
  {
    kind: "skill-vcm-harness-bootstrap",
    path: ".claude/skills/vcm-harness-bootstrap.md",
    title: "VCM Harness Bootstrap Skill",
    renderRules: renderVcmHarnessBootstrapSkillRules
  },
  {
    kind: "skill-vcm-harness-maintenance",
    path: ".claude/skills/vcm-harness-maintenance.md",
    title: "VCM Harness Maintenance Skill",
    renderRules: renderVcmHarnessMaintenanceSkillRules
  },
  {
    kind: "skill-vcm-long-running-validation",
    path: ".claude/skills/vcm-long-running-validation.md",
    title: "VCM Long-Running Validation Skill",
    renderRules: renderVcmLongRunningValidationSkillRules
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
      "VCM independent review role for acceptance, test adequacy, scope checks, docs gaps, and risk findings."
    ),
    renderRules: renderReviewerHarnessRules
  }
];

export function createHarnessService(deps: HarnessServiceDeps): HarnessService {
  return {
    async getHarnessStatus(repoRoot) {
      const analyses = await analyzeHarnessFiles(deps.fs, repoRoot);
      return renderHarnessStatus(analyses);
    },
    async applyHarness(repoRoot) {
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
  const expectedBlock = renderManagedBlock(definition, definition.renderRules());
  const managedBlockPattern = getManagedBlockPattern(definition);
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
      nextContent: renderNewHarnessFile(definition, expectedBlock)
    };
  }

  const currentContent = await fs.readText(absolutePath);
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
  if (definition.commentStyle === "hash") {
    return `# VCM:BEGIN version=${VCM_HARNESS_VERSION}\n${rules.trimEnd()}\n# VCM:END`;
  }

  return `<!-- VCM:BEGIN version=${VCM_HARNESS_VERSION} -->\n${rules.trimEnd()}\n<!-- VCM:END -->`;
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
            ? "Claude Code hook settings do not contain the VCM UserPromptSubmit/Stop hook bridge."
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

  for (const eventName of VCM_HOOK_EVENTS) {
    const existingMatchers = Array.isArray(hooks[eventName])
      ? hooks[eventName] as unknown[]
      : [];
    hooks[eventName] = [
      ...existingMatchers.filter((entry) => !isVcmHookMatcher(entry)),
      createVcmHookMatcher()
    ];
  }

  return {
    ...settings,
    hooks
  };
}

function createVcmHookMatcher() {
  return {
    hooks: [
      {
        type: "command",
        command: VCM_HOOK_COMMAND,
        timeout: 5
      }
    ]
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
    return typeof hook.command === "string" && hook.command.includes("hook-event");
  }) || value.hooks.some((hook) => {
    if (!isPlainObject(hook)) {
      return false;
    }
    return typeof hook.command === "string" && hook.command.includes("/api/hooks/claude-code");
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderAgentFrontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ntools: Read, Grep, Glob, Bash, Edit, Write\n---`;
}

function resolveHarnessPath(repoRoot: string, relativePath: string): string {
  return path.join(repoRoot, relativePath);
}
