import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createRuntimeRecoveryService } from "../../../src/backend/services/runtime-recovery-service.js";
import { GATE_REVIEW_GATES, type GateReviewIndex } from "../../../src/shared/types/gate-review.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { TerminalRuntime, TerminalSession } from "../../../src/backend/runtime/terminal-runtime.js";

const TIMESTAMP = "2026-06-27T00:00:00.000Z";

describe("createRuntimeRecoveryService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("recovers stale task sessions, rounds, dispatches, and gate reviews on project connect", async () => {
    const repoRoot = await makeTempRepo(tempDirs);
    const taskRepoRoot = path.join(repoRoot, ".claude/worktrees/demo-task");
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/sessions"), { recursive: true });
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/rounds"), { recursive: true });
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/messages"), { recursive: true });
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/gate-reviews"), { recursive: true });
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/coder-workers/tasks"), { recursive: true });

    await writeJson(path.join(taskRepoRoot, ".ai/vcm/sessions/demo-task.json"), {
      version: 1,
      taskSlug: "demo-task",
      updatedAt: "2026-06-26T00:00:00.000Z",
      roles: {
        coder: {
          id: "runtime_coder",
          claudeSessionId: "claude_coder",
          status: "running",
          record: roleRecord("coder", "demo-task", "runtime_coder", "claude_coder")
        }
      }
    });
    await writeJson(path.join(taskRepoRoot, ".ai/vcm/rounds/demo-task.json"), {
      version: 1,
      taskSlug: "demo-task",
      currentRound: {
        id: "round_1",
        sequence: 1,
        status: "running",
        activeRole: "coder",
        startedAt: "2026-06-26T23:59:00.000Z",
        activeTurnStartedAt: "2026-06-26T23:59:50.000Z",
        ccActiveMs: 0,
        turnCount: 1,
        completedTurnCount: 0,
        roles: ["coder"]
      },
      roleRecovery: {
        role: "coder",
        status: "waiting",
        attempt: 1,
        maxAttempts: 20,
        lastFailureAt: "2026-06-26T23:59:55.000Z"
      },
      totalRoundCount: 1,
      totalTurnCount: 1,
      totalCompletedTurnCount: 0,
      totalCcActiveMs: 0,
      updatedAt: "2026-06-26T23:59:50.000Z"
    });
    await writeFile(path.join(taskRepoRoot, ".ai/vcm/messages/demo-task.jsonl"), `${JSON.stringify({
      id: "msg_1",
      taskSlug: "demo-task",
      fromRole: "project-manager",
      toRole: "coder",
      type: "task",
      body: "Continue",
      artifactRefs: [],
      createdAt: "2026-06-26T23:59:00.000Z",
      dispatchingAt: "2026-06-26T23:59:01.000Z",
      deliveredAt: "2026-06-26T23:59:02.000Z"
    })}\n`, "utf8");
    await writeJson(path.join(taskRepoRoot, ".ai/vcm/gate-reviews/index.json"), gateIndex("architecture-plan", "running"));
    await writeJson(path.join(taskRepoRoot, ".ai/vcm/coder-workers/tasks/worker-1.json"), {
      version: 1,
      workerId: "worker-1",
      status: "running",
      handled: false
    });

    const statusUpdates: string[] = [];
    const service = createService(repoRoot, taskRepoRoot, [], statusUpdates);

    const report = await service.recoverProject(repoRoot);

    expect(report.warnings).toEqual([]);
    const sessionFile = await readJson(path.join(taskRepoRoot, ".ai/vcm/sessions/demo-task.json"));
    expect(sessionFile.roles.coder.status).toBe("resumable");
    expect(sessionFile.roles.coder.record.status).toBe("resumable");
    expect(sessionFile.roles.coder.record.activityStatus).toBe("idle");

    const roundFile = await readJson(path.join(taskRepoRoot, ".ai/vcm/rounds/demo-task.json"));
    expect(roundFile.currentRound).toMatchObject({
      status: "stopped",
      activeRole: "coder",
      stopReason: "runtime-recovery",
      completedTurnCount: 1
    });
    expect(roundFile.currentRound.activeTurnStartedAt).toBeUndefined();
    expect(roundFile.roleRecovery).toBeUndefined();
    expect(roundFile.totalCompletedTurnCount).toBe(1);
    expect(roundFile.totalCcActiveMs).toBe(10000);

    const [message] = (await readFile(path.join(taskRepoRoot, ".ai/vcm/messages/demo-task.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(message.dispatchingAt).toBeUndefined();
    expect(message.deliveredAt).toBeUndefined();
    expect(message.failureReason).toContain("VCM restarted");

    const gate = await readJson(path.join(taskRepoRoot, ".ai/vcm/gate-reviews/index.json"));
    expect(gate.activeGate).toBeNull();
    expect(gate.gates["architecture-plan"].status).toBe("pending");
    expect(gate.gates["architecture-plan"].error).toContain("VCM restarted");
    await expectPathMissing(path.join(taskRepoRoot, ".ai/vcm/coder-workers/tasks/worker-1.json"));
    expect(statusUpdates).toEqual(["demo-task:stopped"]);
  });

  it("does not rewrite running state when the runtime session is still live", async () => {
    const repoRoot = await makeTempRepo(tempDirs);
    const taskRepoRoot = path.join(repoRoot, ".claude/worktrees/demo-task");
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/sessions"), { recursive: true });
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/rounds"), { recursive: true });

    await writeJson(path.join(taskRepoRoot, ".ai/vcm/sessions/demo-task.json"), {
      version: 1,
      taskSlug: "demo-task",
      updatedAt: "2026-06-26T00:00:00.000Z",
      roles: {
        coder: {
          id: "runtime_coder",
          claudeSessionId: "claude_coder",
          status: "running",
          record: roleRecord("coder", "demo-task", "runtime_coder", "claude_coder")
        }
      }
    });
    await writeJson(path.join(taskRepoRoot, ".ai/vcm/rounds/demo-task.json"), {
      version: 1,
      taskSlug: "demo-task",
      currentRound: {
        id: "round_1",
        sequence: 1,
        status: "running",
        activeRole: "coder",
        startedAt: "2026-06-26T23:59:00.000Z",
        activeTurnStartedAt: "2026-06-26T23:59:50.000Z",
        ccActiveMs: 0,
        turnCount: 1,
        completedTurnCount: 0,
        roles: ["coder"]
      },
      totalRoundCount: 1,
      totalTurnCount: 1,
      totalCompletedTurnCount: 0,
      totalCcActiveMs: 0,
      updatedAt: "2026-06-26T23:59:50.000Z"
    });

    const statusUpdates: string[] = [];
    const liveSession = terminalSession("runtime_coder", "demo-task", "coder");
    const service = createService(repoRoot, taskRepoRoot, [liveSession], statusUpdates);

    await service.recoverProject(repoRoot);

    const sessionFile = await readJson(path.join(taskRepoRoot, ".ai/vcm/sessions/demo-task.json"));
    expect(sessionFile.roles.coder.record.status).toBe("running");
    expect(sessionFile.roles.coder.record.activityStatus).toBe("running");
    const roundFile = await readJson(path.join(taskRepoRoot, ".ai/vcm/rounds/demo-task.json"));
    expect(roundFile.currentRound.status).toBe("running");
    expect(roundFile.currentRound.activeTurnStartedAt).toBe("2026-06-26T23:59:50.000Z");
    expect(statusUpdates).toEqual([]);
  });

  it("recovers project tool sessions and clears stale bootstrap/translation runtime", async () => {
    const repoRoot = await makeTempRepo(tempDirs);
    const taskRepoRoot = path.join(repoRoot, ".claude/worktrees/demo-task");
    await mkdir(path.join(repoRoot, ".ai/vcm/translations/runtime"), { recursive: true });
    await mkdir(path.join(repoRoot, ".ai/vcm/translations"), { recursive: true });
    await mkdir(path.join(repoRoot, ".ai/vcm/harness-engineer"), { recursive: true });
    await mkdir(path.join(repoRoot, ".ai/vcm/bootstrap"), { recursive: true });
    await mkdir(path.join(repoRoot, ".ai/vcm/harness-feedback"), { recursive: true });
    await writeFile(path.join(repoRoot, ".ai/vcm/translations/runtime/stale.txt"), "stale", "utf8");
    await writeJson(path.join(repoRoot, ".ai/vcm/translations/session.json"), {
      version: 1,
      role: "translator",
      updatedAt: "2026-06-26T00:00:00.000Z",
      record: roleRecord("translator", "__project__", "runtime_translator", "claude_translator")
    });
    await writeJson(path.join(repoRoot, ".ai/vcm/harness-engineer/session.json"), {
      version: 1,
      role: "harness-engineer",
      updatedAt: "2026-06-26T00:00:00.000Z",
      record: roleRecord("harness-engineer", "__project_harness_engineer__", "runtime_harness", "claude_harness")
    });
    await writeJson(path.join(repoRoot, ".ai/vcm/bootstrap/session.json"), {
      version: 1,
      status: "running",
      updatedAt: "2026-06-26T00:00:00.000Z"
    });
    await writeJson(path.join(repoRoot, ".ai/vcm/harness-feedback/state.json"), {
      version: 1,
      status: "analyzing",
      active: {
        id: "feedback-1",
        analysisPath: ".ai/vcm/harness-feedback/active/feedback-1/analysis.md",
        updatedAt: "2026-06-26T00:00:00.000Z"
      }
    });

    const service = createService(repoRoot, taskRepoRoot, [], []);

    await service.recoverProject(repoRoot);

    await expectPathMissing(path.join(repoRoot, ".ai/vcm/translations/runtime/stale.txt"));
    const translator = await readJson(path.join(repoRoot, ".ai/vcm/translations/session.json"));
    expect(translator.record.status).toBe("resumable");
    expect(translator.record.activityStatus).toBe("idle");
    const harness = await readJson(path.join(repoRoot, ".ai/vcm/harness-engineer/session.json"));
    expect(harness.record.status).toBe("resumable");
    expect(harness.record.activityStatus).toBe("idle");
    await expectPathMissing(path.join(repoRoot, ".ai/vcm/bootstrap/session.json"));
    await expectPathMissing(path.join(repoRoot, ".ai/vcm/harness-feedback/state.json"));
  });

  it("retries resource cleanup for logically closed task tombstones on project connect", async () => {
    const repoRoot = await makeTempRepo(tempDirs);
    const cleanupCalls: string[] = [];
    const service = createRuntimeRecoveryService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime([]),
      projectService: {
        async loadConfig() {
          return {
            version: 1,
            repoRoot,
            defaultRoles: ["project-manager", "architect", "coder", "tester"],
            handoffRoot: ".ai/vcm/handoffs",
            stateRoot: ".ai/vcm",
            terminalBackend: "node-pty",
            claudeCommand: "claude"
          };
        }
      },
      taskService: {
        async listTasks() {
          return [{
            version: 1,
            taskSlug: "closed-task",
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
            repoRoot,
            worktreePath: path.join(repoRoot, ".claude/worktrees/closed-task"),
            branch: "feature/closed-task",
            handoffDir: ".ai/vcm/handoffs",
            status: "stopped",
            cleanupStatus: "cleaned",
            cleanedAt: TIMESTAMP
          }];
        },
        async updateTaskStatus() {
          throw new Error("not used");
        },
        async cleanupTask(_repoRoot, taskSlug) {
          cleanupCalls.push(taskSlug);
          return {
            taskSlug,
            taskClosed: true as const,
            worktreeRemoved: false,
            branchDeleted: false,
            stateRemoved: false,
            removedWorktreePath: null,
            removedStatePaths: [],
            deletedBranch: null,
            cleanedAt: TIMESTAMP,
            warnings: ["branch remains"]
          };
        }
      },
      now: () => TIMESTAMP
    });

    const report = await service.recoverProject(repoRoot);

    expect(cleanupCalls).toEqual(["closed-task"]);
    expect(report.warnings).toContain("closed-task: branch remains");
  });
});

