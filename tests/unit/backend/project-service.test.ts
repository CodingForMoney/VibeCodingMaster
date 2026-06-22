import { describe, expect, it } from "vitest";
import { createProjectService } from "../../../src/backend/services/project-service.js";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { GitAdapter } from "../../../src/backend/adapters/git-adapter.js";
import { getProjectId, type AppSettingsService } from "../../../src/backend/services/app-settings-service.js";

describe("createProjectService", () => {
  it("trims repository paths before validating the Git repository", async () => {
    const fs = createMemoryFs(new Set(["/workspace"]));
    const checkedRepos: string[] = [];
    const service = createProjectService({
      fs,
      git: createGitAdapterStub(checkedRepos),
      appSettings: createAppSettingsStub()
    });

    const project = await service.connectProject({ repoPath: "  /workspace  " });

    expect(project.repoRoot).toBe("/workspace");
    expect(checkedRepos).toEqual(["/workspace"]);
  });

  it("returns a useful hint when the path is not visible to the VCM runtime", async () => {
    const service = createProjectService({
      fs: createMemoryFs(new Set()),
      git: createGitAdapterStub([]),
      appSettings: createAppSettingsStub()
    });

    await expect(service.connectProject({ repoPath: "/workspace" })).rejects.toMatchObject({
      code: "INVALID_REPO",
      hint: "Path does not exist inside the VCM runtime: /workspace"
    });
  });

  it("connects when the repo marker is valid even if Git metadata reads fail", async () => {
    const service = createProjectService({
      fs: createMemoryFs(new Set(["/workspace"])),
      git: createGitAdapterStub([], { failMetadata: true }),
      appSettings: createAppSettingsStub()
    });

    const project = await service.connectProject({ repoPath: "/workspace" });

    expect(project.repoRoot).toBe("/workspace");
    expect(project.branch).toBe("unknown");
    expect(project.isDirty).toBe(false);
    expect(project.warnings).toEqual([
      "Unable to read current Git branch. branch unavailable",
      "Unable to read Git dirty status. status unavailable"
    ]);
  });

  it("records successful repository connections in recent paths", async () => {
    const appSettings = createAppSettingsStub();
    const service = createProjectService({
      fs: createMemoryFs(new Set(["/workspace"])),
      git: createGitAdapterStub([]),
      appSettings
    });

    await service.connectProject({ repoPath: "/workspace" });

    expect(appSettings.recordedPaths).toEqual(["/workspace"]);
    expect(await service.getRecentRepositoryPaths()).toEqual(["/workspace"]);
  });

  it("stores project config in the app project config path", async () => {
    const fs = createMemoryFs(new Set(["/workspace"]));
    const service = createProjectService({
      fs,
      git: createGitAdapterStub([]),
      appSettings: createAppSettingsStub(fs)
    });

    const project = await service.connectProject({ repoPath: "/workspace" });
    const configPath = `/home/.vcm/projects/${getProjectId("/workspace")}/config.json`;
    const tasksPath = `/home/.vcm/projects/${getProjectId("/workspace")}/tasks`;

    expect(project.config.claudeCommand).toBe("claude");
    await expect(fs.readJson(configPath)).resolves.toMatchObject({
      stateRoot: ".ai/vcm",
      claudeCommand: "claude"
    });
    expect(fs.createdPaths).toContain(tasksPath);
    expect(fs.createdPaths).not.toContain("/workspace/.ai/vcm/tasks");
    await expect(fs.pathExists("/workspace/.ai/vcm/config.json")).resolves.toBe(false);
  });

  it("pulls the connected repository with fast-forward only", async () => {
    const git = createGitAdapterStub([]);
    const service = createProjectService({
      fs: createMemoryFs(new Set(["/workspace"])),
      git,
      appSettings: createAppSettingsStub()
    });

    await service.connectProject({ repoPath: "/workspace" });
    const project = await service.pullCurrentProject();

    expect(git.pullCalls).toEqual(["/workspace"]);
    expect(project.canPull).toBe(true);
  });
});

