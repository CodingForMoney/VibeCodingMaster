import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createHarnessService } from "../../../src/backend/services/harness-service.js";

describe("createHarnessService", () => {
  it("plans and applies recommended harness files when they are missing", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.needsApply).toBe(true);
    // B1: a fresh repo with every harness file missing is not yet initialized.
    expect(status.initialized).toBe(false);
    expect(status.plannedChanges).toHaveLength(20);
    expect(status.plannedChanges.map((change) => change.action)).toEqual(Array(20).fill("create"));

    const result = await service.applyHarness("/repo");
    expect(result.changedFiles).toHaveLength(20);

    const nextStatus = await service.getHarnessStatus("/repo");
    expect(nextStatus.needsApply).toBe(false);
    // B2: once the harness is applied, VCM markers exist -> initialized.
    expect(nextStatus.initialized).toBe(true);
    expect(nextStatus.files.map((file) => file.action)).toEqual(Array(20).fill("ok"));
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Start Here");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Task Flow");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Worktree Policy");
    expect(await fs.readText("/repo/.gitignore")).toContain("# VCM:BEGIN version=1");
    expect(await fs.readText("/repo/.gitignore")).toContain(".ai/vcm/");
    expect(await fs.readText("/repo/.gitignore")).toContain(".claude/worktrees/");
    expect(await fs.readText("/repo/.gitignore")).not.toContain(".vcm/");
    expect(await fs.readText("/repo/.github/pull_request_template.md")).toContain("## Validation");
    expect(await fs.readText("/repo/.github/pull_request_template.md")).toContain("Final acceptance completed");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message/SKILL.md")).toContain("name: vcm-route-message");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message/SKILL.md")).toContain("## Purpose");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message/SKILL.md")).toContain("This skill writes a route file");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message/SKILL.md")).toContain("After writing or updating the route file, end the current Claude Code turn immediately.");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain("name: vcm-final-acceptance");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain("## File Scope Audit");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain("Do not claim to prove that every diff hunk exactly matches the task.");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain(".ai/vcm/handoffs/final-acceptance.md");
    expect(await fs.readText("/repo/.claude/skills/vcm-harness-bootstrap/SKILL.md")).toContain("name: vcm-harness-bootstrap");
    expect(await fs.readText("/repo/.claude/skills/vcm-harness-bootstrap/SKILL.md")).toContain("AI-assisted project understanding");
    expect(await fs.readText("/repo/.claude/skills/vcm-long-running-validation/SKILL.md")).toContain("name: vcm-long-running-validation");
    expect(await fs.readText("/repo/.claude/skills/vcm-long-running-validation/SKILL.md")).toContain("## Protocol");
    expect(await fs.readText("/repo/.claude/skills/vcm-long-running-validation/SKILL.md")).toContain(".ai/tools/watch-job");
    expect(await fs.readText("/repo/.claude/skills/vcm-codex-review-gate/SKILL.md")).toContain("name: vcm-codex-review-gate");
    expect(await fs.readText("/repo/.claude/skills/vcm-codex-review-gate/SKILL.md")).toContain("Do not run `codex exec` yourself");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("name: project-manager");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("Use the routes defined in `CLAUDE.md`");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("Do not perform technical analysis");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("Use the `vcm-route-message` skill for every role dispatch");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("### PR Preparation");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("### Background Jobs");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain(".github/pull_request_template.md");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("VCM_TASK_REPO_ROOT");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("Include the confirmed task repo root and branch in each role message");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("### Codex Review Gates");
    expect(await fs.readText("/repo/.claude/agents/architect.md")).toContain("verifiable behavior, phase boundaries, behavior/contract proof points");
    expect(await fs.readText("/repo/.claude/agents/architect.md")).toContain("Read `.ai/vcm/handoffs/known-issues.md` and promote confirmed unresolved issues to `docs/known-issues.md`.");
    expect(await fs.readText("/repo/.ai/codex/AGENTS.md")).toContain("You are VCM `codex-reviewer`");
    expect(await fs.readText("/repo/.ai/codex/config.toml")).toContain("[vcm.codex_review]");
    expect(await fs.readText("/repo/.ai/codex/prompts/architecture-plan-gate.md")).toContain("Codex Gate: architecture-plan");
    expect(await fs.readText("/repo/.ai/codex/prompts/validation-adequacy-gate.md")).toContain("Codex Gate: validation-adequacy");
    expect(await fs.readText("/repo/.ai/codex/prompts/final-diff-gate.md")).toContain("Codex Gate: final-diff");
    expect(await fs.readText("/repo/.ai/codex/schemas/codex-review-result.schema.json")).toContain("VCM Codex Review Result");
    expect(await fs.readText("/repo/.ai/tools/request-codex-review")).toContain("Request a VCM-managed Codex Review Gate");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("UserPromptSubmit");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("Stop");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("PermissionRequest");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("PreToolUse");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("vcm-bash-guard");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("/api/hooks/claude-code");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("/api/hooks/claude-code/stop");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("/api/hooks/claude-code/permission-request");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("BASH_DEFAULT_TIMEOUT_MS");
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
    // B3: a pre-existing non-VCM CLAUDE.md (insert, no managed block) is not initialized.
    expect(status.initialized).toBe(false);

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

    // B4: a pre-existing .claude/settings.json without VCM markers is not initialized.
    const status = await service.getHarnessStatus("/repo");
    expect(status.initialized).toBe(false);

    await service.applyHarness("/repo");

    const settings = JSON.parse(await fs.readText("/repo/.claude/settings.json"));
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toContain("/api/hooks/claude-code");
    expect(JSON.stringify(settings.hooks.Stop)).toContain("/api/hooks/claude-code");
    expect(JSON.stringify(settings.hooks.PermissionRequest)).toContain("/api/hooks/claude-code/permission-request");
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
    // B5: a drifted managed block is still a VCM marker -> initialized with pending updates.
    expect(status.initialized).toBe(true);
    expect(status.needsApply).toBe(true);

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