function createService(
  repoRoot: string,
  taskRepoRoot: string,
  sessions: TerminalSession[],
  statusUpdates: string[]
) {
  return createRuntimeRecoveryService({
    fs: createNodeFileSystemAdapter(),
    runtime: createRuntime(sessions),
    projectService: {
      async loadConfig() {
        return {
          version: 1,
          repoRoot,
          defaultRoles: ["project-manager", "architect", "coder", "tester"],
          handoffRoot: ".ai/vcm/handoffs",
          stateRoot: ".ai/vcm",
          terminalBackend: "node-pty",
          claudeCommand: "claude"
        };
      }
    },
    taskService: {
      async listTasks() {
        return [{
          version: 1,
          taskSlug: "demo-task",
          createdAt: "2026-06-26T00:00:00.000Z",
          updatedAt: "2026-06-26T00:00:00.000Z",
          repoRoot,
          worktreePath: taskRepoRoot,
          branch: "feature/demo-task",
          handoffDir: ".ai/vcm/handoffs",
          status: "running",
          cleanupStatus: "active"
        }];
      },
      async updateTaskStatus(_repoRoot, taskSlug, status) {
        statusUpdates.push(`${taskSlug}:${status}`);
        return {} as never;
      },
      async cleanupTask() {
        throw new Error("not used");
      }
    },
    translationWorkerService: {
      async cleanupStartupRuntime(inputRepoRoot) {
        await rm(path.join(inputRepoRoot, ".ai/vcm/translations/runtime"), { recursive: true, force: true });
      }
    },
    now: () => TIMESTAMP
  });
}

