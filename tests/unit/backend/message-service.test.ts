import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { VcmError } from "../../../src/backend/errors.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createMessageService } from "../../../src/backend/services/message-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

describe("createMessageService", () => {
  it("keeps route-file messages pending in manual mode", async () => {
    const harness = createHarness(["coder"]);
    await harness.writeRoute("project-manager-coder.md", "Implement the cleanup task.");

    const results = await harness.service.scanAndDispatchPendingRouteFiles(harness.base);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      delivered: false,
      requiresUserApproval: true,
      clearedRouteFile: false
    });
    expect(results[0].message).toBeUndefined();
    expect(harness.writes).toEqual([]);
    await expect(harness.service.listMessages(harness.base)).resolves.toEqual([]);
    await expect(harness.readRoute("project-manager-coder.md")).resolves.toBe("Implement the cleanup task.");
  });

  it("delivers auto route-file messages and confirms them on UserPromptSubmit", async () => {
    const harness = createHarness(["coder"]);
    await harness.service.updateOrchestrationState({
      ...harness.base,
      mode: "auto"
    });
    await harness.writeRoute("project-manager-coder.md", [
      "---",
      "type: question",
      "artifact_refs: .ai/vcm/handoffs/architecture-plan.md",
      "---",
      "Can this implementation start?"
    ].join("\n"));

    const results = await harness.service.scanAndDispatchPendingRouteFiles({
      ...harness.base,
      stoppedRole: "project-manager"
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      delivered: true,
      requiresUserApproval: false,
      clearedRouteFile: false,
      message: {
        id: "msg_1",
        type: "question",
        artifactRefs: [".ai/vcm/handoffs/architecture-plan.md"],
        routePath: ".ai/vcm/handoffs/messages/project-manager-coder.md",
        dispatchingAt: "2026-05-29T00:00:00.000Z",
        deliveredAt: "2026-05-29T00:00:00.000Z"
      }
    });
    const snapshots = await harness.readMessageSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      id: "msg_1",
      dispatchingAt: "2026-05-29T00:00:00.000Z"
    });
    expect(snapshots[0].deliveredAt).toBeUndefined();
    expect(snapshots[1]).toMatchObject({
      id: "msg_1",
      dispatchingAt: "2026-05-29T00:00:00.000Z",
      deliveredAt: "2026-05-29T00:00:00.000Z"
    });
    expect(harness.writes).toHaveLength(2);
    expect(harness.writes[0]).toContain("[VCM MESSAGE]");
    expect(harness.writes[0]).toContain("Can this implementation start?");
    expect(harness.writes[0]).toMatch(/^\x1b\[200~/);
    expect(harness.writes[0]).toMatch(/\x1b\[201~$/);
    expect(harness.writes[1]).toBe("\r");
    expect(harness.runningMarks).toEqual(["coder"]);
    await expect(harness.readRoute("project-manager-coder.md")).resolves.toContain("Can this implementation start?");

    const submitted = await harness.service.confirmPromptSubmitted({
      ...harness.base,
      role: "coder",
      prompt: harness.writes[0]
    });
    expect(submitted).toMatchObject({
      id: "msg_1",
      acceptedAt: "2026-05-29T00:00:00.000Z"
    });
    await expect(harness.readRoute("project-manager-coder.md")).resolves.toBe("");
    const messages = await harness.service.listMessages(harness.base);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "msg_1",
      dispatchingAt: "2026-05-29T00:00:00.000Z",
      deliveredAt: "2026-05-29T00:00:00.000Z",
      acceptedAt: "2026-05-29T00:00:00.000Z"
    });
  });

  it("keeps same-target route files pending until the active target emits Stop", async () => {
    const harness = createHarness(["coder"]);
    await harness.service.updateOrchestrationState({
      ...harness.base,
      mode: "auto"
    });

    await harness.writeRoute("project-manager-coder.md", "First task.");
    await harness.service.scanAndDispatchPendingRouteFiles({
      ...harness.base,
      stoppedRole: "project-manager"
    });
    await harness.writeRoute("project-manager-coder.md", "Follow-up task.");

    const blocked = await harness.service.scanAndDispatchPendingRouteFiles({
      ...harness.base,
      stoppedRole: "project-manager"
    });

    expect(blocked[0]).toMatchObject({
      delivered: false,
      failureReason: "coder is still running."
    });
    expect(blocked[0].message).toBeUndefined();
    expect(harness.writes).toHaveLength(2);
    await expect(harness.readRoute("project-manager-coder.md")).resolves.toBe("Follow-up task.");

    harness.setActivity("coder", "idle");
    const delivered = await harness.service.scanAndDispatchPendingRouteFiles({
      ...harness.base,
      stoppedRole: "coder"
    });

    expect(delivered[0]).toMatchObject({
      delivered: true,
      message: {
        id: "msg_2",
        body: "Follow-up task.",
        deliveredAt: "2026-05-29T00:00:00.000Z"
      }
    });
    const messages = await harness.service.listMessages(harness.base);
    expect(messages.find((message) => message.id === "msg_1")).toBeDefined();
    expect(messages.find((message) => message.id === "msg_2")).toMatchObject({
      deliveredAt: "2026-05-29T00:00:00.000Z"
    });
  });

  it("clears pending route files without mutating message history", async () => {
    const harness = createHarness(["coder"]);
    await harness.writeRoute("project-manager-coder.md", "Manual recovery message.");
    await harness.service.scanAndDispatchPendingRouteFiles(harness.base);

    const marked = await harness.service.markAllDone({
      ...harness.base,
      clearRouteFiles: true
    });

    expect(marked.updatedCount).toBe(1);
    expect(marked.messages).toEqual([]);
    await expect(harness.readRoute("project-manager-coder.md")).resolves.toBe("");
  });

  it("deletes all message history without deleting pending route files", async () => {
    const harness = createHarness(["coder"]);
    await harness.service.updateOrchestrationState({
      ...harness.base,
      mode: "auto"
    });
    await harness.writeRoute("project-manager-coder.md", "History message.");
    await harness.service.scanAndDispatchPendingRouteFiles(harness.base);
    await harness.writeRoute("project-manager-coder.md", "Still pending.");

    const result = await harness.service.deleteMessageHistory(harness.base);

    expect(result.deletedCount).toBe(1);
    expect(result.messages).toEqual([]);
    await expect(harness.service.listMessages(harness.base)).resolves.toEqual([]);
    await expect(harness.readRoute("project-manager-coder.md")).resolves.toBe("Still pending.");
  });

  it("rejects direct non-PM role-to-role route files", async () => {
    const harness = createHarness(["coder", "reviewer"]);
    await harness.writeRoute("coder-reviewer.md", "Can you review this directly?");

    await expect(harness.service.scanAndDispatchPendingRouteFiles(harness.base)).rejects.toMatchObject({
      code: "MESSAGE_POLICY_DENIED"
    } satisfies Partial<VcmError>);
  });
});

