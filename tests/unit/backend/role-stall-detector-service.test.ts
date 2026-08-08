import { describe, expect, it } from "vitest";
import {
  createRoleStallDetectorService,
  type RoleStallDetectorServiceDeps
} from "../../../src/backend/services/role-stall-detector-service.js";
import type { VcmSessionRoundState } from "../../../src/shared/types/round.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

const NOW = "2026-08-08T12:00:00.000Z";

describe("createRoleStallDetectorService", () => {
  it("reports a model stall without changing the role or Round", async () => {
    const harness = createHarness();
    await harness.record("UserPromptSubmit");
    await harness.runTimers();

    expect(harness.service.getWarning("/repo", "task")).toMatchObject({
      role: "coder",
      phase: "awaiting-model",
      roundId: "round-1"
    });
    expect(harness.calls).toEqual([]);
  });

  it("clears a warning when a newer progress hook arrives", async () => {
    const harness = createHarness();
    await harness.record("UserPromptSubmit");
    await harness.runTimers();
    expect(harness.service.getWarning("/repo", "task")).not.toBeNull();

    await harness.record("PreToolUse", {
      tool_name: "Read",
      tool_use_id: "read-1"
    });
    expect(harness.service.getWarning("/repo", "task")).toBeNull();
  });

  it("tracks a tool call from PreToolUse instead of reading the transcript", async () => {
    const harness = createHarness();
    await harness.record("PreToolUse", {
      tool_name: "LSP",
      tool_use_id: "lsp-1",
      tool_input: { operation: "findReferences" }
    });
    await harness.runTimers();

    expect(harness.service.getWarning("/repo", "task")).toMatchObject({
      phase: "tool-running",
      toolName: "LSP",
      toolUseId: "lsp-1"
    });
  });

  it("ignores only the current warning generation", async () => {
    const harness = createHarness();
    await harness.record("UserPromptSubmit");
    await harness.runTimers();
    const warning = harness.service.getWarning("/repo", "task");
    expect(warning).not.toBeNull();

    harness.service.ignoreWarning("/repo", "task", warning!.id);
    expect(harness.service.getWarning("/repo", "task")).toBeNull();
    await harness.runTimers();
    expect(harness.service.getWarning("/repo", "task")).toBeNull();

    await harness.record("PostToolBatch");
    await harness.runTimers();
    expect(harness.service.getWarning("/repo", "task")).not.toBeNull();
  });

  it("recovers only after an explicit action and keeps the Round running", async () => {
    const harness = createHarness();
    await harness.record("UserPromptSubmit");
    await harness.runTimers();
    const warning = harness.service.getWarning("/repo", "task");

    await harness.service.recoverWarning({
      ...harness.taskInput,
      warningId: warning!.id
    });

    expect(harness.calls).toEqual(["recover:coder:runtime-coder"]);
    expect(harness.recoveryPrompt).toContain("awaiting-model");
    expect(harness.service.getWarning("/repo", "task")).toBeNull();
    expect(harness.round.status).toBe("running");
  });
});

function createHarness() {
  const calls: string[] = [];
  let recoveryPrompt = "";
  const timers = new Map<number, { callback: () => void; active: boolean }>();
  let timerSequence = 0;
  const session: RoleSessionRecord = {
    id: "runtime-coder",
    runtimeSessionToken: "token-coder",
    claudeSessionId: "claude-coder",
    taskSlug: "task",
    role: "coder",
    status: "running",
    activityStatus: "running",
    command: "claude --agent coder",
    permissionMode: "bypassPermissions",
    cwd: "/repo/.claude/worktrees/task",
    terminalBackend: "node-pty",
    updatedAt: NOW
  };
  const round: VcmSessionRoundState = {
    taskSlug: "task",
    status: "running",
    roundId: "round-1",
    activeRole: "coder",
    turnCount: 1,
    completedTurnCount: 0,
    totalRoundCount: 1,
    totalTurnCount: 1,
    totalCompletedTurnCount: 0,
    totalCcActiveMs: 0,
    currentRoundCcActiveMs: 0,
    roles: ["coder"],
    updatedAt: NOW
  };
  const deps: RoleStallDetectorServiceDeps = {
    sessionService: {
      async getRoleSession() {
        return session;
      },
      async recoverRoleSession(_repoRoot, _taskSlug, input) {
        calls.push(`recover:${input.role}:${input.expectedSessionId}`);
        recoveryPrompt = input.recoveryPrompt;
        return { ...session, id: "runtime-coder-recovered" };
      }
    },
    roundService: {
      async getSessionRoundState() {
        return round;
      }
    },
    modelTimeoutMs: 10,
    toolTimeoutMs: 10,
    subagentTimeoutMs: 10,
    now: () => NOW,
    setTimeout(callback) {
      const id = ++timerSequence;
      timers.set(id, { callback, active: true });
      return id;
    },
    clearTimeout(timer) {
      const entry = timers.get(timer as number);
      if (entry) {
        entry.active = false;
      }
    }
  };
  const service = createRoleStallDetectorService(deps);
  const taskInput = {
    repoRoot: "/repo",
    taskRepoRoot: "/repo/.claude/worktrees/task",
    stateRoot: ".ai/vcm",
    taskSlug: "task"
  };

  return {
    calls,
    round,
    service,
    taskInput,
    async record(eventName: Parameters<typeof service.recordHook>[0]["eventName"], event = {}) {
      await service.recordHook({
        ...taskInput,
        role: "coder",
        eventName,
        event: {
          hook_event_name: eventName,
          ...event
        }
      });
    },
    async runTimers() {
      for (const timer of timers.values()) {
        if (timer.active) {
          timer.active = false;
          timer.callback();
        }
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    get recoveryPrompt() {
      return recoveryPrompt;
    }
  };
}
