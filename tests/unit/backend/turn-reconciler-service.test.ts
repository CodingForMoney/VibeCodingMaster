import { describe, expect, it } from "vitest";
import { createTurnReconcilerService } from "../../../src/backend/services/turn-reconciler-service.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

const TASK: TaskRecord = {
  version: 1,
  taskSlug: "demo-task",
  title: "Demo task",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
  repoRoot: "/repo",
  worktreePath: "/repo/.claude/worktrees/demo-task",
  branch: "feature/demo-task",
  handoffDir: ".ai/vcm/handoffs",
  status: "running",
  cleanupStatus: "active"
};

describe("createTurnReconcilerService", () => {
  it("synthesizes Stop when transcript proves the active turn completed", async () => {
    const hooks: unknown[] = [];
    const service = createReconciler({
      hooks,
      evidence: {
        completion: { id: "assistant-end", timestamp: "2026-07-15T00:01:00.000Z" }
      }
    });

    const result = await service.reconcileTask("/repo", TASK, ".ai/vcm");

    expect(result).toEqual({ status: "completed", role: "tester", reason: "transcript-end-turn" });
    expect(hooks).toEqual([expect.objectContaining({
      taskSlug: "demo-task",
      role: "tester",
      event: expect.objectContaining({
        hook_event_name: "Stop",
        session_id: "claude-tester",
        vcm_runtime_session_id: "runtime-tester",
        vcm_completion_id: "assistant-end"
      })
    })]);
  });

  it("synthesizes a non-retryable failure when the terminal session exited", async () => {
    const hooks: unknown[] = [];
    const service = createReconciler({
      hooks,
      session: roleSession({ status: "crashed" })
    });

    const result = await service.reconcileTask("/repo", TASK, ".ai/vcm");

    expect(result).toEqual({ status: "failed", role: "tester", reason: "terminal-session-exited" });
    expect(hooks).toEqual([expect.objectContaining({
      event: expect.objectContaining({
        hook_event_name: "StopFailure",
        error: "terminal_session_exited"
      })
    })]);
  });

  it("leaves a live turn running without requiring recent output", async () => {
    const hooks: unknown[] = [];
    const service = createReconciler({
      hooks,
      session: roleSession({
        lastHookEventAt: "2026-07-15T00:00:00.000Z",
        lastOutputAt: "2026-07-15T00:00:00.000Z"
      })
    });

    await expect(service.reconcileTask("/repo", TASK, ".ai/vcm")).resolves.toEqual({ status: "active" });
    expect(hooks).toEqual([]);
  });

  it("does not interrupt or fail a quiet live turn", async () => {
    const hooks: unknown[] = [];
    const service = createReconciler({
      hooks,
      session: roleSession({
        lastHookEventAt: "2026-07-15T00:00:00.000Z",
        lastOutputAt: "2026-07-15T00:00:00.000Z"
      })
    });

    await expect(service.reconcileTask("/repo", TASK, ".ai/vcm")).resolves.toEqual({ status: "active" });
    await expect(service.reconcileTask("/repo", TASK, ".ai/vcm")).resolves.toEqual({ status: "active" });
    expect(hooks).toEqual([]);
  });
});

function createReconciler(input: {
  hooks: unknown[];
  session?: RoleSessionRecord;
  evidence?: { completion?: { id: string | null; timestamp: string } };
}) {
  return createTurnReconcilerService({
    sessionService: {
      async getRoleSession() {
        return input.session ?? roleSession();
      }
    },
    roundService: {
      async getSessionRoundState() {
        return {
          taskSlug: "demo-task",
          status: "running",
          roundId: "round-1",
          activeRole: "tester",
          activeTurnStartedAt: "2026-07-15T00:00:00.000Z",
          turnCount: 1,
          completedTurnCount: 0,
          totalRoundCount: 1,
          totalTurnCount: 1,
          totalCompletedTurnCount: 0,
          totalCcActiveMs: 0,
          currentRoundCcActiveMs: 0,
          roles: ["tester"],
          updatedAt: "2026-07-15T00:00:00.000Z"
        };
      }
    },
    claudeHookService: {
      async handleReconciledTurnEnd(hook) {
        input.hooks.push(hook);
        return {
          ok: true,
          eventName: hook.event.hook_event_name as "Stop" | "StopFailure",
          taskSlug: hook.taskSlug,
          role: hook.role,
          sessionUpdated: true,
          dispatchedCount: 0
        };
      }
    },
    async readTranscriptEvidence() {
      return input.evidence ?? {};
    }
  });
}

function roleSession(overrides: Partial<RoleSessionRecord> = {}): RoleSessionRecord {
  return {
    id: "runtime-tester",
    claudeSessionId: "claude-tester",
    transcriptPath: "/transcripts/claude-tester.jsonl",
    taskSlug: "demo-task",
    role: "tester",
    status: "running",
    activityStatus: "running",
    command: "claude --agent tester",
    permissionMode: "bypassPermissions",
    cwd: TASK.worktreePath,
    terminalBackend: "node-pty",
    lastTurnStartedAt: "2026-07-15T00:00:00.000Z",
    lastHookEventAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
}
