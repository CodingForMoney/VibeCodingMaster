import path from "node:path";
import { ROLE_NAMES } from "../../shared/constants.js";
import type {
  ConnectProjectRequest,
  ProjectConfig,
  ProjectSummary
} from "../../shared/types/project.js";
import { VcmError } from "../errors.js";
import type { ClaudeAdapter } from "../adapters/claude-adapter.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { GitAdapter } from "../adapters/git-adapter.js";
import type { AppSettingsService } from "./app-settings-service.js";

const DEFAULT_HANDOFF_ROOT = ".ai/vcm/handoffs";
const DEFAULT_STATE_ROOT = ".ai/vcm";

export interface ProjectService {
  connectProject(input: ConnectProjectRequest): Promise<ProjectSummary>;
  getCurrentProject(): Promise<ProjectSummary | null>;
  getRecentRepositoryPaths(): Promise<string[]>;
  loadConfig(repoRoot: string): Promise<ProjectConfig>;
  saveConfig(config: ProjectConfig, force?: boolean): Promise<void>;
  getConfigPath(repoRoot: string): string;
  getProjectDataRoot(repoRoot: string): string;
}

export interface ProjectServiceDeps {
  fs: FileSystemAdapter;
  git: GitAdapter;
  claude: ClaudeAdapter;
  appSettings: Pick<
    AppSettingsService,
    | "getRecentRepositoryPaths"
    | "recordRecentRepositoryPath"
    | "loadProjectConfig"
    | "saveProjectConfig"
    | "getProjectConfigPath"
  >;
}

export function createProjectService(deps: ProjectServiceDeps): ProjectService {
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

      const warnings: string[] = [];
      let branch = "unknown";
      let isDirty = false;

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

      if (branch === "main" || branch === "master") {
        warnings.push(`You are on ${branch}. Consider creating a task branch before coding.`);
      }

      if (!(await deps.claude.isAvailable(config.claudeCommand))) {
        warnings.push("Claude Code command is not available. You can still inspect artifacts, but sessions will not start.");
      }

      currentProject = {
        repoRoot,
        branch,
        isDirty,
        config,
        warnings
      };

      await deps.appSettings.recordRecentRepositoryPath(repoRoot);
      return currentProject;
    },
    async getCurrentProject() {
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
    defaultRoles: [...ROLE_NAMES],
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
