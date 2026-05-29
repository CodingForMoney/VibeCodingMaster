import { describe, expect, it } from "vitest";
import { createProjectService } from "../../../src/backend/services/project-service.js";
import type { ClaudeAdapter } from "../../../src/backend/adapters/claude-adapter.js";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { GitAdapter } from "../../../src/backend/adapters/git-adapter.js";

describe("createProjectService", () => {
  it("trims repository paths before validating the Git repository", async () => {
    const fs = createMemoryFs(new Set(["/workspace"]));
    const checkedRepos: string[] = [];
    const service = createProjectService({
      fs,
      git: createGitAdapterStub(checkedRepos),
      claude: createClaudeAdapterStub()
    });

    const project = await service.connectProject({ repoPath: "  /workspace  " });

    expect(project.repoRoot).toBe("/workspace");
    expect(checkedRepos).toEqual(["/workspace"]);
  });

  it("returns a useful hint when the path is not visible to the VCM runtime", async () => {
    const service = createProjectService({
      fs: createMemoryFs(new Set()),
      git: createGitAdapterStub([]),
      claude: createClaudeAdapterStub()
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
      claude: createClaudeAdapterStub()
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
});

function createMemoryFs(existingPaths: Set<string>): FileSystemAdapter {
  return {
    async pathExists(targetPath) {
      return existingPaths.has(targetPath);
    },
    async ensureDir(targetPath) {
      existingPaths.add(targetPath);
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
    async readJson() {
      throw new Error("not implemented");
    },
    async writeJson(targetPath) {
      existingPaths.add(targetPath);
    },
    async writeJsonAtomic(targetPath) {
      existingPaths.add(targetPath);
    },
    async ensureFile(targetPath) {
      existingPaths.add(targetPath);
      return true;
    }
  };
}

function createGitAdapterStub(checkedRepos: string[], options: { failMetadata?: boolean } = {}): GitAdapter {
  return {
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
    async isDirty() {
      if (options.failMetadata) {
        throw new Error("status unavailable");
      }
      return false;
    }
  };
}

function createClaudeAdapterStub(): ClaudeAdapter {
  return {
    async isAvailable() {
      return true;
    },
    async getVersion() {
      return "2.1.0";
    },
    buildRoleStartCommand() {
      return { command: "claude", args: [], display: "claude" };
    }
  };
}
