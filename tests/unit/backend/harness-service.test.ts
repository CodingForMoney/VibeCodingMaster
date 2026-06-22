import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { CreateTerminalSessionInput, TerminalRuntime, TerminalSession } from "../../../src/backend/runtime/terminal-runtime.js";
import { createHarnessService } from "../../../src/backend/services/harness-service.js";
import type { RoleSessionRecord, StartRoleSessionRequest } from "../../../src/shared/types/session.js";

describe("createHarnessService", () => {
  it("plans and applies recommended harness files when they are missing", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.needsApply).toBe(true);
    // B1: a fresh repo with every harness file missing is not yet initialized.
    expect(status.initialized).toBe(false);
    expect(status.plannedChanges).toHaveLength(17);
    expect(status.plannedChanges.map((change) => change.action)).toEqual(Array(17).fill("create"));

    const result = await service.applyHarness("/repo");
    expect(result.changedFiles).toHaveLength(17);

    const nextStatus = await service.getHarnessStatus("/repo");
    expect(nextStatus.needsApply).toBe(false);
    // B2: once the harness is applied, VCM markers exist -> initialized.
    expect(nextStatus.initialized).toBe(true);
    expect(nextStatus.files.map((file) => file.action)).toEqual(Array(17).fill("ok"));
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
    expect(await fs.readText("/repo/.claude/skills/vcm-gate-review/SKILL.md")).toContain("name: vcm-gate-review");
    expect(await fs.readText("/repo/.claude/skills/vcm-gate-review/SKILL.md")).toContain(".ai/tools/request-gate-review");
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
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("### Gate Review Gates");
    expect(await fs.readText("/repo/.claude/agents/architect.md")).toContain("verifiable behavior, phase boundaries, behavior/contract proof points");
    expect(await fs.readText("/repo/.claude/agents/architect.md")).toContain("Read `.ai/vcm/handoffs/known-issues.md` and promote confirmed unresolved issues to `docs/known-issues.md`.");
    expect(await fs.readText("/repo/.claude/agents/gate-reviewer.md")).toContain("name: gate-reviewer");
    expect(await fs.readText("/repo/.claude/agents/gate-reviewer.md")).toContain("You are VCM `gate-reviewer`");
    expect(await fs.readText("/repo/.claude/agents/gate-reviewer.md")).toContain("Use the task and worktree paths named there");
    const translatorAgents = await fs.readText("/repo/.claude/agents/translator.md");
    expect(translatorAgents).toContain("name: translator");
    expect(translatorAgents).toContain("You are VCM `translator`");
    expect(translatorAgents).toContain("follow the VCM chunk manifest");
    expect(translatorAgents).toContain("Do not delegate translation to another CLI, package, API, service, browser, or");
    expect(translatorAgents).toContain("write diagnostics to the assigned report path");
    const harnessEngineerAgent = await fs.readText("/repo/.claude/agents/harness-engineer.md");
    expect(harnessEngineerAgent).toContain("name: harness-engineer");
    expect(harnessEngineerAgent).toContain("You are VCM `harness-engineer`");
    expect(harnessEngineerAgent).toContain("Propose harness changes as reviewable diffs");
    expect(harnessEngineerAgent).toContain("CodingForMoney/VibeCodingMaster");
    expect(await fs.readText("/repo/.ai/tools/request-gate-review")).toContain("Request a VCM-managed Gate Review Gate");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("UserPromptSubmit");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("Stop");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("StopFailure");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("PostCompact");
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

  it("plans and removes obsolete Codex harness paths", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/.ai/codex/AGENTS.md", "# old codex reviewer\n");
    await fs.writeText("/repo/.ai/codex-translator/AGENTS.md", "# old codex translator\n");
    await fs.writeText("/repo/.claude/skills/vcm-codex-review-gate/SKILL.md", "# old skill\n");
    await fs.writeText("/repo/.ai/tools/request-codex-review", "#!/usr/bin/env python3\n");
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.plannedChanges.filter((change) => change.action === "delete").map((change) => change.path)).toEqual([
      ".ai/codex",
      ".ai/codex-translator",
      ".claude/skills/vcm-codex-review-gate",
      ".ai/tools/request-codex-review"
    ]);

    const result = await service.applyHarness("/repo");
    expect(result.changedFiles.filter((change) => change.action === "delete").map((change) => change.path)).toEqual([
      ".ai/codex",
      ".ai/codex-translator",
      ".claude/skills/vcm-codex-review-gate",
      ".ai/tools/request-codex-review"
    ]);
    await expect(fs.pathExists("/repo/.ai/codex/AGENTS.md")).resolves.toBe(false);
    await expect(fs.pathExists("/repo/.ai/codex-translator/AGENTS.md")).resolves.toBe(false);
    await expect(fs.pathExists("/repo/.claude/skills/vcm-codex-review-gate/SKILL.md")).resolves.toBe(false);
    await expect(fs.pathExists("/repo/.ai/tools/request-codex-review")).resolves.toBe(false);
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
    expect(JSON.stringify(settings.hooks.StopFailure)).toContain("/api/hooks/claude-code");
    expect(JSON.stringify(settings.hooks.PostCompact)).toContain("/api/hooks/claude-code");
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

  it("lets Harness Studio edit project-owned content outside managed blocks", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });
    await service.applyHarness("/repo");
    expect((await service.getHarnessStatus("/repo")).harnessRevision).toBe(1);

    const file = await service.getHarnessFileContent("/repo", "CLAUDE.md");
    expect(file.editable).toBe(true);

    const result = await service.updateHarnessFileContent(
      "/repo",
      "CLAUDE.md",
      `# Project Harness Notes\n\nKeep generated code small.\n\n${file.content}`
    );

    expect(result.file.content).toContain("Keep generated code small.");
    expect(result.status.harnessRevision).toBe(2);
    expect(result.status.needsApply).toBe(false);
    await expect(fs.readText("/repo/CLAUDE.md")).resolves.toContain("Keep generated code small.");
  });

  it("protects VCM-owned harness content from Harness Studio edits", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });
    await service.applyHarness("/repo");

    const claudeFile = await service.getHarnessFileContent("/repo", "CLAUDE.md");
    await expect(service.updateHarnessFileContent(
      "/repo",
      "CLAUDE.md",
      claudeFile.content.replace("## VCM Start Here", "## Changed")
    )).rejects.toMatchObject({
      code: "HARNESS_MANAGED_BLOCK_PROTECTED"
    });

    const skillFile = await service.getHarnessFileContent("/repo", ".claude/skills/vcm-route-message/SKILL.md");
    expect(skillFile.editable).toBe(false);
    await expect(service.updateHarnessFileContent(
      "/repo",
      ".claude/skills/vcm-route-message/SKILL.md",
      `${skillFile.content}\nExtra line.\n`
    )).rejects.toMatchObject({
      code: "HARNESS_FILE_READONLY"
    });
  });

  it("commits provided harness files and rebases the task worktree onto the new base commit", async () => {
    const fs = createMemoryFs();
    const calls: string[] = [];
    const service = createHarnessService({
      fs,
      git: {
        async getCurrentBranch(repoRoot) {
          calls.push(`branch:${repoRoot}`);
          return repoRoot.endsWith("/demo") ? "feature/demo" : "main";
        },
        async getHeadCommit(repoRoot) {
          calls.push(`head:${repoRoot}`);
          return calls.filter((call) => call === "head:/repo").length > 1 ? "base2222222" : "base1111111";
        },
        async getStatusPorcelain(repoRoot) {
          calls.push(`status:${repoRoot}`);
          return "";
        },
        async getStagedStatus(repoRoot) {
          calls.push(`staged:${repoRoot}`);
          return calls.filter((call) => call === "staged:/repo").length > 1 ? "M\tCLAUDE.md\n" : "";
        },
        async addPaths(repoRoot, paths) {
          calls.push(`add:${repoRoot}:${paths.join(",")}`);
        },
        async commit(repoRoot, message) {
          calls.push(`commit:${repoRoot}:${message}`);
          return "base2222222";
        },
        async rebase(repoRoot, upstream) {
          calls.push(`rebase:${repoRoot}:${upstream}`);
          return { stdout: "", stderr: "" };
        }
      }
    });

    const result = await service.commitAndRebaseTask("/repo", {
      taskSlug: "demo",
      branch: "feature/demo",
      worktreePath: "/repo/.claude/worktrees/demo",
      changedFiles: [
        { path: "CLAUDE.md", action: "update", reason: "updated" },
        { path: "./CLAUDE.md", action: "update", reason: "duplicate" },
        { path: ".claude/settings.json", action: "update", reason: "updated" }
      ]
    });

    expect(result).toMatchObject({
      taskSlug: "demo",
      branch: "feature/demo",
      baseBranch: "main",
      baseCommitBefore: "base1111111",
      baseCommitAfter: "base2222222",
      harnessCommit: "base2222222",
      committed: true,
      rebased: true
    });
    expect(result.changedFiles.map((change) => change.path)).toEqual(["CLAUDE.md", ".claude/settings.json"]);
    expect(calls).toEqual([
      "branch:/repo/.claude/worktrees/demo",
      "status:/repo/.claude/worktrees/demo",
      "staged:/repo",
      "branch:/repo",
      "head:/repo",
      "add:/repo:CLAUDE.md,.claude/settings.json",
      "staged:/repo",
      "commit:/repo:chore: update VCM harness",
      "head:/repo",
      "rebase:/repo/.claude/worktrees/demo:base2222222"
    ]);
  });

  it("refuses to commit and rebase when the task worktree is dirty", async () => {
    const service = createHarnessService({
      fs: createMemoryFs(),
      git: {
        async getCurrentBranch() {
          return "feature/demo";
        },
        async getHeadCommit() {
          return "base1111111";
        },
        async getStatusPorcelain() {
          return "M src/app.ts\n";
        },
        async getStagedStatus() {
          return "";
        },
        async addPaths() {},
        async commit() {
          return "base2222222";
        },
        async rebase() {
          return { stdout: "", stderr: "" };
        }
      }
    });

    await expect(service.commitAndRebaseTask("/repo", {
      taskSlug: "demo",
      branch: "feature/demo",
      worktreePath: "/repo/.claude/worktrees/demo",
      changedFiles: [{ path: "CLAUDE.md", action: "update", reason: "updated" }]
    })).rejects.toMatchObject({
      code: "HARNESS_TASK_DIRTY"
    });
  });

  it("uses the project harness-engineer session for bootstrap", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const runtime = createFakeRuntime(runtimeInputs, writes);
    const ensureRequests: StartRoleSessionRequest[] = [];
    const service = createHarnessService({
      fs,
      runtime,
      harnessEngineerSessions: createFakeHarnessEngineerSessions(runtime, ensureRequests)
    });
    await service.applyHarness("/repo");
    await fs.writeText("/repo/.ai/vcm-harness-manifest.json", "{}\n");
    await fs.writeText("/repo/.ai/tools/generate-module-index", "#!/usr/bin/env python3\n");
    await fs.writeText("/repo/.ai/tools/generate-public-surface", "#!/usr/bin/env python3\n");

    const started = await service.startHarnessBootstrap("/repo", {
      permissionMode: "bypassPermissions",
      model: "claude-opus-4-8[1m]",
      effort: "high"
    });

    expect(started.session.status).toBe("running");
    expect(started.session.permissionMode).toBe("bypassPermissions");
    expect(started.session.model).toBe("claude-opus-4-8[1m]");
    expect(started.session.effort).toBe("high");
    expect(ensureRequests[0]).toMatchObject({
      permissionMode: "bypassPermissions",
      model: "claude-opus-4-8[1m]",
      effort: "high"
    });
    expect(runtimeInputs[0]).toMatchObject({
      taskSlug: "__project_harness_engineer__",
      role: "harness-engineer",
      cwd: "/repo"
    });
    expect(writes).toEqual([]);

    const run = await service.runHarnessBootstrap("/repo");
    expect(run.prompt).toContain("Use the vcm-harness-bootstrap skill");
    expect(writes[0]).toContain("Use the vcm-harness-bootstrap skill");
    expect(writes[1]).toBe("\r");

    const runningStatus = await service.getBootstrapStatus("/repo");
    expect(runningStatus.status).toBe("running");

    await service.recordHarnessBootstrapHook("/repo", {
      eventName: "Stop",
      sessionId: started.session.id,
      claudeSessionId: started.session.claudeSessionId
    });
    const completedStatus = await service.getBootstrapStatus("/repo");
    expect(completedStatus.status).toBe("complete");
  });

  it("ignores stale legacy bootstrap terminal session records", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });
    await service.applyHarness("/repo");
    await fs.writeText("/repo/.ai/vcm-harness-manifest.json", "{}\n");
    await fs.writeText("/repo/.ai/tools/generate-module-index", "#!/usr/bin/env python3\n");
    await fs.writeText("/repo/.ai/tools/generate-public-surface", "#!/usr/bin/env python3\n");
    await fs.writeJson("/repo/.ai/vcm/bootstrap/session.json", {
      id: "legacy-bootstrap",
      claudeSessionId: "legacy-claude-session",
      status: "running",
      command: "claude --session-id legacy-claude-session",
      cwd: "/repo",
      logPath: ".ai/vcm/bootstrap/bootstrap.log",
      updatedAt: "2026-06-22T00:00:00.000Z"
    });

    const status = await service.getBootstrapStatus("/repo");

    expect(status.status).not.toBe("running");
    expect(status.session).toBeUndefined();
  });
});

