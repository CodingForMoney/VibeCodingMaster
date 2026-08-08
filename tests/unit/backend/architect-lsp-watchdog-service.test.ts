import { describe, expect, it } from "vitest";
import {
  createArchitectLspWatchdogService,
  type ArchitectLspWatchdogServiceDeps
} from "../../../src/backend/services/architect-lsp-watchdog-service.js";
import type { ClaudeTranscriptEvent } from "../../../src/backend/services/claude-transcript-service.js";
import type { VcmSessionRoundState } from "../../../src/shared/types/round.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

const NOW = "2026-08-08T12:00:00.000Z";

describe("createArchitectLspWatchdogService", () => {
  it("clears a completed top-level LSP call without recovery", async () => {
    const harness = createHarness();
    await harness.service.reconcileTask(harness.taskInput);

    harness.emit(lspUse("lsp-1"));
    harness.emit(lspResult("lsp-1"));
    await harness.runTimers();

    expect(harness.calls).toEqual([]);
  });

  it("ignores sidechain LSP calls and non-LSP tools", async () => {
    const harness = createHarness();
    await harness.service.reconcileTask(harness.taskInput);

    harness.emit({ ...lspUse("sidechain"), isSidechain: true });
    harness.emit({
      ...lspUse("read-1"),
      toolUse: { name: "Read", input: { file_path: "/repo/src/main.ts" } }
    });
    await harness.runTimers();

    expect(harness.calls).toEqual([]);
  });

  it("recovers one dangling Architect LSP call without stopping the Round", async () => {
    const harness = createHarness();
    await harness.service.reconcileTask(harness.taskInput);

    harness.emit(lspUse("lsp-1", "goToDefinition"));
    await harness.runTimers();

    expect(harness.calls).toEqual([
      "stall:stalled:lsp-1",
      "round-recovery:retrying",
      "recover:lsp-1",
      "round-recovery:clear"
    ]);
    expect(harness.calls).not.toContain("round:stop");
    expect(harness.recoveryPrompt).toContain("goToDefinition");
  });

  it("stops and pauses after a second LSP stall in the same Round", async () => {
    const harness = createHarness({
      lastRecoveryRoundId: "round-1"
    });
    await harness.service.reconcileTask(harness.taskInput);

    harness.emit(lspUse("lsp-2", "findReferences"));
    await harness.runTimers();

    expect(harness.calls).toEqual([
      "stall:stalled:lsp-2",
      "session:stop-failed",
      "round-recovery:failed",
      "round:stop"
    ]);
  });

  it("stops and pauses when resuming the Claude session fails", async () => {
    const harness = createHarness({
      recoverError: new Error("resume failed")
    });
    await harness.service.reconcileTask(harness.taskInput);

    harness.emit(lspUse("lsp-failed"));
    await harness.runTimers();

    expect(harness.calls).toEqual([
      "stall:stalled:lsp-failed",
      "round-recovery:retrying",
      "recover:lsp-failed",
      "session:stop-failed",
      "round-recovery:failed",
      "round:stop"
    ]);
  });

  it("reconstructs an already-overdue call from transcript replay", async () => {
    const harness = createHarness({
      replayEvents: [lspUse("replayed-lsp", "incomingCalls", "2026-08-08T11:49:00.000Z")]
    });
    await harness.service.reconcileTask(harness.taskInput);
    await harness.runTimers();

    expect(harness.calls).toContain("recover:replayed-lsp");
  });
});

