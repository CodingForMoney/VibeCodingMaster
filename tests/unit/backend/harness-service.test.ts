import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createHarnessService } from "../../../src/backend/services/harness-service.js";

describe("createHarnessService", () => {
  it("plans and applies recommended harness files when they are missing", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.needsApply).toBe(true);
    expect(status.plannedChanges).toHaveLength(14);
    expect(status.plannedChanges.map((change) => change.action)).toEqual([
      "create",
      "create",
      "create",
      "create",
      "create",
      "create",
      "create",
      "create",
      "create",
      "create",
      "create",
      "create",
      "create",
      "create"
    ]);

    const result = await service.applyHarness("/repo");
    expect(result.changedFiles).toHaveLength(14);

    const nextStatus = await service.getHarnessStatus("/repo");
    expect(nextStatus.needsApply).toBe(false);
    expect(nextStatus.files.map((file) => file.action)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Start Here");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Task Flow");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Worktree Policy");
    expect(await fs.readText("/repo/.gitignore")).toContain("# VCM:BEGIN version=1");
    expect(await fs.readText("/repo/.gitignore")).toContain(".ai/vcm/");
    expect(await fs.readText("/repo/.gitignore")).toContain(".claude/worktrees/");
    expect(await fs.readText("/repo/.gitignore")).not.toContain(".vcm/");
    expect(await fs.readText("/repo/docs/known-issues.md")).toContain("## VCM Known Issues Policy");
    expect(await fs.readText("/repo/docs/known-issues.md")).toContain(".ai/vcm/handoffs/known-issues.md");
    expect(await fs.readText("/repo/.github/pull_request_template.md")).toContain("## Validation");
    expect(await fs.readText("/repo/.github/pull_request_template.md")).toContain("Final acceptance completed");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message.md")).toContain("## Purpose");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message.md")).toContain("This skill writes a route file");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message.md")).toContain("After writing or updating the route file, end the current Claude Code turn immediately.");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance.md")).toContain("## Scope Traceability Audit");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance.md")).toContain("Do not claim to prove that the diff is exactly equal to the task scope.");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance.md")).toContain(".ai/vcm/handoffs/final-acceptance.md");
    expect(await fs.readText("/repo/.claude/skills/vcm-harness-bootstrap.md")).toContain("AI-assisted project understanding");
    expect(await fs.readText("/repo/.claude/skills/vcm-harness-maintenance.md")).toContain("harness drift audit");
    expect(await fs.readText("/repo/.claude/skills/vcm-long-running-validation.md")).toContain("## Protocol");
    expect(await fs.readText("/repo/.claude/skills/vcm-long-running-validation.md")).toContain(".ai/tools/watch-job");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("name: project-manager");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("Use the routes defined in `CLAUDE.md`");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("Do not perform technical analysis");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("Before dispatching a role, update that role's command");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("### PR Preparation");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain(".github/pull_request_template.md");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("VCM_TASK_REPO_ROOT");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("Include the confirmed task repo root and branch in each role command `## Worktree` section");
    expect(await fs.readText("/repo/.claude/agents/architect.md")).toContain("verifiable behavior, phase boundaries, behavior/contract proof points");
    expect(await fs.readText("/repo/.claude/agents/architect.md")).toContain("Read `.ai/vcm/handoffs/known-issues.md` and promote confirmed unresolved issues to `docs/known-issues.md`.");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("UserPromptSubmit");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("Stop");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("/api/hooks/claude-code");
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
    expect(content).toContain("## VCM Start Here");
  });

  it("inserts VCM ignore rules into an existing .gitignore without overwriting user patterns", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/.gitignore", "node_modules/\ndist/\n");
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.files.find((file) => file.path === ".gitignore")).toMatchObject({
      exists: true,
      hasManagedBlock: false,
      action: "insert"
    });

    await service.applyHarness("/repo");

    const content = await fs.readText("/repo/.gitignore");
    expect(content).toContain("node_modules/");
    expect(content).toContain("dist/");
    expect(content).toContain("# VCM:BEGIN version=1");
    expect(content).toContain(".ai/vcm/");
    expect(content).toContain(".claude/worktrees/");
    expect(content).not.toContain("<!-- VCM:BEGIN");
  });

  it("replaces old VCM hook commands with direct HTTP hooks", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/.claude/settings.json", JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{
              type: "command",
              command: "vcmctl hook-event",
              timeout: 5
            }]
          }
        ],
        Stop: [
          {
            hooks: [{
              type: "command",
              command: "vcmctl hook-event",
              timeout: 5
            }]
          }
        ],
        PreToolUse: [
          {
            hooks: [{
              type: "command",
              command: "echo keep-user-hook"
            }]
          }
        ]
      }
    }, null, 2));
    const service = createHarnessService({ fs });

    await service.applyHarness("/repo");

    const settings = JSON.parse(await fs.readText("/repo/.claude/settings.json"));
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toContain("/api/hooks/claude-code");
    expect(JSON.stringify(settings.hooks.Stop)).toContain("/api/hooks/claude-code");
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).not.toContain("vcmctl");
    expect(JSON.stringify(settings.hooks.Stop)).not.toContain("vcmctl");
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain("echo keep-user-hook");
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
    expect(content).toContain("## VCM Start Here");
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
