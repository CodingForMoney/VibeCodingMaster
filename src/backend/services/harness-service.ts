import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  HarnessApplyResult,
  HarnessBootstrapCheck,
  HarnessBootstrapSession,
  HarnessFileContent,
  HarnessBootstrapStatusReport,
  HarnessFileAction,
  HarnessFileKind,
  HarnessFileStatus,
  HarnessPlannedChange,
  HarnessStatusReport,
  RecordHarnessBootstrapHookInput,
  RepositoryDiffFile,
  RepositoryDiffFileCategory,
  RepositoryDiffFileStatus,
  RepositoryDiffReport,
  RepositoryDiffScope,
  RestartHarnessBootstrapRequest,
  RunHarnessBootstrapResult,
  StartHarnessBootstrapRequest,
  StartHarnessBootstrapResult,
  UpdateHarnessFileContentResult
} from "../../shared/types/harness.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import type { GitAdapter } from "../adapters/git-adapter.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { renderArchitectHarnessRules } from "../templates/harness/architect-agent.js";
import { renderCoderHarnessRules } from "../templates/harness/coder-agent.js";
import {
  renderGateReviewerAgentRules,
  renderRequestGateReviewTool,
  renderTranslatorAgentRules,
  renderVcmGateReviewSkillRules
} from "../templates/harness/gate-review.js";
import { renderHarnessEngineerHarnessRules } from "../templates/harness/harness-engineer-agent.js";
import { renderRootClaudeHarnessRules } from "../templates/harness/claude-root.js";
import { renderGitignoreHarnessRules } from "../templates/harness/gitignore.js";
import { renderProjectManagerHarnessRules } from "../templates/harness/project-manager-agent.js";
import { renderPullRequestTemplateHarnessRules } from "../templates/harness/pull-request-template.js";
import { renderReviewerHarnessRules } from "../templates/harness/reviewer-agent.js";
import { renderVcmFinalAcceptanceSkillRules } from "../templates/harness/vcm-final-acceptance-skill.js";
import { renderVcmHarnessBootstrapSkillRules } from "../templates/harness/vcm-harness-bootstrap-skill.js";
import { renderVcmLongRunningValidationSkillRules } from "../templates/harness/vcm-long-running-validation-skill.js";
import { renderVcmRouteMessageSkillRules } from "../templates/harness/vcm-route-message-skill.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import { VcmError } from "../errors.js";
import { bumpHarnessRevision, readHarnessRevisionState } from "./harness-revision.js";
import type { SessionService } from "./session-service.js";

const execFileAsync = promisify(execFile);
const BOOTSTRAP_SESSION_PATH = ".ai/vcm/bootstrap/session.json";
const HARNESS_ENGINEER_SESSION_PATH = ".ai/vcm/harness-engineer/session.json";

export interface HarnessService {
  getHarnessStatus(repoRoot: string): Promise<HarnessStatusReport>;
  getHarnessFileContent(repoRoot: string, filePath: string): Promise<HarnessFileContent>;
  updateHarnessFileContent(repoRoot: string, filePath: string, content: string): Promise<UpdateHarnessFileContentResult>;
  applyHarness(repoRoot: string): Promise<HarnessApplyResult>;
  getRepositoryDiff(repoRoot: string, scope?: RepositoryDiffScope): Promise<RepositoryDiffReport>;
  getBootstrapStatus(repoRoot: string, targetRepoRoot?: string): Promise<HarnessBootstrapStatusReport>;
  startHarnessBootstrap(repoRoot: string, targetRepoRoot?: string, input?: StartHarnessBootstrapRequest): Promise<StartHarnessBootstrapResult>;
  restartHarnessBootstrap(repoRoot: string, targetRepoRoot?: string, input?: RestartHarnessBootstrapRequest): Promise<StartHarnessBootstrapResult>;
  stopHarnessBootstrap(repoRoot: string): Promise<HarnessBootstrapStatusReport>;
  runHarnessBootstrap(repoRoot: string, targetRepoRoot?: string): Promise<RunHarnessBootstrapResult>;
  recordHarnessBootstrapHook(repoRoot: string, input: RecordHarnessBootstrapHookInput): Promise<HarnessBootstrapStatusReport>;
}

export interface HarnessServiceDeps {
  fs: FileSystemAdapter;
  git?: Pick<GitAdapter, "addPaths" | "commit" | "getCommitDiff" | "getCommitInfo" | "getStatusPorcelainV1">;
  runtime?: TerminalRuntime;
  harnessEngineerSessions?: Pick<
    SessionService,
    | "ensureProjectHarnessEngineerSession"
    | "restartProjectHarnessEngineerSession"
    | "stopProjectHarnessEngineerSession"
    | "getProjectHarnessEngineerSession"
  >;
  now?: () => string;
  runFixedInstaller?: (repoRoot: string) => Promise<HarnessApplyResult>;
}

