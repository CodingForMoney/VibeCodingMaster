import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createArtifactService } from "../../../src/backend/services/artifact-service.js";

describe("createArtifactService", () => {
  it("prefers role-commands/<role>.md for role command paths", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    await fs.writeText("/repo/.ai/vcm/handoffs/role-commands/coder.md", "# ready");

    await expect(service.resolveRoleCommandPath({
      repoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      role: "coder"
    })).resolves.toBe(".ai/vcm/handoffs/role-commands/coder.md");
  });

  it("falls back to legacy role-commands/<role>-command.md files", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    await fs.writeText("/repo/.ai/vcm/handoffs/role-commands/coder-command.md", "# legacy");

    await expect(service.resolveRoleCommandPath({
      repoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      role: "coder"
    })).resolves.toBe(".ai/vcm/handoffs/role-commands/coder-command.md");
  });

  it("rejects placeholder role commands before dispatch", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    await fs.writeText("/repo/.ai/vcm/handoffs/role-commands/coder.md", "# coder\n\n## Objective\n\nTBD\n");

    await expect(service.readRoleCommand({
      repoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      role: "coder"
    })).rejects.toMatchObject({
      code: "ROLE_COMMAND_NOT_READY"
    });
  });

  it("creates and checks docs sync and final acceptance artifacts", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);

    const created = await service.createArtifactTemplates({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      handoffDir: ".ai/vcm/handoffs"
    });
    const summary = await service.listArtifacts({
      repoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs"
    });

    expect(created).toContain(".ai/vcm/handoffs/docs-sync-report.md");
    expect(created).toContain(".ai/vcm/handoffs/final-acceptance.md");
    expect(created).toContain(".ai/vcm/handoffs/known-issues.md");
    expect(summary.paths.docsSyncReportPath).toBe(".ai/vcm/handoffs/docs-sync-report.md");
    expect(summary.paths.finalAcceptancePath).toBe(".ai/vcm/handoffs/final-acceptance.md");
    expect(summary.paths.knownIssuesPath).toBe(".ai/vcm/handoffs/known-issues.md");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/role-commands/coder.md"))
      .resolves.toContain("## Worktree");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/role-commands/coder.md"))
      .resolves.toContain("Task repo root: /repo");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/role-commands/coder.md"))
      .resolves.toContain("Rule: only edit files under Task repo root.");
    expect(summary.checks.find((check) => check.kind === "docs-sync-report")).toMatchObject({
      status: "incomplete",
      hasPlaceholder: true
    });
    expect(summary.checks.find((check) => check.kind === "final-acceptance")).toMatchObject({
      status: "incomplete",
      hasPlaceholder: true
    });
    expect(summary.checks.find((check) => check.kind === "known-issues")).toMatchObject({
      status: "ok",
      hasPlaceholder: false
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
