import path from "node:path";
import { CORE_VCM_ROLE_NAMES } from "../../shared/constants.js";
import type {
  ConnectProjectRequest,
  ProjectConfig,
  ProjectSummary
} from "../../shared/types/project.js";
import { VcmError } from "../errors.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { renderGitIdentityWarning, type GitAdapter } from "../adapters/git-adapter.js";
import type { EnvironmentCheck } from "./environment-check.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { ClaudeVersionCheck } from "./claude-version-check.js";

const DEFAULT_HANDOFF_ROOT = ".ai/vcm/handoffs";
const DEFAULT_STATE_ROOT = ".ai/vcm";

export interface ProjectService {
  connectProject(input: ConnectProjectRequest): Promise<ProjectSummary>;
  getCurrentProject(): Promise<ProjectSummary | null>;
  pullCurrentProject(): Promise<ProjectSummary>;
  getRecentRepositoryPaths(): Promise<string[]>;
  loadConfig(repoRoot: string): Promise<ProjectConfig>;
  saveConfig(config: ProjectConfig, force?: boolean): Promise<void>;
  getConfigPath(repoRoot: string): string;
  getProjectDataRoot(repoRoot: string): string;
}

export interface ProjectServiceDeps {
  fs: FileSystemAdapter;
  environmentCheck?: Pick<EnvironmentCheck, "getWarnings" | "getRepositoryWarnings">;
  environmentCheckWaitMs?: number;
  git: GitAdapter;
  appSettings: Pick<
    AppSettingsService,
    | "getRecentRepositoryPaths"
    | "recordRecentRepositoryPath"
    | "loadProjectConfig"
    | "saveProjectConfig"
    | "getProjectConfigPath"
  >;
  claudeVersionCheck?: ClaudeVersionCheck;
}

interface EnvironmentWarnings {
  host: string[];
  repository: string[];
}

const DEFAULT_ENVIRONMENT_CHECK_WAIT_MS = 5 * 1000;