interface HarnessBootstrapRunState {
  version: 1;
  status: "running" | "complete";
  targetRepoRoot?: string;
  sessionId?: string;
  claudeSessionId?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  lastHookEvent?: RecordHarnessBootstrapHookInput["eventName"];
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
const LEGACY_CODEX_HARNESS_PATHS = [
  ".ai/codex",
  ".ai/codex-translator",
  ".claude/skills/vcm-codex-review-gate",
  ".ai/tools/request-codex-review"
] as const;
const VCM_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ] || [ -z "\${VCM_API_URL:-}" ]; then exit 0; fi; node -e '"'"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let event={};try{event=s.trim()?JSON.parse(s):{};}catch{event={raw:s};}process.stdout.write(JSON.stringify({taskSlug:process.env.VCM_TASK_SLUG,role:process.env.VCM_ROLE,event}));});'"'"' | curl -fsS --max-time 2 -X POST "\${VCM_API_URL}/api/hooks/claude-code" -H "content-type: application/json" --data-binary @- >/dev/null || true'`;
const VCM_STOP_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ] || [ -z "\${VCM_API_URL:-}" ]; then exit 0; fi; node -e '"'"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let event={};try{event=s.trim()?JSON.parse(s):{};}catch{event={raw:s};}process.stdout.write(JSON.stringify({taskSlug:process.env.VCM_TASK_SLUG,role:process.env.VCM_ROLE,event}));});'"'"' | curl -fsS --max-time 5 -X POST "\${VCM_API_URL}/api/hooks/claude-code/stop" -H "content-type: application/json" --data-binary @- || true'`;
const VCM_PERMISSION_REQUEST_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ] || [ -z "\${VCM_API_URL:-}" ]; then exit 0; fi; node -e '"'"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let event={};try{event=s.trim()?JSON.parse(s):{};}catch{event={raw:s};}process.stdout.write(JSON.stringify({taskSlug:process.env.VCM_TASK_SLUG,role:process.env.VCM_ROLE,event}));});'"'"' | curl -fsS --max-time 5 -X POST "\${VCM_API_URL}/api/hooks/claude-code/permission-request" -H "content-type: application/json" --data-binary @- || true'`;
const VCM_BASH_GUARD_HOOK_COMMAND = `sh -c 'if [ -z "\${VCM_TASK_SLUG:-}" ] || [ -z "\${VCM_ROLE:-}" ]; then exit 0; fi; exec python3 "\${CLAUDE_PROJECT_DIR:-.}/.ai/tools/vcm-bash-guard"'`;
const VCM_BASH_DEFAULT_TIMEOUT_MS = "600000";
const VCM_HOOK_DEFINITIONS: ReadonlyArray<{ eventName: string; matcher?: string; command: string; timeout: number }> = [
  { eventName: "PreToolUse", matcher: "Bash", command: VCM_BASH_GUARD_HOOK_COMMAND, timeout: 10 },
  { eventName: "UserPromptSubmit", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "Stop", command: VCM_STOP_HOOK_COMMAND, timeout: 10 },
  { eventName: "StopFailure", command: VCM_HOOK_COMMAND, timeout: 5 },
  { eventName: "PostCompact", command: VCM_HOOK_COMMAND, timeout: 5 },
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
    kind: "skill-vcm-gate-review",
    path: ".claude/skills/vcm-gate-review/SKILL.md",
    title: "VCM Gate Review Skill",
    frontmatter: renderSkillFrontmatter(
      "vcm-gate-review",
      "Use when project-manager reaches a Gate Review trigger or receives a VCM Gate Review callback."
    ),
    ownership: "whole-file",
    renderRules: renderVcmGateReviewSkillRules
  },
  {
    kind: "agent-gate-reviewer",
    path: ".claude/agents/gate-reviewer.md",
    title: "Gate Reviewer Agent",
    frontmatter: renderAgentFrontmatter(
      "gate-reviewer",
      "VCM independent gate review role for architecture plans, validation adequacy, and final diffs."
    ),
    renderRules: renderGateReviewerAgentRules
  },
  {
    kind: "agent-translator",
    path: ".claude/agents/translator.md",
    title: "Translator Agent",
    frontmatter: renderAgentFrontmatter(
      "translator",
      "VCM project translation tool role for conversation translation, file translation, bootstrap, and memory updates."
    ),
    renderRules: renderTranslatorAgentRules
  },
  {
    kind: "agent-harness-engineer",
    path: ".claude/agents/harness-engineer.md",
    title: "Harness Engineer Agent",
    frontmatter: renderAgentFrontmatter(
      "harness-engineer",
      "VCM project-scoped harness maintenance role for harness diagnosis, diff proposals, and VCM issue drafts."
    ),
    renderRules: renderHarnessEngineerHarnessRules
  },
  {
    kind: "tool-request-gate-review",
    path: ".ai/tools/request-gate-review",
    title: "Request Gate Review Tool",
    ownership: "raw-file",
    renderRules: renderRequestGateReviewTool
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
      const legacyChanges = await analyzeLegacyCodexHarnessPaths(deps.fs, repoRoot);
      return renderHarnessStatus(await readHarnessRevisionValue(deps.fs, repoRoot), analyses, legacyChanges);
    },
    async getHarnessFileContent(repoRoot, filePath) {
      return readHarnessFileContent(deps.fs, repoRoot, filePath);
    },
    async updateHarnessFileContent(repoRoot, filePath, content) {
      await assertHarnessWorktreeClean(deps.git, repoRoot);
      const definition = getHarnessFileDefinition(filePath);
      if (!isProjectEditableHarnessFile(definition)) {
        throw new VcmError({
          code: "HARNESS_FILE_READONLY",
          message: "This harness file is managed by VCM and cannot be edited directly.",
          statusCode: 409,
          hint: getReadonlyHarnessReason(definition)
        });
      }

      const absolutePath = resolveHarnessPath(repoRoot, definition.path);
      const currentContent = await deps.fs.pathExists(absolutePath)
        ? await deps.fs.readText(absolutePath)
        : "";
      assertManagedBlockUnchanged(definition, currentContent, content);
      const nextContent = ensureTrailingNewline(content);
      await deps.fs.writeText(absolutePath, nextContent);
      let harnessCommit: string | undefined;
      if (nextContent !== currentContent) {
        await bumpHarnessRevision(deps.fs, repoRoot, now());
        harnessCommit = (await commitHarnessVisibleChanges(
          deps.git,
          repoRoot,
          "chore(vcm-harness): update harness file"
        )).harnessCommit;
      }

      const file = await readHarnessFileContent(deps.fs, repoRoot, definition.path);
      const analyses = await analyzeHarnessFiles(deps.fs, repoRoot);
      const legacyChanges = await analyzeLegacyCodexHarnessPaths(deps.fs, repoRoot);
      return {
        file,
        status: renderHarnessStatus(await readHarnessRevisionValue(deps.fs, repoRoot), analyses, legacyChanges),
        harnessCommit
      };
    },
    async applyHarness(repoRoot) {
      await assertHarnessWorktreeClean(deps.git, repoRoot);
      if (deps.runFixedInstaller) {
        const result = await deps.runFixedInstaller(repoRoot);
        if (result.changedFiles.length > 0) {
          await bumpHarnessRevision(deps.fs, repoRoot, now());
        }
        const committed = await commitHarnessVisibleChanges(
          deps.git,
          repoRoot,
          "chore(vcm-harness): update fixed harness"
        );
        return {
          ...result,
          changedFiles: committed.changedFiles.length > 0 ? committed.changedFiles : result.changedFiles,
          harnessCommit: committed.harnessCommit,
          message: formatHarnessApplyMessage(committed.harnessCommit, result.changedFiles.length > 0)
        };
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

      const legacyChanges = await removeLegacyCodexHarnessPaths(deps.fs, repoRoot);
      changedFiles.push(...legacyChanges);
      if (changedFiles.length > 0) {
        await bumpHarnessRevision(deps.fs, repoRoot, now());
      }
      const committed = await commitHarnessVisibleChanges(
        deps.git,
        repoRoot,
        "chore(vcm-harness): update fixed harness"
      );

      return {
        version: VCM_HARNESS_VERSION,
        changedFiles: committed.changedFiles.length > 0 ? committed.changedFiles : changedFiles,
        harnessCommit: committed.harnessCommit,
        message: changedFiles.length === 0
          ? "VCM Harness is already up to date."
          : formatHarnessApplyMessage(committed.harnessCommit, true)
      };
    },
    async getRepositoryDiff(repoRoot, scope = "harness") {
      if (!deps.git) {
        throw new VcmError({
          code: "HARNESS_GIT_UNAVAILABLE",
          message: "Git-backed repository diff is not available in this VCM runtime.",
          statusCode: 501
        });
      }
      return getRepositoryDiffReport(deps.git, repoRoot, scope, now());
    },
    async getBootstrapStatus(repoRoot, targetRepoRoot = repoRoot) {
      return getHarnessBootstrapStatus(deps, repoRoot, targetRepoRoot, now);
    },
    async startHarnessBootstrap(repoRoot, targetRepoRoot = repoRoot, input = {}) {
      const session = await ensureHarnessEngineerForBootstrap(deps, repoRoot, targetRepoRoot, now, input);
      const nextStatus = await getHarnessBootstrapStatus(deps, repoRoot, targetRepoRoot, now);

      return {
        status: {
          ...nextStatus,
          session
        },
        session,
        prompt: buildHarnessBootstrapPrompt(repoRoot, targetRepoRoot)
      };
    },
    async restartHarnessBootstrap(repoRoot, targetRepoRoot = repoRoot, input = {}) {
      const session = await restartHarnessEngineerForBootstrap(deps, repoRoot, targetRepoRoot, now, input);
      const nextStatus = await getHarnessBootstrapStatus(deps, repoRoot, targetRepoRoot, now);
      return {
        status: {
          ...nextStatus,
          session
        },
        session,
        prompt: buildHarnessBootstrapPrompt(repoRoot, targetRepoRoot)
      };
    },
    async stopHarnessBootstrap(repoRoot) {
      const existing = await getCurrentHarnessEngineerBootstrapSession(deps, repoRoot);
      if (!existing) {
        throw new VcmError({
          code: "HARNESS_BOOTSTRAP_SESSION_MISSING",
          message: "Harness Engineer session has not been started.",
          statusCode: 404
        });
      }
      await deps.harnessEngineerSessions?.stopProjectHarnessEngineerSession(repoRoot);
      await clearHarnessBootstrapRunState(deps.fs, repoRoot);
      return getHarnessBootstrapStatus(deps, repoRoot, repoRoot, now);
    },
    async runHarnessBootstrap(repoRoot, targetRepoRoot = repoRoot) {
      if (!deps.runtime || !deps.harnessEngineerSessions) {
        throw new VcmError({
          code: "HARNESS_BOOTSTRAP_UNAVAILABLE",
          message: "Harness bootstrap sessions are not available in this VCM runtime.",
          statusCode: 501
        });
      }
      await assertHarnessWorktreeClean(deps.git, targetRepoRoot);
      const status = await getHarnessBootstrapStatus(deps, repoRoot, targetRepoRoot, now);
      const session = status.session;
      if (!session || session.status !== "running" || !deps.runtime.getSession(session.id)) {
        throw new VcmError({
          code: "HARNESS_BOOTSTRAP_SESSION_NOT_RUNNING",
          message: "Start the Harness Engineer session before running bootstrap.",
          statusCode: 409
        });
      }
      const prompt = buildHarnessBootstrapPrompt(repoRoot, targetRepoRoot);
      const timestamp = now();
      await persistHarnessBootstrapRunState(deps.fs, repoRoot, {
        version: 1,
        status: "running",
        targetRepoRoot,
        sessionId: session.id,
        claudeSessionId: session.claudeSessionId,
        startedAt: timestamp,
        updatedAt: timestamp
      });
      await submitTerminalInput(deps.runtime, session.id, prompt);
      const nextStatus = await getHarnessBootstrapStatus(deps, repoRoot, targetRepoRoot, now);
      return {
        status: {
          ...nextStatus,
          session
        },
        session,
        prompt,
        targetRepoRoot
      };
    },
    async recordHarnessBootstrapHook(repoRoot, input) {
      const state = await loadPersistedHarnessBootstrapRunState(deps.fs, repoRoot);
      if (state?.status !== "running" || !matchesBootstrapRunState(state, input)) {
        return getHarnessBootstrapStatus(deps, repoRoot, state?.targetRepoRoot ?? repoRoot, now);
      }

      const timestamp = now();
      if (input.eventName === "Stop" && state.targetRepoRoot) {
        await bumpHarnessRevision(deps.fs, state.targetRepoRoot, timestamp);
      }
      await persistHarnessBootstrapRunState(deps.fs, repoRoot, {
        ...state,
        status: input.eventName === "Stop" ? "complete" : state.status,
        completedAt: input.eventName === "Stop" ? timestamp : state.completedAt,
        updatedAt: timestamp,
        lastHookEvent: input.eventName
      });
      return getHarnessBootstrapStatus(deps, repoRoot, state.targetRepoRoot ?? repoRoot, now);
    }
  };
}

