import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createHarnessService } from "../../../src/backend/services/harness-service.js";

describe("createHarnessService", () => {
  it("plans and applies recommended harness files when they are missing", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.needsApply).toBe(true);
    expect(status.plannedChanges).toHaveLength(5);
    expect(status.plannedChanges.map((change) => change.action)).toEqual([
      "create",
      "create",
      "create",
      "create",
      "create"
    ]);

    const result = await service.applyHarness("/repo");
    expect(result.changedFiles).toHaveLength(5);

    const nextStatus = await service.getHarnessStatus("/repo");
    expect(nextStatus.needsApply).toBe(false);
    expect(nextStatus.files.map((file) => file.action)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Shared Rules");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("name: project-manager");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("<!-- VCM:BEGIN version=1 -->");
  });

  it("inserts VCM rules into an existing file without overwriting user content", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/CLAUDE.md", "# Existing Rules\n\nKeep this project-specific note.\n");
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.files.find((file) => file.path === "CLAUDE.md")).toMatchObject({
      exists: true,
      hasManagedBlock: false,
      action: "insert"
    });

    await service.applyHarness("/repo");

    const content = await fs.readText("/repo/CLAUDE.md");
    expect(content).toContain("# Existing Rules");
    expect(content).toContain("Keep this project-specific note.");
    expect(content).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(content).toContain("## VCM Shared Rules");
  });

  it("updates only the managed block when VCM rules drift", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/CLAUDE.md", [
      "# Existing Rules",
      "",
      "Before block.",
      "",
      "<!-- VCM:BEGIN version=0 -->",
      "old managed rules",
      "<!-- VCM:END -->",
      "",
      "After block.",
      ""
    ].join("\n"));
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.files.find((file) => file.path === "CLAUDE.md")).toMatchObject({
      exists: true,
      hasManagedBlock: true,
      managedVersion: 0,
      action: "update"
    });

    await service.applyHarness("/repo");

    const content = await fs.readText("/repo/CLAUDE.md");
    expect(content).toContain("Before block.");
    expect(content).toContain("After block.");
    expect(content).not.toContain("old managed rules");
    expect(content).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(content).toContain("## VCM Shared Rules");
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