function createMemoryFs(existingPaths: Set<string>, files = new Map<string, string>()): FileSystemAdapter & { createdPaths: string[] } {
  const adapter = {
    createdPaths: [] as string[],
    async pathExists(targetPath) {
      return existingPaths.has(targetPath) || files.has(targetPath);
    },
    async ensureDir(targetPath) {
      existingPaths.add(targetPath);
      this.createdPaths.push(targetPath);
    },
    async readDir() {
      return [];
    },
    async readText() {
      return "";
    },
    async writeText(targetPath) {
      existingPaths.add(targetPath);
    },
    async appendText(targetPath) {
      existingPaths.add(targetPath);
    },
    async readJson(targetPath) {
      const value = files.get(targetPath);
      if (value === undefined) {
        throw new Error(`missing ${targetPath}`);
      }
      return JSON.parse(value);
    },
    async writeJson(targetPath, value) {
      existingPaths.add(targetPath);
      files.set(targetPath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeJsonAtomic(targetPath, value) {
      await this.writeJson(targetPath, value);
    },
    async ensureFile(targetPath) {
      existingPaths.add(targetPath);
      return true;
    },
    async removePath(targetPath) {
      existingPaths.delete(targetPath);
      files.delete(targetPath);
    }
  };
  return adapter;
}

function createGitAdapterStub(
  checkedRepos: string[],
  options: { failMetadata?: boolean } = {}
): GitAdapter & { pullCalls: string[] } {
  const pullCalls: string[] = [];
  return {
    pullCalls,
    async checkRepo(repoRoot) {
      checkedRepos.push(repoRoot);
      return { isRepo: true };
    },
    async isRepo() {
      return true;
    },
    async getCurrentBranch() {
      if (options.failMetadata) {
        throw new Error("branch unavailable");
      }
      return "feature/devcontainer";
    },
    async getHeadCommit() {
      return "abcdef1234567890";
    },
    async getUpstreamBranch() {
      return "origin/feature/devcontainer";
    },
    async getAheadBehind() {
      return {
        ahead: 0,
        behind: 0
      };
    },
    async isDirty() {
      if (options.failMetadata) {
        throw new Error("status unavailable");
      }
      return false;
    },
    async getStatusPorcelain() {
      return "";
    },
    async isIgnored() {
      return true;
    },
    async branchExists() {
      return false;
    },
    async createWorktree() {},
    async removeWorktree() {},
    async deleteBranch() {},
    async pullFastForward(repoRoot) {
      pullCalls.push(repoRoot);
      return {
        stdout: "",
        stderr: ""
      };
    }
  };
}

function createAppSettingsStub(fs = createMemoryFs(new Set())): Pick<
  AppSettingsService,
  | "getRecentRepositoryPaths"
  | "recordRecentRepositoryPath"
  | "loadProjectConfig"
  | "saveProjectConfig"
  | "getProjectConfigPath"
> & {
  recordedPaths: string[];
} {
  const recordedPaths: string[] = [];
  return {
    recordedPaths,
    async getRecentRepositoryPaths() {
      return recordedPaths;
    },
    async recordRecentRepositoryPath(repoRoot) {
      recordedPaths.unshift(repoRoot);
      return recordedPaths;
    },
    async loadProjectConfig(repoRoot) {
      const configPath = this.getProjectConfigPath(repoRoot);
      if (!(await fs.pathExists(configPath))) {
        return undefined;
      }
      return fs.readJson(configPath);
    },
    async saveProjectConfig(config) {
      await fs.writeJsonAtomic(this.getProjectConfigPath(config.repoRoot), config);
      return config;
    },
    getProjectConfigPath(repoRoot) {
      return `/home/.vcm/projects/${getProjectId(repoRoot)}/config.json`;
    }
  };
}