async function ensureHarnessEngineerForBootstrap(
  deps: HarnessServiceDeps,
  repoRoot: string,
  targetRepoRoot: string,
  now: () => string,
  input: StartHarnessBootstrapRequest
): Promise<HarnessBootstrapSession> {
  if (!deps.harnessEngineerSessions) {
    throw new VcmError({
      code: "HARNESS_BOOTSTRAP_UNAVAILABLE",
      message: "Harness bootstrap sessions are not available in this VCM runtime.",
      statusCode: 501
    });
  }

  const currentStatus = await getHarnessBootstrapStatus(deps, repoRoot, targetRepoRoot, now);
  if (currentStatus.session?.status === "running") {
    return currentStatus.session;
  }
  if (!currentStatus.canStart) {
    throw new VcmError({
      code: "HARNESS_BOOTSTRAP_NOT_READY",
      message: "Install the fixed VCM harness before starting harness bootstrap.",
      statusCode: 409
    });
  }

  return toHarnessBootstrapSession(await deps.harnessEngineerSessions.ensureProjectHarnessEngineerSession(repoRoot, input));
}

async function restartHarnessEngineerForBootstrap(
  deps: HarnessServiceDeps,
  repoRoot: string,
  targetRepoRoot: string,
  now: () => string,
  input: RestartHarnessBootstrapRequest
): Promise<HarnessBootstrapSession> {
  if (!deps.harnessEngineerSessions) {
    throw new VcmError({
      code: "HARNESS_BOOTSTRAP_UNAVAILABLE",
      message: "Harness bootstrap sessions are not available in this VCM runtime.",
      statusCode: 501
    });
  }

  const currentStatus = await getHarnessBootstrapStatus(deps, repoRoot, targetRepoRoot, now);
  if (!currentStatus.canStart) {
    throw new VcmError({
      code: "HARNESS_BOOTSTRAP_NOT_READY",
      message: "Install the fixed VCM harness before starting harness bootstrap.",
      statusCode: 409
    });
  }

  return toHarnessBootstrapSession(await deps.harnessEngineerSessions.restartProjectHarnessEngineerSession(repoRoot, input));
}