export function createProjectService(deps: ProjectServiceDeps): ProjectService {
  const environmentCheckWaitMs = deps.environmentCheckWaitMs ?? DEFAULT_ENVIRONMENT_CHECK_WAIT_MS;
  let currentProject: ProjectSummary | null = null;

  return {
    async connectProject(input) {
      const requestedPath = input.repoPath.trim();
      const repoRoot = path.resolve(requestedPath);

      if (!requestedPath || !(await deps.fs.pathExists(repoRoot))) {
        throw new VcmError({
          code: "INVALID_REPO",
          message: "Selected path is not a Git repository.",
          hint: requestedPath
            ? `Path does not exist inside the VCM runtime: ${repoRoot}`
            : "Repository path cannot be empty.",
          statusCode: 400
        });
      }

      const repoCheck = await deps.git.checkRepo(repoRoot);
      if (!repoCheck.isRepo) {
        throw new VcmError({
          code: "INVALID_REPO",
          message: "Selected path is not a Git repository.",
          hint: repoCheck.hint,
          statusCode: 400
        });
      }

      const config = await this.loadConfig(repoRoot);
      await deps.fs.ensureDir(path.join(repoRoot, config.handoffRoot));
      await deps.fs.ensureDir(path.join(this.getProjectDataRoot(repoRoot), "tasks"));
      await deps.fs.ensureDir(path.join(repoRoot, ".claude", "worktrees"));
      await this.saveConfig(config, true);

      currentProject = await readConnectedProjectSummary(repoRoot, config, { refreshChecks: true });

      await deps.appSettings.recordRecentRepositoryPath(repoRoot);
      return currentProject;
    },
    async getCurrentProject() {
      if (currentProject) {
        currentProject = await readConnectedProjectSummary(currentProject.repoRoot, currentProject.config);
      }
      return currentProject;
    },
    async pullCurrentProject() {
      if (!currentProject) {
        throw new VcmError({
          code: "NO_PROJECT",
          message: "No connected repository.",
          statusCode: 409
        });
      }

      const beforePull = await readConnectedProjectSummary(currentProject.repoRoot, currentProject.config);
      if (beforePull.isDirty) {
        throw new VcmError({
          code: "BASE_REPO_DIRTY",
          message: "The connected repository has uncommitted changes.",
          statusCode: 409,
          hint: "Commit, stash, or discard base repository changes before pulling."
        });
      }
      if (!beforePull.upstreamBranch) {
        throw new VcmError({
          code: "NO_UPSTREAM",
          message: "The connected repository branch has no upstream.",
          statusCode: 409,
          hint: "Set an upstream branch before using Pull."
        });
      }

      await deps.git.pullFastForward(currentProject.repoRoot);
      currentProject = await readConnectedProjectSummary(currentProject.repoRoot, currentProject.config);
      return currentProject;
    },
    async getRecentRepositoryPaths() {
      return deps.appSettings.getRecentRepositoryPaths();
    },
    async loadConfig(repoRoot) {
      const appConfig = await deps.appSettings.loadProjectConfig(repoRoot);
      if (appConfig) {
        return normalizeProjectConfig(appConfig, repoRoot);
      }

      return buildDefaultProjectConfig(repoRoot);
    },
    async saveConfig(config, force = false) {
      const normalizedConfig = normalizeProjectConfig(config, config.repoRoot);
      const configPath = this.getConfigPath(normalizedConfig.repoRoot);
      if (!force && await deps.fs.pathExists(configPath)) {
        return;
      }
      await deps.appSettings.saveProjectConfig(normalizedConfig);
    },
    getConfigPath(repoRoot) {
      return deps.appSettings.getProjectConfigPath(repoRoot);
    },
    getProjectDataRoot(repoRoot) {
      return path.dirname(deps.appSettings.getProjectConfigPath(repoRoot));
    }
  };

  async function readEnvironmentWarnings(repoRoot: string, refresh?: boolean): Promise<EnvironmentWarnings> {
    const [host, repository] = await Promise.all([
      // Startup already ran the host checks; their cache retries failures
      // after 30 s, so a connect only refreshes the repository's own checks.
      (deps.environmentCheck?.getWarnings() ?? Promise.resolve([])).catch((caught: unknown) => [
        `Unable to check the host environment. ${getErrorHint(caught)}`
      ]),
      (deps.environmentCheck?.getRepositoryWarnings(repoRoot, { refresh }) ?? Promise.resolve([])).catch((caught: unknown) => [
        `Unable to check access to the Git remote. ${getErrorHint(caught)}`
      ])
    ]);
    return { host, repository };
  }

  // A slow network must not stall the Repository panel: checks that outlast the
  // wait keep running and fill the cache for the next refresh.
  async function waitForChecks(checks: Promise<EnvironmentWarnings>): Promise<EnvironmentWarnings> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<EnvironmentWarnings>((resolve) => {
      timer = setTimeout(() => resolve({
        host: ["VCM is still checking the host environment and Git remote access. Refresh the Repository panel to see the result."],
        repository: []
      }), environmentCheckWaitMs);
    });
    try {
      return await Promise.race([checks, pending]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readConnectedProjectSummary(
    repoRoot: string,
    config: ProjectConfig,
    options: { refreshChecks?: boolean } = {}
  ): Promise<ProjectSummary> {
    const warnings: string[] = [];
    // Environment and remote checks reach the network (gh auth status, git
    // ls-remote), so they run alongside the local Git reads below.
    const environmentChecks = readEnvironmentWarnings(repoRoot, options.refreshChecks);
    const claudeVersionWarning = await deps.claudeVersionCheck?.getWarning(config.claudeCommand, {
      refresh: options.refreshChecks
    });
    if (claudeVersionWarning) {
      warnings.push(claudeVersionWarning);
    }
    const environmentWarnings = await waitForChecks(environmentChecks);
    warnings.push(...environmentWarnings.host);
    try {
      const identity = await deps.git.resolveCommitIdentity(repoRoot);
      if (identity.defaulted.length > 0) {
        warnings.push(renderGitIdentityWarning("this repository", identity));
      }
    } catch (caught) {
      warnings.push(`Unable to read the Git commit identity. ${getErrorHint(caught)}`);
    }
    let branch = "unknown";
    let isDirty = false;
    let headCommit = "unknown";
    let upstreamBranch: string | null = null;
    let ahead: number | null = null;
    let behind: number | null = null;

    try {
      branch = await deps.git.getCurrentBranch(repoRoot);
    } catch (caught) {
      warnings.push(`Unable to read current Git branch. ${getErrorHint(caught)}`);
    }

    try {
      isDirty = await deps.git.isDirty(repoRoot);
    } catch (caught) {
      warnings.push(`Unable to read Git dirty status. ${getErrorHint(caught)}`);
    }

    try {
      headCommit = await deps.git.getHeadCommit(repoRoot);
    } catch (caught) {
      warnings.push(`Unable to read current Git commit. ${getErrorHint(caught)}`);
    }

    try {
      upstreamBranch = await deps.git.getUpstreamBranch(repoRoot);
    } catch (caught) {
      warnings.push(`Unable to read Git upstream branch. ${getErrorHint(caught)}`);
    }

    if (upstreamBranch) {
      try {
        const status = await deps.git.getAheadBehind(repoRoot, upstreamBranch);
        ahead = status.ahead;
        behind = status.behind;
      } catch (caught) {
        warnings.push(`Unable to read Git ahead/behind status. ${getErrorHint(caught)}`);
      }
    }

    warnings.push(...environmentWarnings.repository);

    const pullDisabledReason = getPullDisabledReason({ isDirty, upstreamBranch });

    return {
      repoRoot,
      branch,
      isDirty,
      headCommit,
      shortHeadCommit: headCommit === "unknown" ? "unknown" : headCommit.slice(0, 12),
      upstreamBranch,
      ahead,
      behind,
      canPull: !pullDisabledReason,
      pullDisabledReason,
      checkedAt: new Date().toISOString(),
      config,
      warnings
    };
  }
}

function getPullDisabledReason(input: { isDirty: boolean; upstreamBranch: string | null }): string | undefined {
  if (input.isDirty) {
    return "Base repository has uncommitted changes.";
  }
  if (!input.upstreamBranch) {
    return "Current branch has no upstream.";
  }
  return undefined;
}

function getErrorHint(caught: unknown): string {
  if (caught instanceof VcmError) {
    return caught.hint?.trim() || caught.message;
  }

  if (caught instanceof Error) {
    return caught.message;
  }

  return "Unknown Git metadata error.";
}

export function buildDefaultProjectConfig(repoRoot: string): ProjectConfig {
  return {
    version: 1,
    repoRoot,
    defaultRoles: [...CORE_VCM_ROLE_NAMES],
    handoffRoot: DEFAULT_HANDOFF_ROOT,
    stateRoot: DEFAULT_STATE_ROOT,
    terminalBackend: "node-pty",
    claudeCommand: process.env.VCM_CLAUDE_COMMAND || "claude"
  };
}

function normalizeProjectConfig(input: Partial<ProjectConfig>, repoRoot: string): ProjectConfig {
  const fallback = buildDefaultProjectConfig(repoRoot);
  return {
    version: 1,
    repoRoot,
    defaultRoles: input.defaultRoles?.length ? input.defaultRoles : fallback.defaultRoles,
    handoffRoot: DEFAULT_HANDOFF_ROOT,
    stateRoot: DEFAULT_STATE_ROOT,
    terminalBackend: "node-pty",
    claudeCommand: input.claudeCommand || fallback.claudeCommand
  };
}
