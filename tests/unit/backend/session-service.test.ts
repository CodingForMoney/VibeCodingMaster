import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../../src/shared/types/project.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import {
  CLAUDE_EFFORT_OPTIONS,
  type ClaudeModel,
  type SessionEffort
} from "../../../src/shared/types/session.js";
import type { CreateTerminalSessionInput, TerminalRuntime, TerminalSession } from "../../../src/backend/runtime/terminal-runtime.js";
import { createSessionRegistry } from "../../../src/backend/runtime/session-registry.js";
import { createSessionService } from "../../../src/backend/services/session-service.js";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";

const TASK_WORKTREE = "/repo/.claude/worktrees/demo-task";

describe("createSessionService", () => {
  it("keeps Max effort in Claude Code options", () => {
    expect(CLAUDE_EFFORT_OPTIONS.map((option) => option.value)).toContain("max");
  });

  it("persists Claude session ids and resumes them after registry loss", async () => {
    const fs = createMemoryFs();
    const firstRuntimeInputs: CreateTerminalSessionInput[] = [];
    const firstService = createTestSessionService(fs, firstRuntimeInputs);

    const started = await firstService.startRoleSession("/repo", "demo-task", "architect", {
      permissionMode: "default"
    });
    expect(started.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.transcriptPath).toMatch(/\.claude\/projects\/-repo-\.claude-worktrees-demo-task\/[0-9a-f-]{36}\.jsonl$/);
    expect(started.command).toContain("--session-id");
    expect(firstRuntimeInputs[0]?.args).toContain("--session-id");

    const secondRuntimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, secondRuntimeInputs);
    const recovered = await secondService.listRoleSessions("/repo", "demo-task");
    expect(recovered).toMatchObject([
      {
        role: "architect",
        status: "resumable",
        claudeSessionId: started.claudeSessionId,
        transcriptPath: started.transcriptPath
      }
    ]);

    const resumed = await secondService.resumeRoleSession("/repo", "demo-task", "architect");
    expect(resumed.claudeSessionId).toBe(started.claudeSessionId);
    expect(resumed.transcriptPath).toBe(started.transcriptPath);
    expect(secondRuntimeInputs[0]?.args).toEqual([
      "--agent",
      "architect",
      "--resume",
      started.claudeSessionId,
      "--model",
      "default"
    ]);
  });

  it("starts project-manager sessions with VCM environment instead of pasted context", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const service = createTestSessionService(fs, runtimeInputs, writes);

    await service.startRoleSession("/repo", "demo-task", "project-manager");

    expect(writes).toHaveLength(0);
    expect(runtimeInputs[0]?.env).toMatchObject({
      VCM_API_URL: "http://127.0.0.1:4173",
      VCM_TASK_REPO_ROOT: TASK_WORKTREE,
      VCM_TASK_SLUG: "demo-task",
      VCM_ROLE: "project-manager",
      VCM_SESSION_ID: expect.any(String)
    });
  });

  it("starts role sessions with the selected Claude model", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startRoleSession("/repo", "demo-task", "coder", {
      model: "claude-opus-4-8[1m]"
    });

    expect(started.model).toBe("claude-opus-4-8[1m]");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "coder",
      "--session-id",
      started.claudeSessionId,
      "--model",
      "claude-opus-4-8[1m]"
    ]);
  });

  it("starts role sessions with the selected Claude effort", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startRoleSession("/repo", "demo-task", "architect", {
      effort: "high"
    });

    expect(started.effort).toBe("high");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "architect",
      "--session-id",
      started.claudeSessionId,
      "--model",
      "default",
      "--effort",
      "high"
    ]);
  });

  it("starts Gate Reviewer as a project-scoped Claude Code session", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs, [], {
      worktreePath: TASK_WORKTREE
    });

    const started = await service.startRoleSession("/repo", "demo-task", "gate-reviewer", {
      permissionMode: "bypassPermissions",
      model: "claude-opus-4-8[1m]",
      effort: "high"
    });

    expect(started.role).toBe("gate-reviewer");
    expect(started.taskSlug).toBe("demo-task");
    expect(started.model).toBe("claude-opus-4-8[1m]");
    expect(started.effort).toBe("high");
    expect(started.transcriptPath).toMatch(/\.claude\/projects\/-repo\/[0-9a-f-]{36}\.jsonl$/);
    expect(runtimeInputs[0]?.command).toBe("claude");
    expect(runtimeInputs[0]?.cwd).toBe("/repo");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "gate-reviewer",
      "--session-id",
      started.claudeSessionId,
      "--model",
      "claude-opus-4-8[1m]",
      "--effort",
      "high",
      "--permission-mode",
      "bypassPermissions"
    ]);
    expect(runtimeInputs[0]?.env).toMatchObject({
      VCM_TASK_REPO_ROOT: TASK_WORKTREE,
      VCM_TASK_SLUG: "demo-task",
      VCM_ROLE: "gate-reviewer"
    });
    expect(started.activeTaskSlug).toBe("demo-task");
    expect(started.activeTaskRepoRoot).toBe(TASK_WORKTREE);
    await expect(fs.pathExists("/repo/.ai/vcm/gate-reviewer/session.json")).resolves.toBe(true);
    await expect(fs.pathExists(`${TASK_WORKTREE}/.ai/vcm/sessions/demo-task.json`)).resolves.toBe(false);
  });

  it("resumes Gate Reviewer across tasks with the same project session", async () => {
    const fs = createMemoryFs();
    const firstRuntimeInputs: CreateTerminalSessionInput[] = [];
    const firstService = createTestSessionService(fs, firstRuntimeInputs);

    const started = await firstService.startRoleSession("/repo", "demo-task", "gate-reviewer");

    const secondRuntimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, secondRuntimeInputs);
    const recovered = await secondService.getRoleSession("/repo", "another-task", "gate-reviewer");
    expect(recovered).toMatchObject({
      role: "gate-reviewer",
      taskSlug: "another-task",
      status: "resumable",
      claudeSessionId: started.claudeSessionId
    });

    const resumed = await secondService.resumeRoleSession("/repo", "another-task", "gate-reviewer");
    expect(resumed.claudeSessionId).toBe(started.claudeSessionId);
    expect(resumed.taskSlug).toBe("another-task");
    expect(secondRuntimeInputs[0]?.cwd).toBe("/repo");
    expect(secondRuntimeInputs[0]?.args).toEqual([
      "--agent",
      "gate-reviewer",
      "--resume",
      started.claudeSessionId,
      "--model",
      "default"
    ]);
  });

  it("persists Translator sessions under project translation runtime state", async () => {
    const fs = createMemoryFs();
    const firstRuntimeInputs: CreateTerminalSessionInput[] = [];
    const firstService = createTestSessionService(fs, firstRuntimeInputs, [], {
      worktreePath: TASK_WORKTREE
    });

    const started = await firstService.startProjectTranslatorSession("/repo", {
      model: "default",
      effort: "xhigh"
    });

    expect(started.taskSlug).toBe("__project__");
    expect(firstRuntimeInputs[0]?.cwd).toBe("/repo");
    expect(firstRuntimeInputs[0]?.env).toMatchObject({
      VCM_TASK_REPO_ROOT: "/repo",
      VCM_TASK_SLUG: "__project__",
      VCM_ROLE: "translator"
    });
    expect(firstRuntimeInputs[0]?.logPath).toBeUndefined();
    await expect(fs.pathExists("/repo/.ai/vcm/translations/session.json")).resolves.toBe(true);
    await expect(fs.pathExists("/repo/.claude/worktrees/demo-task/.ai/vcm/sessions/demo-task.json"))
      .resolves.toBe(false);

    const hooked = await firstService.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-real-session",
      transcriptPath: "/repo/.claude/projects/-repo/translator-real-session.jsonl",
      cwd: "/repo"
    });
    expect(hooked?.claudeSessionId).toBe("translator-real-session");

    const secondRuntimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, secondRuntimeInputs);
    const recovered = await secondService.getProjectTranslatorSession("/repo");
    expect(recovered).toMatchObject({
      role: "translator",
      taskSlug: "__project__",
      status: "resumable",
      claudeSessionId: "translator-real-session"
    });
    const resumed = await secondService.resumeProjectTranslatorSession("/repo");
    expect(resumed.claudeSessionId).toBe("translator-real-session");
    expect(secondRuntimeInputs[0]?.args).toEqual([
      "--agent",
      "translator",
      "--resume",
      "translator-real-session",
      "--model",
      "default",
      "--effort",
      "xhigh"
    ]);
  });

  it("starts Translator as a project-scoped Claude Code session", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startProjectTranslatorSession("/repo", {
      model: "default",
      effort: "medium"
    });

    expect(started.command).toContain("--agent translator");
    expect(runtimeInputs[0]?.cwd).toBe("/repo");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "translator",
      "--session-id",
      started.claudeSessionId,
      "--model",
      "default",
      "--effort",
      "medium"
    ]);
    expect(runtimeInputs[0]?.args).not.toContain("--sandbox");
  });

  it("resumes Translator with selected permission, model, and effort from ensure", async () => {
    const fs = createMemoryFs();
    const firstService = createTestSessionService(fs, []);
    const started = await firstService.startProjectTranslatorSession("/repo");

    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, runtimeInputs);
    const resumed = await secondService.ensureProjectTranslatorSession("/repo", {
      permissionMode: "bypassPermissions",
      model: "claude-opus-4-8[1m]",
      effort: "high"
    });

    expect(resumed.claudeSessionId).toBe(started.claudeSessionId);
    expect(resumed.permissionMode).toBe("bypassPermissions");
    expect(resumed.model).toBe("claude-opus-4-8[1m]");
    expect(resumed.effort).toBe("high");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "translator",
      "--resume",
      started.claudeSessionId,
      "--model",
      "claude-opus-4-8[1m]",
      "--effort",
      "high",
      "--permission-mode",
      "bypassPermissions"
    ]);
  });

  it("passes Gate Reviewer effort through Claude Code settings", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startRoleSession("/repo", "demo-task", "gate-reviewer", {
      model: "claude-sonnet-4-6[1m]",
      effort: "max"
    });

    expect(started.effort).toBe("max");
    expect(runtimeInputs[0]?.args).toContain("--agent");
    expect(runtimeInputs[0]?.args).toContain("gate-reviewer");
    expect(runtimeInputs[0]?.args).toContain("--effort");
    expect(runtimeInputs[0]?.args).toContain("max");
  });

  it("starts Claude Code sessions with ultracode settings", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startRoleSession("/repo", "demo-task", "architect", {
      model: "fable",
      effort: "ultracode"
    });

    expect(started.effort).toBe("ultracode");
    expect(runtimeInputs[0]?.args).toContain("--settings");
    expect(runtimeInputs[0]?.args).toContain("{\"ultracode\":true}");
    expect(runtimeInputs[0]?.args).not.toContain("--effort");
  });

  it("starts role sessions inside the task worktree when one exists", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs, [], {
      worktreePath: "/repo/.claude/worktrees/demo-task"
    });

    const started = await service.startRoleSession("/repo", "demo-task", "architect");

    expect(started.cwd).toBe("/repo/.claude/worktrees/demo-task");
    expect(started.transcriptPath).toContain("-repo-.claude-worktrees-demo-task");
    expect(runtimeInputs[0]?.cwd).toBe("/repo/.claude/worktrees/demo-task");
    expect(runtimeInputs[0]?.env).toMatchObject({
      VCM_TASK_REPO_ROOT: "/repo/.claude/worktrees/demo-task"
    });
    expect(runtimeInputs[0]?.logPath).toBeUndefined();
    await expect(fs.pathExists("/repo/.claude/worktrees/demo-task/.ai/vcm/sessions/demo-task.json"))
      .resolves.toBe(true);
    await expect(fs.pathExists("/repo/.ai/vcm/sessions/demo-task.json"))
      .resolves.toBe(false);

    const recoveredService = createTestSessionService(fs, [], [], {
      worktreePath: "/repo/.claude/worktrees/demo-task"
    });
    await expect(recoveredService.listRoleSessions("/repo", "demo-task")).resolves.toMatchObject([{
      role: "architect",
      status: "resumable",
      claudeSessionId: started.claudeSessionId
    }]);
  });


  it("restarts with a fresh Claude session instead of resuming the persisted one", async () => {
    const fs = createMemoryFs();
    const firstRuntimeInputs: CreateTerminalSessionInput[] = [];
    const firstService = createTestSessionService(fs, firstRuntimeInputs);

    const started = await firstService.startRoleSession("/repo", "demo-task", "coder");
    expect(firstRuntimeInputs[0]?.args).toContain("--session-id");

    const secondRuntimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, secondRuntimeInputs);
    const restarted = await secondService.restartRoleSession("/repo", "demo-task", "coder");

    expect(restarted.claudeSessionId).not.toBe(started.claudeSessionId);
    expect(restarted.transcriptPath).not.toBe(started.transcriptPath);
    expect(secondRuntimeInputs[0]?.args).toEqual([
      "--agent",
      "coder",
      "--session-id",
      restarted.claudeSessionId,
      "--model",
      "default"
    ]);
    expect(secondRuntimeInputs[0]?.args).not.toContain("--resume");
  });

  it("normalizes legacy dangerously skip permission records to bypassPermissions", async () => {
    const fs = createMemoryFs();
    await fs.writeJson(`${TASK_WORKTREE}/.ai/vcm/sessions/demo-task.json`, {
      version: 1,
      taskSlug: "demo-task",
      updatedAt: "2026-05-29T00:00:00.000Z",
      roles: {
        "project-manager": { id: null, status: "not_started" },
        architect: { id: null, status: "not_started" },
        coder: {
          id: "runtime_legacy",
          claudeSessionId: "00000000-0000-4000-8000-000000000004",
          status: "running",
          record: {
            id: "runtime_legacy",
            claudeSessionId: "00000000-0000-4000-8000-000000000004",
            taskSlug: "demo-task",
            role: "coder",
            status: "running",
            activityStatus: "idle",
            command: "claude --agent coder --dangerously-skip-permissions",
            permissionMode: "dangerously-skip-permissions",
            cwd: TASK_WORKTREE,
            terminalBackend: "node-pty",
            updatedAt: "2026-05-29T00:00:00.000Z"
          }
        },
        reviewer: { id: null, status: "not_started" }
      }
    });
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const recovered = await service.getRoleSession("/repo", "demo-task", "coder");
    expect(recovered?.permissionMode).toBe("bypassPermissions");

    await service.resumeRoleSession("/repo", "demo-task", "coder");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "coder",
      "--resume",
      "00000000-0000-4000-8000-000000000004",
      "--model",
      "default",
      "--permission-mode",
      "bypassPermissions"
    ]);
  });

  it("records Claude hook activity separately from terminal process status", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);
    const started = await service.startRoleSession("/repo", "demo-task", "coder");

    expect(started).toMatchObject({
      status: "running",
      activityStatus: "idle"
    });

    const running = await service.markRoleActivityRunning("/repo", "demo-task", "coder");
    expect(running).toMatchObject({
      status: "running",
      activityStatus: "running",
      lastTurnStartedAt: "2026-05-29T00:00:00.000Z"
    });

    const manuallyIdle = await service.markRoleActivityIdle("/repo", "demo-task", "coder");
    expect(manuallyIdle).toMatchObject({
      status: "running",
      activityStatus: "idle",
      lastTurnEndedAt: "2026-05-29T00:00:00.000Z"
    });

    await service.markRoleActivityRunning("/repo", "demo-task", "coder");
    const idle = await service.recordClaudeHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "Stop",
      claudeSessionId: started.claudeSessionId
    });
    expect(idle).toMatchObject({
      status: "running",
      activityStatus: "idle",
      lastTurnEndedAt: "2026-05-29T00:00:00.000Z"
    });

    await service.markRoleActivityRunning("/repo", "demo-task", "coder");
    const failed = await service.recordClaudeHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "StopFailure",
      claudeSessionId: started.claudeSessionId
    });
    expect(failed).toMatchObject({
      status: "running",
      activityStatus: "idle",
      lastTurnEndedAt: "2026-05-29T00:00:00.000Z"
    });

    await service.markRoleActivityRunning("/repo", "demo-task", "coder");
    const compacted = await service.recordClaudeHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "PostCompact",
      claudeSessionId: started.claudeSessionId,
      transcriptPath: "/Users/sheldon/.claude/projects/demo/compact.jsonl"
    });
    expect(compacted).toMatchObject({
      status: "running",
      activityStatus: "running",
      transcriptPath: "/Users/sheldon/.claude/projects/demo/compact.jsonl",
      lastCompactAt: "2026-05-29T00:00:00.000Z"
    });
  });

  it("records Gate Reviewer hook activity on the project-scoped session", async () => {
    const fs = createMemoryFs();
    const service = createTestSessionService(fs, []);
    const started = await service.startRoleSession("/repo", "demo-task", "gate-reviewer");

    expect(started.claudeSessionId).not.toBe("claude_session_123");

    const running = await service.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "UserPromptSubmit",
      sessionId: "claude_session_123",
      transcriptPath: "/Users/sheldon/.claude/projects/-repo/claude_session_123.jsonl",
      cwd: "/repo",
      allowSessionMismatch: true
    });
    expect(running).toMatchObject({
      role: "gate-reviewer",
      taskSlug: "demo-task",
      claudeSessionId: "claude_session_123",
      transcriptPath: "/Users/sheldon/.claude/projects/-repo/claude_session_123.jsonl",
      cwd: "/repo",
      activityStatus: "running",
      lastTurnStartedAt: "2026-05-29T00:00:00.000Z"
    });

    const idle = await service.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "Stop",
      sessionId: "claude_session_123",
      allowSessionMismatch: true
    });
    expect(idle).toMatchObject({
      activityStatus: "idle",
      lastTurnEndedAt: "2026-05-29T00:00:00.000Z"
    });
  });
});