async function getCurrentHarnessEngineerBootstrapSession(
  deps: HarnessServiceDeps,
  repoRoot: string
): Promise<HarnessBootstrapSession | undefined> {
  const session = await deps.harnessEngineerSessions?.getProjectHarnessEngineerSession(repoRoot);
  return session ? toHarnessBootstrapSession(session) : undefined;
}

function toHarnessBootstrapSession(session: RoleSessionRecord): HarnessBootstrapSession {
  return {
    id: session.id,
    claudeSessionId: session.claudeSessionId,
    status: toBootstrapSessionStatus(session.status),
    command: session.command,
    permissionMode: session.permissionMode,
    model: session.model,
    effort: session.effort,
    cwd: session.cwd,
    logPath: HARNESS_ENGINEER_SESSION_PATH,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    lastOutputAt: session.lastOutputAt,
    exitCode: session.exitCode
  };
}

function toBootstrapSessionStatus(status: RoleSessionRecord["status"]): HarnessBootstrapSession["status"] {
  if (status === "running" || status === "crashed" || status === "exited" || status === "resumable") {
    return status;
  }
  return status === "missing" ? "resumable" : "exited";
}

function normalizeHarnessGitPath(value: string): string {
  if (!value || value.includes("\0") || path.posix.isAbsolute(value)) {
    throw new VcmError({
      code: "HARNESS_CHANGED_PATH_INVALID",
      message: "Harness changed file path is invalid.",
      statusCode: 400,
      hint: value
    });
  }

  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (normalized === "." || normalized.startsWith("../")) {
    throw new VcmError({
      code: "HARNESS_CHANGED_PATH_INVALID",
      message: "Harness changed file path must stay inside the repository.",
      statusCode: 400,
      hint: value
    });
  }
  return normalized;
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

type RepositoryDiffGit = NonNullable<HarnessServiceDeps["git"]>;

interface ParsedGitStatusEntry {
  path: string;
  oldPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
}

const REPOSITORY_DIFF_MAX_FILES = 250;
const REPOSITORY_DIFF_MAX_DIFF_CHARS = 180_000;

async function getRepositoryDiffReport(
  git: RepositoryDiffGit,
  repoRoot: string,
  scope: RepositoryDiffScope,
  generatedAt: string
): Promise<RepositoryDiffReport> {
  const commitInfo = await git.getCommitInfo(repoRoot, "HEAD");
  const rawDiff = await git.getCommitDiff(repoRoot, "HEAD");
  const allFiles = parseCommitDiffFiles(rawDiff)
    .filter((file) => scope === "all" || file.category !== "product_code");
  const warnings: string[] = [];
  const files = allFiles.slice(0, REPOSITORY_DIFF_MAX_FILES);
  if (allFiles.length > files.length) {
    warnings.push(`Diff file list is truncated to ${REPOSITORY_DIFF_MAX_FILES} files.`);
  }

  const productCodeCount = files.filter((file) => file.category === "product_code").length;
  if (productCodeCount > 0) {
    warnings.push(`${productCodeCount} product code file(s) are present in this commit. Verify they are expected before approving harness work.`);
  }

  return {
    version: 1,
    repoRoot,
    scope,
    generatedAt,
    commit: {
      sha: commitInfo.sha,
      shortSha: commitInfo.sha.slice(0, 12),
      subject: commitInfo.subject,
      committedAt: commitInfo.committedAt
    },
    summary: {
      totalFiles: files.length,
      committedFiles: files.length,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      harnessFiles: files.filter((file) => file.category !== "product_code").length,
      productCodeFiles: productCodeCount,
      truncatedFiles: files.filter((file) => file.truncated).length,
      binaryFiles: files.filter((file) => file.binary).length
    },
    files,
    warnings
  };
}

function parseCommitDiffFiles(rawDiff: string): RepositoryDiffFile[] {
  const chunks = rawDiff.split(/(?=^diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  return chunks.map(parseCommitDiffFile);
}

function parseCommitDiffFile(chunk: string): RepositoryDiffFile {
  const firstLine = chunk.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/^diff --git a\/(.+) b\/(.+)$/);
  const oldPath = normalizeHarnessGitPath(match?.[1] ?? "unknown");
  const nextPath = normalizeHarnessGitPath(match?.[2] ?? oldPath);
  const status = getCommitDiffFileStatus(chunk);
  const pathForCategory = status === "deleted" ? oldPath : nextPath;
  const category = classifyRepositoryDiffPath(pathForCategory);
  const truncatedDiff = truncateRepositoryDiff(chunk);
  const lineStats = countDiffLines(truncatedDiff.diff);

  return {
    path: pathForCategory,
    oldPath: oldPath === pathForCategory ? undefined : oldPath,
    status,
    stage: "committed",
    category,
    diff: truncatedDiff.diff,
    binary: /Binary files .* differ|GIT binary patch/.test(chunk),
    truncated: truncatedDiff.truncated,
    additions: lineStats.additions,
    deletions: lineStats.deletions
  };
}

function getCommitDiffFileStatus(diffChunk: string): RepositoryDiffFileStatus {
  if (/^new file mode /m.test(diffChunk)) {
    return "added";
  }
  if (/^deleted file mode /m.test(diffChunk)) {
    return "deleted";
  }
  if (/^similarity index /m.test(diffChunk) && /^rename from /m.test(diffChunk) && /^rename to /m.test(diffChunk)) {
    return "renamed";
  }
  if (/^copy from /m.test(diffChunk) && /^copy to /m.test(diffChunk)) {
    return "copied";
  }
  return "modified";
}

export function parseGitStatusPorcelainV1(rawStatus: string): ParsedGitStatusEntry[] {
  const records = rawStatus.split("\0").filter(Boolean);
  const entries: ParsedGitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) {
      continue;
    }
    const indexStatus = record[0] ?? " ";
    const workingTreeStatus = record[1] ?? " ";
    const filePath = normalizeHarnessGitPath(record.slice(3));
    let oldPath: string | undefined;
    if (indexStatus === "R" || indexStatus === "C") {
      const oldPathRecord = records[index + 1];
      if (oldPathRecord) {
        oldPath = normalizeHarnessGitPath(oldPathRecord);
        index += 1;
      }
    }
    entries.push({
      path: filePath,
      oldPath,
      indexStatus,
      workingTreeStatus
    });
  }
  return entries;
}

