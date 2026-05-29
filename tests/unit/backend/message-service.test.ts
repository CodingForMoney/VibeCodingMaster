import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { VcmError } from "../../../src/backend/errors.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createMessageService } from "../../../src/backend/services/message-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";
import type { RoleName } from "../../../src/shared/types/role.js";

describe("createMessageService", () => {
  it("keeps PM-to-role messages pending in manual mode and stages without Enter", async () => {
    const harness = createHarness(["coder"]);

    const result = await harness.service.sendMessage({
      ...harness.base,
      fromRole: "project-manager",
      toRole: "coder",
      type: "task",
      body: "Implement the cleanup task."
    });

    expect(result).toMatchObject({
      delivered: false,
      requiresUserApproval: true,
      message: {
        id: "msg_1",
        status: "pending_approval",
        bodyPath: ".ai/handoffs/demo-task/messages/msg_1.md"
      }
    });
    expect(harness.writes).toEqual([]);

    const staged = await harness.service.stageMessage({
      ...harness.base,
      messageId: result.message.id
    });

    expect(staged.status).toBe("staged");
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toContain("Read and handle VCM message msg_1");
    expect(harness.writes[0]).not.toMatch(/^\r?\n/);
    expect(harness.writes[0]).not.toMatch(/\r$/);
    await expect(harness.fs.readText("/repo/.ai/handoffs/demo-task/messages/msg_1.md"))
      .resolves.toContain("Implement the cleanup task.");
  });

  it("delivers PM-to-role messages immediately in auto mode", async () => {
    const harness = createHarness(["coder"]);
    await harness.service.updateOrchestrationState({
      ...harness.base,
      mode: "auto"
    });

    const result = await harness.service.sendMessage({
      ...harness.base,
      fromRole: "project-manager",
      toRole: "coder",
      type: "task",
      body: "Run the implementation plan."
    });

    expect(result).toMatchObject({
      delivered: true,
      requiresUserApproval: false,
      message: {
        status: "delivered",
        deliveredAt: "2026-05-29T00:00:00.000Z"
      }
    });
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toContain("[VCM MESSAGE]");
    expect(harness.writes[0]).toContain("Run the implementation plan.");
    expect(harness.writes[0]).toMatch(/\r$/);
  });

  it("rejects non-PM role-to-role messages", async () => {
    const harness = createHarness(["coder", "reviewer"]);

    await expect(harness.service.sendMessage({
      ...harness.base,
      fromRole: "coder",
      toRole: "reviewer",
      type: "question",
      body: "Can you review this directly?"
    })).rejects.toMatchObject({
      code: "MESSAGE_POLICY_DENIED"
    } satisfies Partial<VcmError>);
  });
});

function createHarness(runningRoles: RoleName[]) {
  const fs = createMemoryFs();
  const writes: string[] = [];
  let nextId = 1;
  const service = createMessageService({
    fs,
    runtime: createFakeRuntime(writes),
    sessionService: createFakeSessionService(runningRoles),
    taskService: {
      async loadTask(_repoRoot: string, taskSlug: string): Promise<TaskRecord> {
        return {
          version: 1,
          taskSlug,
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
          repoRoot: "/repo",
          branch: "feature/vcm",
          handoffDir: ".ai/handoffs/demo-task",
          status: "running"
        };
      }
    },
    now: () => "2026-05-29T00:00:00.000Z",
    id: () => `msg_${nextId++}`
  });

  return {
    fs,
    service,
    writes,
    base: {
      repoRoot: "/repo",
      stateRoot: ".vcm",
      handoffDir: ".ai/handoffs/demo-task",
      taskSlug: "demo-task"
    }
  };
}

function createFakeRuntime(writes: string[]): TerminalRuntime {
  return {
    async createSession() {
      throw new Error("not implemented");
    },
    getSession() {
      return undefined;
    },
    getSessionByRole() {
      return undefined;
    },
    listSessions() {
      return [];
    },
    write(_sessionId, data) {
      writes.push(data);
    },
    resize() {},
    async stop() {},
    async restart() {
      throw new Error("not implemented");
    },
    subscribe() {
      return () => {};
    }
  };
}

function createFakeSessionService(runningRoles: RoleName[]): SessionService {
  return {
    async startRoleSession() {
      throw new Error("not implemented");
    },
    async resumeRoleSession() {
      throw new Error("not implemented");
    },
    async stopRoleSession() {
      throw new Error("not implemented");
    },
    async restartRoleSession() {
      throw new Error("not implemented");
    },
    async getRoleSession(_repoRoot, taskSlug, role) {
      if (!runningRoles.includes(role)) {
        return undefined;
      }
      return {
        id: `session_${role}`,
        claudeSessionId: `claude_${role}`,
        taskSlug,
        role,
        status: "running",
        command: `claude --agent ${role}`,
        permissionMode: "default",
        cwd: "/repo",
        terminalBackend: "node-pty",
        logPath: `.ai/handoffs/demo-task/logs/${role}.log`,
        startedAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:00.000Z",
        exitCode: null
      };
    },
    async listRoleSessions() {
      return [];
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