function createHarness(runningRoles: RoleName[], options: { taskRepoRoot?: string } = {}) {
  const fs = createMemoryFs();
  const writes: string[] = [];
  const runningMarks: RoleName[] = [];
  const activity = new Map<RoleName, RoleSessionRecord["activityStatus"]>();
  let nextId = 1;
  const service = createMessageService({
    fs,
    runtime: createFakeRuntime(writes),
    sessionService: createFakeSessionService(runningRoles, runningMarks, activity),
    taskService: {
      async loadTask(_repoRoot: string, taskSlug: string): Promise<TaskRecord> {
        return {
          version: 1,
          taskSlug,
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
          repoRoot: "/repo",
          branch: "feature/vcm",
          handoffDir: ".ai/vcm/handoffs",
          status: "running",
          worktreePath: options.taskRepoRoot
        };
      }
    },
    now: () => "2026-05-29T00:00:00.000Z",
    id: () => `msg_${nextId++}`,
    preDispatchSwitchDelayMs: 0
  });
  const taskRepoRoot = options.taskRepoRoot ?? "/repo";

  return {
    fs,
    service,
    writes,
    runningMarks,
    setActivity(role: RoleName, nextActivity: RoleSessionRecord["activityStatus"]) {
      activity.set(role, nextActivity);
    },
    writeRoute(fileName: string, content: string) {
      return fs.writeText(path.posix.join(taskRepoRoot, ".ai/vcm/handoffs/messages", fileName), content);
    },
    readRoute(fileName: string) {
      return fs.readText(path.posix.join(taskRepoRoot, ".ai/vcm/handoffs/messages", fileName));
    },
    async readMessageSnapshots() {
      const raw = await fs.readText(path.posix.join(options.taskRepoRoot ?? "/repo", ".ai/vcm/messages/demo-task.jsonl"));
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    base: {
      repoRoot: "/repo",
      taskRepoRoot: options.taskRepoRoot,
      stateRepoRoot: options.taskRepoRoot,
      stateRoot: ".ai/vcm",
      handoffDir: ".ai/vcm/handoffs",
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

function createFakeSessionService(
  runningRoles: RoleName[],
  runningMarks: RoleName[],
  activity: Map<RoleName, RoleSessionRecord["activityStatus"]>
): SessionService {
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
      return createRoleSession(taskSlug, role, activity.get(role));
    },
    async listRoleSessions() {
      return [];
    },
    async recordClaudeHookEvent() {
      return undefined;
    },
    async markRoleActivityRunning(_repoRoot, _taskSlug, role) {
      runningMarks.push(role);
      activity.set(role, "running");
      return undefined;
    }
  };
}

function createRoleSession(
  taskSlug: string,
  role: RoleName,
  activityStatus: RoleSessionRecord["activityStatus"] = "idle"
): RoleSessionRecord {
  return {
    id: `session_${role}`,
    claudeSessionId: `claude_${role}`,
    taskSlug,
    role,
    status: "running",
    activityStatus,
    command: `claude --agent ${role}`,
    permissionMode: "default",
    cwd: "/repo",
    terminalBackend: "node-pty",
    logPath: `.ai/vcm/handoffs/logs/${role}.log`,
    startedAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    exitCode: null
  };
}

function createMemoryFs(): FileSystemAdapter {
  const files = new Map<string, string>();
  return {
    async pathExists(targetPath) {
      if (files.has(targetPath)) {
        return true;
      }
      const directoryPrefix = `${targetPath.replace(/\/$/, "")}/`;
      return [...files.keys()].some((filePath) => filePath.startsWith(directoryPrefix));
    },
    async ensureDir() {},
    async readDir(targetPath) {
      const directoryPrefix = `${targetPath.replace(/\/$/, "")}/`;
      const entries = new Set<string>();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(directoryPrefix)) {
          continue;
        }
        const rest = filePath.slice(directoryPrefix.length);
        const [entry] = rest.split("/");
        if (entry) {
          entries.add(entry);
        }
      }
      return [...entries];
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