export function classifyRepositoryDiffPath(repoRelativePath: string): RepositoryDiffFileCategory {
  const filePath = normalizeHarnessGitPath(repoRelativePath);
  if (
    filePath === "CLAUDE.md" ||
    filePath === ".gitignore" ||
    filePath === ".ai/vcm-harness-manifest.json" ||
    filePath === ".github/pull_request_template.md" ||
    filePath === ".claude/settings.json" ||
    filePath === ".claude/settings.local.json" ||
    filePath.startsWith(".claude/agents/") ||
    filePath.startsWith(".claude/skills/")
  ) {
    return "fixed_harness";
  }
  if (filePath.startsWith(".ai/tools/") || filePath.startsWith(".github/workflows/")) {
    return "tools_hooks";
  }
  if (filePath.startsWith(".ai/generated/")) {
    return "generated_context";
  }
  if (
    filePath.startsWith("docs/") ||
    filePath === "ARCHITECTURE.md" ||
    filePath.endsWith("/ARCHITECTURE.md") ||
    filePath === "TESTING.md" ||
    filePath.endsWith("/TESTING.md")
  ) {
    return "project_docs";
  }
  return "product_code";
}

function truncateRepositoryDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= REPOSITORY_DIFF_MAX_DIFF_CHARS) {
    return { diff, truncated: false };
  }
  return {
    diff: `${diff.slice(0, REPOSITORY_DIFF_MAX_DIFF_CHARS)}\n# ... diff truncated ...\n`,
    truncated: true
  };
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

async function assertHarnessWorktreeClean(git: RepositoryDiffGit | undefined, repoRoot: string): Promise<void> {
  if (!git) {
    return;
  }
  const entries = await getVisibleGitStatusEntries(git, repoRoot);
  if (entries.length === 0) {
    return;
  }
  throw new VcmError({
    code: "HARNESS_WORKTREE_DIRTY",
    message: "The active task worktree has uncommitted Git-visible changes.",
    statusCode: 409,
    hint: `Commit or revert these files before running a harness operation: ${entries.map((entry) => entry.path).slice(0, 12).join(", ")}`
  });
}