function createHarness(options: {
  lastRecoveryRoundId?: string;
  replayEvents?: ClaudeTranscriptEvent[];
  recoverError?: Error;
} = {}) {
  const calls: string[] = [];
  let listener: ((event: ClaudeTranscriptEvent) => void) | undefined;
  let recoveryPrompt = "";
  let session = createSession(options.lastRecoveryRoundId);
  const timers = new Map<number, { callback: () => void; active: boolean }>();
  let timerSequence = 0;

  const deps: ArchitectLspWatchdogServiceDeps = {
    transcripts: {
      subscribeToRoleSession(_session, nextListener) {
        listener = nextListener;
        for (const event of options.replayEvents ?? []) {
          nextListener(event);
        }
        return () => {
          listener = undefined;
        };
      }
    },
    sessionService: {
      async getRoleSession() {
        return session;
      },
      async setArchitectLspStall(_repoRoot, _taskSlug, _expectedSessionId, stall) {
        calls.push(`stall:${stall.status}:${stall.toolUseId}`);
        session = { ...session, architectLspStall: stall };
        return session;
      },
      async recoverArchitectLspSession(_repoRoot, _taskSlug, input) {
        calls.push(`recover:${input.stall.toolUseId}`);
        recoveryPrompt = input.recoveryPrompt;
        if (options.recoverError) {
          throw options.recoverError;
        }
        session = {
          ...session,
          id: "runtime-architect-resumed",
          architectLspStall: undefined,
          lastArchitectLspRecovery: input.recovery
        };
        return session;
      },
      async stopArchitectLspSessionForFailure() {
        calls.push("session:stop-failed");
        session = { ...session, status: "exited", activityStatus: "idle" };
        return session;
      }
    },
    roundService: {
      async getSessionRoundState() {
        return runningRound();
      },
      async setRoleRecovery(input) {
        calls.push(`round-recovery:${input.recovery.status}`);
        return runningRound();
      },
      async clearRoleRecovery() {
        calls.push("round-recovery:clear");
        return runningRound();
      },
      async recordRoleRecoveryFailure(input) {
        calls.push(`round-recovery:${input.recovery.status}`);
        calls.push("round:stop");
        return {
          ...runningRound(),
          status: "stopped",
          roleRecovery: input.recovery
        };
      }
    },
    stallTimeoutMs: 10 * 60 * 1000,
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

  const service = createArchitectLspWatchdogService(deps);
  return {
    calls,
    service,
    taskInput: {
      repoRoot: "/repo",
      taskRepoRoot: "/repo/.claude/worktrees/task",
      stateRoot: ".ai/vcm",
      taskSlug: "task"
    },
    emit(event: ClaudeTranscriptEvent) {
      listener?.(event);
    },
    async runTimers() {
      for (const timer of timers.values()) {
        if (timer.active) {
          timer.active = false;
          timer.callback();
        }
      }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    get recoveryPrompt() {
      return recoveryPrompt;
    }
  };
}

function createSession(lastRecoveryRoundId?: string): RoleSessionRecord {
  return {
    id: "runtime-architect",
    claudeSessionId: "claude-architect",
    transcriptPath: "/tmp/claude-architect.jsonl",
    taskSlug: "task",
    role: "architect",
    status: "running",
    activityStatus: "running",
    command: "claude --agent architect",
    permissionMode: "bypassPermissions",
    model: "opus",
    effort: "xhigh",
    cwd: "/repo/.claude/worktrees/task",
    terminalBackend: "node-pty",
    lastTurnStartedAt: "2026-08-08T11:45:00.000Z",
    updatedAt: NOW,
    ...(lastRecoveryRoundId
      ? {
          lastArchitectLspRecovery: {
            roundId: lastRecoveryRoundId,
            toolUseId: "previous-lsp",
            recoveredAt: "2026-08-08T11:50:00.000Z"
          }
        }
      : {})
  };
}

function runningRound(): VcmSessionRoundState {
  return {
    taskSlug: "task",
    status: "running",
    roundId: "round-1",
    activeRole: "architect",
    startedAt: "2026-08-08T11:40:00.000Z",
    turnCount: 1,
    completedTurnCount: 0,
    totalRoundCount: 1,
    totalTurnCount: 1,
    totalCompletedTurnCount: 0,
    totalCcActiveMs: 0,
    currentRoundCcActiveMs: 0,
    roles: ["architect"],
    updatedAt: NOW
  };
}

function lspUse(
  id: string,
  operation = "goToDefinition",
  timestamp = "2026-08-08T11:50:00.000Z"
): ClaudeTranscriptEvent {
  return {
    id,
    timestamp,
    kind: "tool_use",
    toolUse: {
      name: "LSP",
      input: { operation }
    }
  };
}

function lspResult(toolUseId: string): ClaudeTranscriptEvent {
  return {
    id: `result-${toolUseId}`,
    timestamp: "2026-08-08T11:55:00.000Z",
    kind: "tool_result",
    toolResult: {
      tool_use_id: toolUseId,
      content: "ok",
      isError: false
    }
  };
}