function createRuntime(sessions: TerminalSession[]): Pick<TerminalRuntime, "getSession" | "getSessionByRole" | "listSessions"> {
  return {
    getSession(sessionId) {
      return sessions.find((session) => session.id === sessionId);
    },
    getSessionByRole(taskSlug, role) {
      return sessions.find((session) => session.taskSlug === taskSlug && session.role === role);
    },
    listSessions(taskSlug) {
      return sessions.filter((session) => !taskSlug || session.taskSlug === taskSlug);
    }
  };
}

function roleRecord(role: RoleName, taskSlug: string, id: string, claudeSessionId: string) {
  return {
    id,
    claudeSessionId,
    taskSlug,
    role,
    status: "running",
    activityStatus: "running",
    command: "claude",
    permissionMode: "bypassPermissions",
    model: "default",
    effort: "high",
    cwd: "/repo",
    terminalBackend: "node-pty",
    startedAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z"
  };
}

function terminalSession(id: string, taskSlug: string, role: RoleName): TerminalSession {
  return {
    id,
    repoRoot: "/repo",
    taskSlug,
    role,
    status: "running",
    startedAt: "2026-06-26T00:00:00.000Z"
  };
}

function gateIndex(activeGate: GateReviewIndex["activeGate"], activeStatus: "running" | "pending"): GateReviewIndex {
  const gates = Object.fromEntries(GATE_REVIEW_GATES.map((gate) => [
    gate,
    {
      gate,
      required: true,
      status: gate === activeGate ? activeStatus : "pending",
      reportPath: `.ai/vcm/gate-reviews/${gate}-review.md`,
      promptPath: `.ai/vcm/gate-reviews/requests/${gate}.prompt.md`,
      updatedAt: "2026-06-26T00:00:00.000Z"
    }
  ])) as GateReviewIndex["gates"];
  return {
    version: 1,
    enabled: true,
    activeGate,
    gates,
    updatedAt: "2026-06-26T00:00:00.000Z"
  };
}

async function makeTempRepo(tempDirs: string[]): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vcm-runtime-recovery-"));
  tempDirs.push(repoRoot);
  return repoRoot;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}