async function commitHarnessVisibleChanges(
  git: RepositoryDiffGit | undefined,
  repoRoot: string,
  message: string
): Promise<{ harnessCommit?: string; changedFiles: HarnessPlannedChange[] }> {
  if (!git) {
    return { changedFiles: [] };
  }
  const entries = await getVisibleGitStatusEntries(git, repoRoot);
  if (entries.length === 0) {
    return { changedFiles: [] };
  }

  const unexpected = entries.filter((entry) => classifyRepositoryDiffPath(entry.path) === "product_code");
  if (unexpected.length > 0) {
    throw new VcmError({
      code: "HARNESS_UNEXPECTED_PRODUCT_CHANGES",
      message: "Harness operation produced product-code changes.",
      statusCode: 409,
      hint: `Review, revert, or move these changes before continuing: ${unexpected.map((entry) => entry.path).slice(0, 12).join(", ")}`
    });
  }

  const changedFiles = entries.map(statusEntryToHarnessChange);
  const stagePaths = uniqueStrings(entries.flatMap((entry) => [entry.path, entry.oldPath].filter((value): value is string => Boolean(value))));
  await git.addPaths(repoRoot, stagePaths);
  const harnessCommit = await git.commit(repoRoot, message);
  return { harnessCommit, changedFiles };
}

async function getVisibleGitStatusEntries(git: RepositoryDiffGit, repoRoot: string): Promise<ParsedGitStatusEntry[]> {
  const rawStatus = await git.getStatusPorcelainV1(repoRoot);
  return parseGitStatusPorcelainV1(rawStatus).filter((entry) => !isVcmRuntimePath(entry.path));
}

function isVcmRuntimePath(repoRelativePath: string): boolean {
  const filePath = normalizeHarnessGitPath(repoRelativePath);
  return filePath.startsWith(".ai/vcm/") ||
    filePath.startsWith(".claude/worktrees/") ||
    filePath.startsWith(".ai/tools/__pycache__/") ||
    filePath.endsWith("/__pycache__");
}

function statusEntryToHarnessChange(entry: ParsedGitStatusEntry): HarnessPlannedChange {
  return {
    path: entry.path,
    action: statusEntryToHarnessAction(entry),
    reason: "Committed by VCM harness operation."
  };
}

