import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createArtifactService } from "../../../src/backend/services/artifact-service.js";

describe("createArtifactService", () => {
  it("prefers role-commands/<role>.md for role command paths", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    await fs.writeText("/repo/.ai/handoffs/tests-dir-cleanup/role-commands/coder.md", "# ready");

    await expect(service.resolveRoleCommandPath({
      repoRoot: "/repo",
      handoffDir: ".ai/handoffs/tests-dir-cleanup",
      role: "coder"
    })).resolves.toBe(".ai/handoffs/tests-dir-cleanup/role-commands/coder.md");
  });

  it("falls back to legacy role-commands/<role>-command.md files", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    await fs.writeText("/repo/.ai/handoffs/demo-task/role-commands/coder-command.md", "# legacy");

    await expect(service.resolveRoleCommandPath({
      repoRoot: "/repo",
      handoffDir: ".ai/handoffs/demo-task",
      role: "coder"
    })).resolves.toBe(".ai/handoffs/demo-task/role-commands/coder-command.md");
  });

  it("rejects placeholder role commands before dispatch", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    await fs.writeText("/repo/.ai/handoffs/demo-task/role-commands/coder.md", "# coder\n\n## Objective\n\nTBD\n");

    await expect(service.readRoleCommand({
      repoRoot: "/repo",
      handoffDir: ".ai/handoffs/demo-task",
      role: "coder"
    })).rejects.toMatchObject({
      code: "ROLE_COMMAND_NOT_READY"
    });
  });
});

function createMemoryFs(): FileSystemAdapter {
  const files = new Map<string, string>();
  return {
    async pathExists(targetPath) {
      return files.has(targetPath);
    },
    async ensureDir() {},
    async readDir() {
      return [];
    },
    async readText(targetPath) {
      const value = files.get(targetPath);
      if (value === undefined) {
        throw new Error(`missing ${targetPath}`);
      }
      return value;
    },
    async writeText(targetPath, content) {
      files.set(targetPath, content);
    },
    async appendText(targetPath, content) {
      files.set(targetPath, `${files.get(targetPath) ?? ""}${content}`);
    },
    async readJson(targetPath) {
      return JSON.parse(await this.readText(targetPath));
    },
    async writeJson(targetPath, value) {
      await this.writeText(targetPath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeJsonAtomic(targetPath, value) {
      await this.writeJson(targetPath, value);
    },
    async ensureFile(targetPath, content) {
      if (files.has(targetPath)) {
        return false;
      }
      files.set(targetPath, content);
      return true;
    }
  };
}
