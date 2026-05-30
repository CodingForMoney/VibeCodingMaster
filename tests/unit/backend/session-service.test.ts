import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../../src/shared/types/project.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { CreateTerminalSessionInput, TerminalRuntime, TerminalSession } from "../../../src/backend/runtime/terminal-runtime.js";
import { createSessionRegistry } from "../../../src/backend/runtime/session-registry.js";
import { createSessionService } from "../../../src/backend/services/session-service.js";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";

describe("createSessionService", () => {
  it("persists Claude session ids and resumes them after registry loss", async () => {
    const fs = createMemoryFs();
    const firstRuntimeInputs: CreateTerminalSessionInput[] = [];
    const firstService = createTestSessionService(fs, firstRuntimeInputs);

    const started = await firstService.startRoleSession("/repo", "demo-task", "architect", {
      permissionMode: "default"
    });
    expect(started.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.command).toContain("--session-id");
    expect(firstRuntimeInputs[0]?.args).toContain("--session-id");

    const secondRuntimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, secondRuntimeInputs);
    const recovered = await secondService.listRoleSessions("/repo", "demo-task");
    expect(recovered).toMatchObject([
      {
        role: "architect",
        status: "resumable",
        claudeSessionId: started.claudeSessionId
      }
    ]);

    const resumed = await secondService.resumeRoleSession("/repo", "demo-task", "architect");
    expect(resumed.claudeSessionId).toBe(started.claudeSessionId);
    expect(secondRuntimeInputs[0]?.args).toEqual([
      "--agent",
      "architect",
      "--resume",
      started.claudeSessionId
    ]);
  });

  it("sends canonical task context to project-manager sessions", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const service = createTestSessionService(fs, runtimeInputs, writes);

    await service.startRoleSession("/repo", "demo-task", "project-manager");

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("Task slug: demo-task");
    expect(writes[0]).toContain("Canonical handoff directory: .ai/handoffs/demo-task");
    expect(writes[0]).toContain("coder: .ai/handoffs/demo-task/role-commands/coder.md");
    expect(writes[0]).toContain("Do not create or write .ai/handoffs/<other-task>/");
  });
});

function createTestSessionService(fs: FileSystemAdapter, runtimeInputs: CreateTerminalSessionInput[], writes: string[] = []) {
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
      buildRoleStartCommand(role: RoleName, command = "claude", permissionMode = "default", claudeSessionId?: string, resume = false) {
        const args = ["--agent", role];
        if (claudeSessionId) {
          args.push(resume ? "--resume" : "--session-id", claudeSessionId);
        }
        if (permissionMode === "bypassPermissions") {
          args.push("--permission-mode", "bypassPermissions");
        } else if (permissionMode === "dangerously-skip-permissions") {
          args.push("--dangerously-skip-permissions");
        }
        return { command, args, display: `${command} ${args.join(" ")}` };
      }
    },
    artifactService: {
      getHandoffPaths() {
        return {
          handoffDir: ".ai/handoffs/demo-task",
          roleCommandsDir: ".ai/handoffs/demo-task/role-commands",
          logsDir: ".ai/handoffs/demo-task/logs",
          roleCommandPaths: {
            architect: ".ai/handoffs/demo-task/role-commands/architect.md",
            coder: ".ai/handoffs/demo-task/role-commands/coder.md",
            reviewer: ".ai/handoffs/demo-task/role-commands/reviewer.md"
          },
          roleLogPaths: {
            "project-manager": ".ai/handoffs/demo-task/logs/project-manager.log",
            architect: ".ai/handoffs/demo-task/logs/architect.log",
            coder: ".ai/handoffs/demo-task/logs/coder.log",
            reviewer: ".ai/handoffs/demo-task/logs/reviewer.log"
          },
          architecturePlanPath: ".ai/handoffs/demo-task/architecture-plan.md",
          implementationLogPath: ".ai/handoffs/demo-task/implementation-log.md",
          validationLogPath: ".ai/handoffs/demo-task/validation-log.md",
          reviewReportPath: ".ai/handoffs/demo-task/review-report.md",
          docsSyncReportPath: ".ai/handoffs/demo-task/docs-sync-report.md"
        };
      }
    } as never,
    projectService: {
      async loadConfig(): Promise<ProjectConfig> {
        return {
          version: 1,
          repoRoot: "/repo",
          defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
          handoffRoot: ".ai/handoffs",
          stateRoot: ".vcm",
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
          branch: "feature",
          handoffDir: ".ai/handoffs/demo-task",
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
          branch: "feature",
          handoffDir: ".ai/handoffs/demo-task",
          status: "running"
        };
      }
    } as never,
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
    }
  };
}