function createTestSessionService(
  fs: FileSystemAdapter,
  runtimeInputs: CreateTerminalSessionInput[],
  writes: string[] = [],
  options: { sandboxMode?: string; worktreePath?: string } = {}
) {
  const worktreePath = options.worktreePath ?? TASK_WORKTREE;
  return createSessionService({
    fs,
    runtime: createFakeRuntime(runtimeInputs, writes),
    registry: createSessionRegistry(),
    claude: {
      async isAvailable() {
        return true;
      },
      async getVersion() {
        return "2.1.156";
      },
      buildRoleStartCommand(
        role: RoleName,
        command = "claude",
        permissionMode = "default",
        claudeSessionId?: string,
        resume = false,
        model: ClaudeModel = "default",
        effort: SessionEffort = "default"
      ) {
        const args = ["--agent", role];
        if (claudeSessionId) {
          args.push(resume ? "--resume" : "--session-id", claudeSessionId);
        }
        args.push("--model", model);
        if (effort === "ultracode") {
          args.push("--settings", JSON.stringify({ ultracode: true }));
        } else if (effort !== "default") {
          args.push("--effort", effort);
        }
        if (permissionMode === "bypassPermissions") {
          args.push("--permission-mode", "bypassPermissions");
        }
        return { command, args, display: `${command} ${args.join(" ")}` };
      }
    },
    artifactService: {
      getHandoffPaths() {
        return {
          handoffDir: ".ai/vcm/handoffs",
          roleCommandsDir: ".ai/vcm/handoffs/role-commands",
          messagesDir: ".ai/vcm/handoffs/messages",
          roleCommandPaths: {
            architect: ".ai/vcm/handoffs/role-commands/architect.md",
            coder: ".ai/vcm/handoffs/role-commands/coder.md",
            reviewer: ".ai/vcm/handoffs/role-commands/reviewer.md"
          },
          architecturePlanPath: ".ai/vcm/handoffs/architecture-plan.md",
          knownIssuesPath: ".ai/vcm/handoffs/known-issues.md",
          reviewReportPath: ".ai/vcm/handoffs/review-report.md",
          docsSyncReportPath: ".ai/vcm/handoffs/docs-sync-report.md",
          finalAcceptancePath: ".ai/vcm/handoffs/final-acceptance.md"
        };
      }
    } as never,
    projectService: {
      async loadConfig(): Promise<ProjectConfig> {
        return {
          version: 1,
          repoRoot: "/repo",
          defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
          handoffRoot: ".ai/vcm/handoffs",
          stateRoot: ".ai/vcm",
          terminalBackend: "node-pty",
          claudeCommand: "claude"
        };
      }
    },
    taskService: {
      async loadTask() {
        return {
          version: 1,
          taskSlug: "demo-task",
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
          repoRoot: "/repo",
          worktreePath,
          branch: "feature",
          handoffDir: ".ai/vcm/handoffs",
          status: "created"
        };
      },
      async updateTaskStatus() {
        return {
          version: 1,
          taskSlug: "demo-task",
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
          repoRoot: "/repo",
          worktreePath,
          branch: "feature",
          handoffDir: ".ai/vcm/handoffs",
          status: "running"
        };
      }
    } as never,
    apiUrl: "http://127.0.0.1:4173",
    sandboxMode: options.sandboxMode,
    now: () => "2026-05-29T00:00:00.000Z"
  });
}

function createFakeRuntime(inputs: CreateTerminalSessionInput[], writes: string[]): TerminalRuntime {
  const sessions = new Map<string, TerminalSession>();
  return {
    async createSession(input) {
      inputs.push(input);
      const session: TerminalSession = {
        id: `runtime_${inputs.length}`,
        taskSlug: input.taskSlug,
        role: input.role,
        status: "running",
        pid: 123,
        startedAt: "2026-05-29T00:00:00.000Z",
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
    listSessions() {
      return [...sessions.values()];
    },
    write(_sessionId, data) {
      writes.push(data);
    },
    resize() {},
    async stop(sessionId) {
      sessions.delete(sessionId);
    },
    async restart(sessionId) {
      const current = sessions.get(sessionId);
      if (!current) {
        throw new Error("missing");
      }
      return current;
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
    },
    async removePath(targetPath) {
      files.delete(targetPath);
    }
  };
}