function createFakeHarnessEngineerSessions(
  runtime: TerminalRuntime,
  ensureRequests: StartRoleSessionRequest[]
) {
  let record: RoleSessionRecord | undefined;
  async function createRecord(input: StartRoleSessionRequest = {}): Promise<RoleSessionRecord> {
    ensureRequests.push(input);
    const runtimeSession = await runtime.createSession({
      taskSlug: "__project_harness_engineer__",
      role: "harness-engineer",
      command: "claude",
      args: ["--agent", "harness-engineer"],
      cwd: "/repo",
      cols: input.cols,
      rows: input.rows
    });
    record = {
      id: runtimeSession.id,
      claudeSessionId: "claude-harness-engineer",
      taskSlug: "__project_harness_engineer__",
      role: "harness-engineer",
      status: runtimeSession.status,
      activityStatus: "idle",
      command: "claude --agent harness-engineer",
      permissionMode: input.permissionMode ?? "default",
      model: input.model,
      effort: input.effort,
      cwd: "/repo",
      terminalBackend: "node-pty",
      startedAt: runtimeSession.startedAt,
      updatedAt: "2026-06-22T00:00:00.000Z",
      lastOutputAt: runtimeSession.lastOutputAt,
      exitCode: runtimeSession.exitCode
    };
    return record;
  }

  return {
    ensureProjectHarnessEngineerSession: async (_repoRoot: string, input: StartRoleSessionRequest = {}) => {
      if (record?.status === "running") {
        return record;
      }
      return createRecord(input);
    },
    restartProjectHarnessEngineerSession: async (_repoRoot: string, input: StartRoleSessionRequest = {}) => createRecord(input),
    stopProjectHarnessEngineerSession: async () => {
      if (!record) {
        throw new Error("missing harness engineer session");
      }
      await runtime.stop(record.id);
      record = {
        ...record,
        status: "exited",
        updatedAt: "2026-06-22T00:00:01.000Z",
        exitCode: 0
      };
      return record;
    },
    getProjectHarnessEngineerSession: async () => record
  };
}

