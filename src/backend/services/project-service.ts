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

export interface ProjectService {
  connectProject(input: ConnectProjectRequest): Promise<ProjectSummary>;
  getCurrentProject(): Promise<ProjectSummary | null>;
  loadConfig(repoRoot: string): Promise<ProjectConfig>;
  saveConfig(config: ProjectConfig, force?: boolean): Promise<void>;
  getConfigPath(repoRoot: string): string;
}

export interface ProjectServiceDeps {
  fs: FileSystemAdapter;
  git: GitAdapter;
  claude: ClaudeAdapter;
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

      const config = buildDefaultProjectConfig(repoRoot);
      await deps.fs.ensureDir(path.join(repoRoot, config.handoffRoot));
      await deps.fs.ensureDir(path.join(repoRoot, config.stateRoot, "tasks"));
      await deps.fs.ensureDir(path.join(repoRoot, config.stateRoot, "sessions"));
      await this.saveConfig(config, true);

      const branch = await deps.git.getCurrentBranch(repoRoot);
      const isDirty = await deps.git.isDirty(repoRoot);
      const warnings: string[] = [];

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

      return currentProject;
    },
    async getCurrentProject() {
      return currentProject;
    },
    async loadConfig(repoRoot) {
      const configPath = this.getConfigPath(repoRoot);
      if (!(await deps.fs.pathExists(configPath))) {
        return buildDefaultProjectConfig(repoRoot);
      }
      return deps.fs.readJson<ProjectConfig>(configPath);
    },
    async saveConfig(config, force = false) {
      const configPath = this.getConfigPath(config.repoRoot);
      if (!force && await deps.fs.pathExists(configPath)) {
        return;
      }
      await deps.fs.writeJsonAtomic(configPath, config);
    },
    getConfigPath(repoRoot) {
      return path.join(repoRoot, ".vcm", "config.json");
    }
  };
}

export function buildDefaultProjectConfig(repoRoot: string): ProjectConfig {
  return {
    version: 1,
    repoRoot,
    defaultRoles: [...ROLE_NAMES],
    handoffRoot: ".ai/handoffs",
    stateRoot: ".vcm",
    terminalBackend: "node-pty",
    claudeCommand: process.env.VCM_CLAUDE_COMMAND || "claude"
  };
}