function statusEntryToHarnessAction(entry: ParsedGitStatusEntry): HarnessFileAction {
  if (entry.indexStatus === "?" || entry.indexStatus === "A" || entry.workingTreeStatus === "A") {
    return "create";
  }
  if (entry.indexStatus === "D" || entry.workingTreeStatus === "D") {
    return "delete";
  }
  return "update";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function formatHarnessApplyMessage(harnessCommit: string | undefined, changed: boolean): string {
  if (!changed) {
    return "VCM Harness is already up to date.";
  }
  return harnessCommit
    ? `VCM Harness updated and committed as ${shortCommit(harnessCommit)}. Review the commit diff before approving.`
    : "VCM Harness updated. Review the latest harness commit before approving.";
}

async function readHarnessFileContent(
  fs: FileSystemAdapter,
  repoRoot: string,
  filePath: string
): Promise<HarnessFileContent> {
  const definition = getHarnessFileDefinition(filePath);
  const absolutePath = resolveHarnessPath(repoRoot, definition.path);
  const exists = await fs.pathExists(absolutePath);
  const content = exists ? await fs.readText(absolutePath) : "";
  const editable = isProjectEditableHarnessFile(definition);
  return {
    path: definition.path,
    kind: definition.kind,
    title: definition.title,
    content,
    editable,
    readonlyReason: editable ? undefined : getReadonlyHarnessReason(definition)
  };
}

function getHarnessFileDefinition(filePath: string): HarnessFileDefinition {
  const normalizedPath = normalizeHarnessFilePath(filePath);
  const definition = HARNESS_FILES.find((file) => file.path === normalizedPath) ?? getSpecialHarnessFileDefinition(normalizedPath);
  if (!definition) {
    throw new VcmError({
      code: "HARNESS_FILE_UNKNOWN",
      message: "This path is not a known VCM harness file.",
      statusCode: 404,
      hint: normalizedPath
    });
  }
  return definition;
}

function getSpecialHarnessFileDefinition(filePath: string): HarnessFileDefinition | undefined {
  if (filePath !== CLAUDE_SETTINGS_PATH) {
    return undefined;
  }
  return {
    kind: "claude-settings",
    path: CLAUDE_SETTINGS_PATH,
    title: "Claude Code Settings",
    ownership: "raw-file",
    renderRules: () => ""
  };
}

function normalizeHarnessFilePath(filePath: string): string {
  if (!filePath || filePath.includes("\0") || path.posix.isAbsolute(filePath)) {
    throw new VcmError({
      code: "HARNESS_FILE_PATH_INVALID",
      message: "Harness file path is invalid.",
      statusCode: 400,
      hint: filePath
    });
  }

  const normalized = path.posix.normalize(filePath).replace(/^\.\//, "");
  if (normalized === "." || normalized.startsWith("../")) {
    throw new VcmError({
      code: "HARNESS_FILE_PATH_INVALID",
      message: "Harness file path must stay inside the repository.",
      statusCode: 400,
      hint: filePath
    });
  }
  return normalized;
}

function isProjectEditableHarnessFile(definition: HarnessFileDefinition): boolean {
  return definition.ownership !== "whole-file" && definition.ownership !== "raw-file";
}

function getReadonlyHarnessReason(definition: HarnessFileDefinition): string {
  if (definition.path === CLAUDE_SETTINGS_PATH) {
    return "Claude Code hooks are generated by VCM fixed harness install.";
  }
  if (definition.ownership === "whole-file" || definition.ownership === "raw-file") {
    return "This file is VCM-owned whole-file template content. Use fixed harness update instead.";
  }
  return "This harness file is not editable from Harness Studio.";
}

function assertManagedBlockUnchanged(
  definition: HarnessFileDefinition,
  currentContent: string,
  nextContent: string
): void {
  const currentBlock = extractManagedBlock(definition, currentContent);
  const nextBlock = extractManagedBlock(definition, nextContent);
  if (currentBlock && nextBlock !== currentBlock) {
    throw new VcmError({
      code: "HARNESS_MANAGED_BLOCK_PROTECTED",
      message: "VCM fixed managed blocks cannot be edited from Harness Studio.",
      statusCode: 409,
      hint: "Edit project-specific content outside the VCM:BEGIN / VCM:END block, or use fixed harness update."
    });
  }
  if (!currentBlock && nextBlock) {
    throw new VcmError({
      code: "HARNESS_MANAGED_BLOCK_PROTECTED",
      message: "VCM fixed managed blocks must be installed by VCM.",
      statusCode: 409,
      hint: "Use fixed harness update instead of adding a VCM managed block manually."
    });
  }
}

function extractManagedBlock(definition: HarnessFileDefinition, content: string): string | undefined {
  if (definition.ownership === "whole-file" || definition.ownership === "raw-file") {
    return undefined;
  }
  return content.match(getManagedBlockPattern(definition))?.[0];
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

async function analyzeLegacyCodexHarnessPaths(fs: FileSystemAdapter, repoRoot: string): Promise<HarnessPlannedChange[]> {
  const changes: HarnessPlannedChange[] = [];
  for (const relativePath of LEGACY_CODEX_HARNESS_PATHS) {
    if (!await fs.pathExists(resolveHarnessPath(repoRoot, relativePath))) {
      continue;
    }
    changes.push({
      path: relativePath,
      action: "delete",
      reason: "Legacy Codex harness path is obsolete; VCM now uses Claude Code Gate Reviewer and Translator roles."
    });
  }
  return changes;
}

async function removeLegacyCodexHarnessPaths(fs: FileSystemAdapter, repoRoot: string): Promise<HarnessPlannedChange[]> {
  const changes = await analyzeLegacyCodexHarnessPaths(fs, repoRoot);
  if (changes.length === 0) {
    return [];
  }
  if (!fs.removePath) {
    return [];
  }

  for (const change of changes) {
    await fs.removePath(resolveHarnessPath(repoRoot, change.path), {
      recursive: true,
      force: true
    });
  }
  return changes;
}

function renderHarnessStatus(
  harnessRevision: number,
  analyses: HarnessFileAnalysis[],
  legacyChanges: HarnessPlannedChange[] = []
): HarnessStatusReport {
  const files = analyses.map((analysis) => analysis.status);
  const plannedChanges = analyses
    .map((analysis) => analysis.plannedChange)
    .filter((change): change is HarnessPlannedChange => Boolean(change))
    .concat(legacyChanges);

  // Derive `initialized`: the VCM harness is considered installed when at least one
  // VCM-exclusive marker is present (per analysis):
  //   - status.hasManagedBlock === true (a managed block already lives in the file), OR
  //   - definition.ownership is "whole-file" | "raw-file" AND status.exists === true
  //     (a VCM-owned file lives at a VCM-exclusive path).
  // A pre-existing claude-settings (default "managed-block" ownership, no managed block)
  // or a non-VCM CLAUDE.md/.gitignore (action "insert", hasManagedBlock === false) is
  // intentionally NOT counted as initialized.
  const initialized = analyses.some(
    (analysis) =>
      analysis.status.hasManagedBlock ||
      ((analysis.definition.ownership === "whole-file" ||
        analysis.definition.ownership === "raw-file") &&
        analysis.status.exists)
  );

  return {
    version: VCM_HARNESS_VERSION,
    harnessRevision,
    initialized,
    files,
    needsApply: plannedChanges.length > 0,
    plannedChanges,
    warnings: plannedChanges.length > 0
      ? ["Review and commit VCM Harness changes before starting long-running work."]
      : []
  };
}

async function readHarnessRevisionValue(fs: FileSystemAdapter, repoRoot: string): Promise<number> {
  return (await readHarnessRevisionState(fs, repoRoot)).revision;
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
  targetRepoRoot: string,
  now: () => string
): Promise<HarnessBootstrapStatusReport> {
  const moduleIndex = await readOptionalJsonObject(deps.fs, targetRepoRoot, ".ai/generated/module-index.json");
  const checks: HarnessBootstrapCheck[] = [
    await checkFixedHarness(deps.fs, targetRepoRoot),
    await checkProjectContext(deps.fs, targetRepoRoot),
    checkGeneratedJson(moduleIndex, ".ai/generated/module-index.json", "module-index", "Module index"),
    checkGeneratedJson(
      await readOptionalJsonObject(deps.fs, targetRepoRoot, ".ai/generated/public-surface.json"),
      ".ai/generated/public-surface.json",
      "public-surface",
      "Public surface"
    ),
    await checkFilledMarkdown(deps.fs, targetRepoRoot, "docs/ARCHITECTURE.md", "Project architecture", "project-architecture"),
    await checkModuleArchitectureDocs(deps.fs, targetRepoRoot, moduleIndex),
    await checkFilledMarkdown(deps.fs, targetRepoRoot, "docs/TESTING.md", "Testing doc", "testing-doc")
  ];
  const runState = await loadPersistedHarnessBootstrapRunState(deps.fs, repoRoot);
  const session = await getCurrentHarnessEngineerBootstrapSession(deps, repoRoot);
  const fixedHarnessReady = checks[0]?.status === "ok";
  const projectChecks = checks.slice(1);
  const projectComplete = projectChecks.every((check) => check.status === "ok");
  const projectStarted = projectChecks.some((check) => check.status === "ok" || check.status === "incomplete");
  const runActive = runState?.status === "running" && session?.status === "running";
  const status = !fixedHarnessReady
    ? "not_ready"
    : runActive
      ? "running"
      : runState?.status === "complete" || projectComplete
        ? "complete"
        : projectStarted
          ? "incomplete"
          : "not_started";

  return {
    status,
    canStart: fixedHarnessReady && !runActive,
    checks,
    session,
    warnings: bootstrapWarnings(status, checks, session, runState)
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

async function loadPersistedHarnessBootstrapRunState(
  fs: FileSystemAdapter,
  repoRoot: string
): Promise<HarnessBootstrapRunState | undefined> {
  const payload = await readOptionalJsonObject(fs, repoRoot, BOOTSTRAP_SESSION_PATH);
  if (!payload) {
    return undefined;
  }
  if (
    payload.version !== 1 ||
    typeof payload.updatedAt !== "string"
  ) {
    return undefined;
  }
  const status = payload.status;
  if (status !== "running" && status !== "complete") {
    return undefined;
  }

  return {
    version: 1,
    status,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
    claudeSessionId: typeof payload.claudeSessionId === "string" ? payload.claudeSessionId : undefined,
    startedAt: typeof payload.startedAt === "string" ? payload.startedAt : undefined,
    completedAt: typeof payload.completedAt === "string" ? payload.completedAt : undefined,
    updatedAt: payload.updatedAt,
    lastHookEvent: isHarnessBootstrapHookEvent(payload.lastHookEvent) ? payload.lastHookEvent : undefined
  };
}

async function persistHarnessBootstrapRunState(
  fs: FileSystemAdapter,
  repoRoot: string,
  state: HarnessBootstrapRunState
): Promise<void> {
  await fs.writeJsonAtomic(resolveHarnessPath(repoRoot, BOOTSTRAP_SESSION_PATH), state);
}

async function clearHarnessBootstrapRunState(fs: FileSystemAdapter, repoRoot: string): Promise<void> {
  await fs.removePath?.(resolveHarnessPath(repoRoot, BOOTSTRAP_SESSION_PATH), { force: true });
}

function isHarnessBootstrapHookEvent(value: unknown): value is RecordHarnessBootstrapHookInput["eventName"] {
  return value === "Stop" || value === "StopFailure" || value === "UserPromptSubmit" || value === "PostCompact";
}

function matchesBootstrapRunState(
  state: HarnessBootstrapRunState,
  input: RecordHarnessBootstrapHookInput
): boolean {
  if (state.sessionId && input.sessionId && state.sessionId !== input.sessionId) {
    return false;
  }
  if (state.claudeSessionId && input.claudeSessionId && state.claudeSessionId !== input.claudeSessionId) {
    return false;
  }
  return true;
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
  session: HarnessBootstrapSession | undefined,
  runState: HarnessBootstrapRunState | undefined
): string[] {
  const warnings: string[] = [];
  if (status === "not_ready") {
    warnings.push("Install or update the fixed VCM harness before running harness bootstrap.");
  }
  if (session?.status === "resumable") {
    warnings.push("The Harness Engineer session is resumable; resume it before running harness bootstrap.");
  }
  if (runState?.status === "running" && session?.status !== "running") {
    warnings.push("The previous bootstrap run did not finish with an active Harness Engineer session; resume the session or run bootstrap again.");
  }
  const unknownChecks = checks.filter((check) => check.status === "unknown");
  if (unknownChecks.length > 0) {
    warnings.push(`Some bootstrap checks are waiting on generated context: ${unknownChecks.map((check) => check.label).join(", ")}.`);
  }
  return warnings;
}

function buildHarnessBootstrapPrompt(baseRepoRoot: string, targetRepoRoot: string): string {
  return `Use the vcm-harness-bootstrap skill to finish the VCM harness bootstrap for the active task worktree.

Base repository root:
${baseRepoRoot}

Target task worktree:
${targetRepoRoot}

Required work:
- Work only inside the target task worktree.
- Run .ai/tools/generate-module-index from the target task worktree when available.
- Run .ai/tools/generate-public-surface from the target task worktree after module-index.json exists.
- Add or update project-specific Project Context and Project Constraints in target CLAUDE.md above the VCM managed block.
- Fill target docs/ARCHITECTURE.md with project-level module overview, responsibilities, relationships, dependency direction, project-wide constraints, and links to module-level architecture docs.
- Create or update target module-level ARCHITECTURE.md files for clear module boundaries listed by module-index.json.
- Fill target docs/TESTING.md with project-native validation levels, commands, validation selection rules, final-validation cleanup, test layout, integration/E2E case lists, generated-context freshness checks, and known testing gaps.
- Review git status and git diff in the target task worktree.
- Stage only allowed bootstrap harness changes and create a commit in the target task worktree.

Boundaries:
- Do not write to the base repository root.
- Do not edit product source, product tests, package manifests, lockfiles, deployment config, secrets, or VCM managed blocks.
- Preserve user-authored content.
- Do not create new validation wrapper tools.
- VCM will not create the bootstrap commit for you.

Final response:
Summarize files reviewed, files updated, generated artifacts, commit hash, final git status, verified claims, inferred claims, unknowns, confirmation-needed items, and suggested validation commands.`;
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