function createFakeRuntime(inputs: CreateTerminalSessionInput[], writes: string[]): TerminalRuntime {
  const sessions = new Map<string, TerminalSession>();
  return {
    async createSession(input) {
      inputs.push(input);
      const session: TerminalSession = {
        id: `bootstrap_${inputs.length}`,
        taskSlug: input.taskSlug,
        role: input.role,
        status: "running",
        startedAt: "2026-06-22T00:00:00.000Z",
        exitCode: null
      };
      sessions.set(session.id, session);
      return session;
    },
    getSession(sessionId) {
      return sessions.get(sessionId);
    },
    getSessionByRole(taskSlug, role) {
      return [...sessions.values()].find((session) => session.taskSlug === taskSlug && session.role === role);
    },
    listSessions(taskSlug) {
      return [...sessions.values()].filter((session) => !taskSlug || session.taskSlug === taskSlug);
    },
    write(_sessionId, data) {
      writes.push(data);
    },
    resize() {},
    async stop(sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        sessions.set(sessionId, {
          ...session,
          status: "exited",
          exitCode: 0
        });
      }
    },
    async restart(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error("missing session");
      }
      return session;
    },
    subscribe() {
      return () => {};
    }
  };
}

function createMemoryFs(): FileSystemAdapter {
  const files = new Map<string, string>();
  return {
    async pathExists(targetPath) {
      return files.has(targetPath) || Array.from(files.keys()).some((filePath) => filePath.startsWith(`${targetPath}/`));
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
    },
    async removePath(targetPath, options = {}) {
      files.delete(targetPath);
      if (options.recursive) {
        for (const filePath of Array.from(files.keys())) {
          if (filePath.startsWith(`${targetPath}/`)) {
            files.delete(filePath);
          }
        }
      }
    }
  };
}
