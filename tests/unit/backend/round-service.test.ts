import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createRoundService } from "../../../src/backend/services/round-service.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

describe("round-service", () => {
  it("starts a Round on the first UserPromptSubmit", async () => {
    const fs = createMemoryFs();
    const service = createRoundService({
      fs,
      now: () => "2026-05-31T00:00:00.000Z",
      id: () => "round_1"
    });

    const state = await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    expect(state).toMatchObject({
      taskSlug: "demo-task",
      status: "running",
      roundId: "round_1",
      activeRole: "project-manager",
      startedAt: "2026-05-31T00:00:00.000Z",
      lastTurnStartedAt: "2026-05-31T00:00:00.000Z",
      turnCount: 1,
      completedTurnCount: 0,
      totalRoundCount: 1,
      totalTurnCount: 1,
      totalCompletedTurnCount: 0,
      totalCcActiveMs: 0,
      currentRoundCcActiveMs: 0,
      roles: ["project-manager"]
    });
  });

  it("records Gate Reviewer turns through the provider-neutral hook path", async () => {
    const fs = createMemoryFs();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1"
    });

    const started = await service.recordRoleTurnEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "UserPromptSubmit"
    });
    expect(started).toMatchObject({
      status: "running",
      activeRole: "gate-reviewer",
      roles: ["gate-reviewer"],
      totalTurnCount: 1
    });

    currentTime = "2026-05-31T00:00:03.000Z";
    const stopped = await service.recordRoleTurnEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "Stop"
    });
    expect(stopped).toMatchObject({
      status: "running",
      activeRole: "gate-reviewer",
      completedTurnCount: 1,
      totalCompletedTurnCount: 1,
      totalCcActiveMs: 3000,
      settleDeadlineAt: "2026-05-31T00:00:13.000Z"
    });
  });

  it("records StopFailure as a failed turn end that enters settle", async () => {
    const fs = createMemoryFs();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1"
    });

    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:04.000Z";
    const failed = await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder",
      eventName: "StopFailure"
    });

    expect(failed).toMatchObject({
      status: "running",
      activeRole: "coder",
      activeTurnStartedAt: undefined,
      completedTurnCount: 1,
      totalCompletedTurnCount: 1,
      totalCcActiveMs: 4000,
      settleDeadlineAt: "2026-05-31T00:00:14.000Z"
    });
  });

  it("deduplicates a Gate Reviewer prompt when VCM marked the turn before the hook arrives", async () => {
    const fs = createMemoryFs();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1"
    });

    await service.recordRoleTurnEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:01.000Z";
    const duplicate = await service.recordRoleTurnEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "UserPromptSubmit"
    });

    expect(duplicate).toMatchObject({
      status: "running",
      activeRole: "gate-reviewer",
      activeTurnStartedAt: "2026-05-31T00:00:00.000Z",
      turnCount: 1,
      totalTurnCount: 1,
      roles: ["gate-reviewer"]
    });

    currentTime = "2026-05-31T00:00:03.000Z";
    const stopped = await service.recordRoleTurnEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "Stop"
    });

    expect(stopped).toMatchObject({
      completedTurnCount: 1,
      totalCompletedTurnCount: 1,
      totalCcActiveMs: 3000
    });
  });

  it("ignores a stale Gate Reviewer Stop after another role has started", async () => {
    const fs = createMemoryFs();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1"
    });

    await service.recordRoleTurnEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:02.000Z";
    await service.recordRoleTurnEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "Stop"
    });

    currentTime = "2026-05-31T00:00:03.000Z";
    await service.recordRoleTurnEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:04.000Z";
    const staleStop = await service.recordRoleTurnEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "Stop"
    });

    expect(staleStop).toMatchObject({
      status: "running",
      activeRole: "project-manager",
      activeTurnStartedAt: "2026-05-31T00:00:03.000Z",
      turnCount: 2,
      completedTurnCount: 1,
      totalCompletedTurnCount: 1,
      totalCcActiveMs: 3000,
      currentRoundCcActiveMs: 3000
    });
  });

  it("continues the same round when another prompt starts inside the settle window", async () => {
    const fs = createMemoryFs();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1"
    });

    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:02.000Z";
    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "Stop"
    });

    currentTime = "2026-05-31T00:00:08.000Z";
    const state = await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder",
      eventName: "UserPromptSubmit"
    });

    expect(state).toMatchObject({
      status: "running",
      roundId: "round_1",
      activeRole: "coder",
      startedAt: "2026-05-31T00:00:00.000Z",
      lastTurnStartedAt: "2026-05-31T00:00:08.000Z",
      turnCount: 2,
      completedTurnCount: 1,
      totalRoundCount: 1,
      totalTurnCount: 2,
      totalCompletedTurnCount: 1,
      totalCcActiveMs: 2000,
      currentRoundCcActiveMs: 2000,
      roles: ["project-manager", "coder"]
    });
    expect(state.stoppedAt).toBeUndefined();
    expect(state.settleDeadlineAt).toBeUndefined();
  });

  it("stops the round ten seconds after Stop when no new prompt arrives", async () => {
    const fs = createMemoryFs();
    const timers = createManualTimers();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1",
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });

    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:02.000Z";
    const stopping = await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "Stop"
    });

    expect(stopping).toMatchObject({
      status: "running",
      lastTurnEndedAt: "2026-05-31T00:00:02.000Z",
      settleDeadlineAt: "2026-05-31T00:00:12.000Z",
      totalCcActiveMs: 2000,
      currentRoundCcActiveMs: 2000
    });

    currentTime = "2026-05-31T00:00:12.000Z";
    timers.entries[0]?.callback();
    await flushAsyncWork();
    const stopped = await service.getSessionRoundState({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });

    expect(stopped).toMatchObject({
      status: "stopped",
      stoppedAt: "2026-05-31T00:00:12.000Z",
      turnCount: 1,
      completedTurnCount: 1,
      totalRoundCount: 1,
      totalTurnCount: 1,
      totalCompletedTurnCount: 1,
      totalCcActiveMs: 2000,
      currentRoundCcActiveMs: 2000
    });
  });

  it("keeps the round running when a role session is active during the settle window", async () => {
    const fs = createMemoryFs();
    const timers = createManualTimers();
    const sessions: RoleSessionRecord[] = [];
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      sessionService: {
        async listRoleSessions() {
          return sessions;
        }
      },
      now: () => currentTime,
      id: () => "round_1",
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });

    await service.recordClaudeHookEvent({
      repoRoot: "/base",
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:02.000Z";
    await service.recordClaudeHookEvent({
      repoRoot: "/base",
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "Stop"
    });

    sessions.push(createRoleSession("gate-reviewer", {
      activityStatus: "running",
      lastTurnStartedAt: "2026-05-31T00:00:03.000Z"
    }));
    currentTime = "2026-05-31T00:00:03.000Z";
    const active = await service.getSessionRoundState({
      repoRoot: "/base",
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });

    expect(active).toMatchObject({
      status: "running",
      activeRole: "gate-reviewer",
      activeTurnStartedAt: "2026-05-31T00:00:03.000Z",
      settleDeadlineAt: undefined,
      turnCount: 2,
      completedTurnCount: 1,
      totalTurnCount: 2,
      totalCompletedTurnCount: 1,
      totalCcActiveMs: 2000,
      currentRoundCcActiveMs: 2000,
      roles: ["project-manager", "gate-reviewer"]
    });

    currentTime = "2026-05-31T00:00:12.000Z";
    timers.entries[0]?.callback();
    await flushAsyncWork();
    const afterStaleTimer = await service.getSessionRoundState({
      repoRoot: "/base",
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });

    expect(afterStaleTimer).toMatchObject({
      status: "running",
      activeRole: "gate-reviewer",
      activeTurnStartedAt: "2026-05-31T00:00:03.000Z",
      totalCcActiveMs: 11000,
      currentRoundCcActiveMs: 11000
    });
    expect(afterStaleTimer.stoppedAt).toBeUndefined();
  });

  it("updates Session status only when a Round starts or stops", async () => {
    const fs = createMemoryFs();
    const timers = createManualTimers();
    const statusChanges: string[] = [];
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1",
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onSessionStatusChange: async (input) => {
        statusChanges.push(`${input.taskSlug}:${input.status}`);
      }
    });

    await service.recordClaudeHookEvent({
      repoRoot: "/base",
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });
    expect(statusChanges).toEqual(["demo-task:running"]);

    currentTime = "2026-05-31T00:00:02.000Z";
    await service.recordClaudeHookEvent({
      repoRoot: "/base",
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "Stop"
    });
    expect(statusChanges).toEqual(["demo-task:running"]);

    currentTime = "2026-05-31T00:00:12.000Z";
    timers.entries[0]?.callback();
    await flushAsyncWork();

    expect(statusChanges).toEqual(["demo-task:running", "demo-task:stopped"]);
  });

  it("continues the running round when the Stop timer guard dispatches pending work", async () => {
    const fs = createMemoryFs();
    const timers = createManualTimers();
    let currentTime = "2026-05-31T00:00:00.000Z";
    let guardCalls = 0;
    let resolveFirstGuard!: () => void;
    const firstGuardRan = new Promise<void>((resolve) => {
      resolveFirstGuard = resolve;
    });
    const guardInputs: Array<{
      stateRepoRoot: string;
      stateRoot: string;
      taskSlug: string;
      role: string;
      roundId: string;
      settleDeadlineAt: string;
    }> = [];
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1",
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });

    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:02.000Z";
    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "Stop",
      settleGuard: async (input) => {
        guardCalls += 1;
        guardInputs.push(input);
        if (guardCalls === 1) {
          resolveFirstGuard();
        }
        return guardCalls === 1
          ? { action: "continue" }
          : { action: "stop" };
      }
    });

    currentTime = "2026-05-31T00:00:12.000Z";
    timers.entries[0]?.callback();
    await firstGuardRan;
    await flushAsyncWork();

    expect(timers.entries).toHaveLength(2);
    expect(timers.entries[1]?.delayMs).toBe(10_000);
    expect(guardInputs[0]).toMatchObject({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      roundId: "round_1",
      settleDeadlineAt: "2026-05-31T00:00:12.000Z"
    });
    const retried = await service.getSessionRoundState({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });
    expect(retried).toMatchObject({
      status: "running",
      settleDeadlineAt: "2026-05-31T00:00:22.000Z",
      turnCount: 1,
      completedTurnCount: 1
    });
    expect(retried.stoppedAt).toBeUndefined();

    currentTime = "2026-05-31T00:00:22.000Z";
    timers.entries[1]?.callback();
    await flushAsyncWork();

    expect(guardInputs[1]).toMatchObject({
      settleDeadlineAt: "2026-05-31T00:00:22.000Z"
    });
    const stopped = await service.getSessionRoundState({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });
    expect(stopped).toMatchObject({
      status: "stopped",
      stoppedAt: "2026-05-31T00:00:22.000Z"
    });
  });

  it("actively stops from the Stop timer without waiting for a round-state poll", async () => {
    const fs = createMemoryFs();
    const timers = createManualTimers();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1",
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });

    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:02.000Z";
    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "Stop"
    });

    expect(timers.entries).toHaveLength(1);
    expect(timers.entries[0]?.delayMs).toBe(10_000);

    timers.entries[0]?.callback();
    await flushAsyncWork();

    const persisted = await fs.readJson<{
      currentRound: {
        status: string;
        stoppedAt: string;
      };
    }>("/repo/.ai/vcm/rounds/demo-task.json");
    expect(persisted.currentRound).toMatchObject({
      status: "stopped",
      stoppedAt: "2026-05-31T00:00:12.000Z"
    });
  });

  it("does not stop from a stale Stop timer after the round continues", async () => {
    const fs = createMemoryFs();
    const timers = createManualTimers();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1",
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });

    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:02.000Z";
    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "Stop"
    });

    const staleTimer = timers.entries[0];
    currentTime = "2026-05-31T00:00:08.000Z";
    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder",
      eventName: "UserPromptSubmit"
    });

    expect(staleTimer?.cleared).toBe(true);
    staleTimer?.callback();
    await flushAsyncWork();

    const persisted = await fs.readJson<{
      currentRound: {
        status: string;
        activeRole: string;
        turnCount: number;
      };
    }>("/repo/.ai/vcm/rounds/demo-task.json");
    expect(persisted.currentRound).toMatchObject({
      status: "running",
      activeRole: "coder",
      turnCount: 2
    });
  });

  it("starts a new round after a stopped round receives a new prompt", async () => {
    const fs = createMemoryFs();
    const ids = ["round_1", "round_2"];
    const timers = createManualTimers();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => ids.shift() ?? "round_fallback",
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });

    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });
    currentTime = "2026-05-31T00:00:01.000Z";
    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "Stop"
    });
    currentTime = "2026-05-31T00:00:11.000Z";
    timers.entries[0]?.callback();
    await flushAsyncWork();

    currentTime = "2026-05-31T00:00:20.000Z";
    const next = await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder",
      eventName: "UserPromptSubmit"
    });

    expect(next).toMatchObject({
      status: "running",
      roundId: "round_2",
      activeRole: "coder",
      startedAt: "2026-05-31T00:00:20.000Z",
      turnCount: 1,
      completedTurnCount: 0,
      totalRoundCount: 2,
      totalTurnCount: 2,
      totalCompletedTurnCount: 1,
      totalCcActiveMs: 1000,
      currentRoundCcActiveMs: 0,
      roles: ["coder"]
    });
  });

  it("adds live active time while a role is still running", async () => {
    const fs = createMemoryFs();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1"
    });

    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:03.000Z";
    const state = await service.getSessionRoundState({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });

    expect(state).toMatchObject({
      status: "running",
      activeTurnStartedAt: "2026-05-31T00:00:00.000Z",
      totalCcActiveMs: 3000,
      currentRoundCcActiveMs: 3000
    });
  });

  it("aggregates CC active time across multiple prompts in one round", async () => {
    const fs = createMemoryFs();
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => "round_1"
    });

    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:05.000Z";
    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "Stop"
    });

    currentTime = "2026-05-31T00:00:08.000Z";
    await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder",
      eventName: "UserPromptSubmit"
    });

    currentTime = "2026-05-31T00:00:18.000Z";
    const state = await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder",
      eventName: "Stop"
    });

    expect(state).toMatchObject({
      status: "running",
      turnCount: 2,
      completedTurnCount: 2,
      totalRoundCount: 1,
      totalTurnCount: 2,
      totalCompletedTurnCount: 2,
      totalCcActiveMs: 15000,
      currentRoundCcActiveMs: 15000
    });
  });

  it("persists and clears role recovery state", async () => {
    const fs = createMemoryFs();
    const service = createRoundService({
      fs,
      now: () => "2026-05-31T00:00:00.000Z",
      id: () => "round_1"
    });

    const waiting = await service.setRoleRecovery({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      recovery: {
        role: "coder",
        status: "waiting",
        attempt: 3,
        maxAttempts: 20,
        lastFailureAt: "2026-05-31T00:00:00.000Z",
        nextRetryAt: "2026-05-31T00:03:00.000Z"
      }
    });

    expect(waiting.roleRecovery).toMatchObject({
      role: "coder",
      status: "waiting",
      attempt: 3,
      nextRetryAt: "2026-05-31T00:03:00.000Z"
    });
    await expect(service.getSessionRoundState({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    })).resolves.toMatchObject({
      roleRecovery: {
        role: "coder",
        status: "waiting",
        attempt: 3
      }
    });

    const stillWaiting = await service.clearRoleRecovery({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "reviewer"
    });
    expect(stillWaiting.roleRecovery?.role).toBe("coder");

    const cleared = await service.clearRoleRecovery({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder"
    });
    expect(cleared.roleRecovery).toBeUndefined();
  });

  it("emits no flowPause while a round is running", async () => {
    const fs = createMemoryFs();
    const service = createRoundService({
      fs,
      now: () => "2026-05-31T00:00:00.000Z",
      id: () => "round_1"
    });

    const running = await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    expect(running.status).toBe("running");
    expect(running.flowPause).toBeUndefined();
  });

  it("emits no flowPause when there is no current round", async () => {
    const fs = createMemoryFs();
    const service = createRoundService({
      fs,
      now: () => "2026-05-31T00:00:00.000Z",
      id: () => "round_1"
    });

    const state = await service.getSessionRoundState({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });

    expect(state.status).toBe("stopped");
    expect(state.roundId).toBeUndefined();
    expect(state.flowPause).toBeUndefined();
  });

  it("flags flowPause stopped-no-next-turn after a non-user-facing role settles with no recovery", async () => {
    const stopped = await driveRoundToStopped("coder");

    expect(stopped.state.status).toBe("stopped");
    expect(stopped.state.flowPause).toEqual({
      paused: true,
      reason: "stopped-no-next-turn",
      role: "coder",
      since: stopped.state.stoppedAt
    });
  });

  it("suppresses flowPause while a stopped round is mid role-recovery", async () => {
    const stopped = await driveRoundToStopped();

    const waiting = await stopped.service.setRoleRecovery({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      recovery: {
        role: "project-manager",
        status: "waiting",
        attempt: 1,
        maxAttempts: 20,
        lastFailureAt: "2026-05-31T00:00:12.000Z",
        nextRetryAt: "2026-05-31T00:03:12.000Z"
      }
    });
    expect(waiting.status).toBe("stopped");
    expect(waiting.flowPause).toBeUndefined();

    const retrying = await stopped.service.setRoleRecovery({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      recovery: {
        role: "project-manager",
        status: "retrying",
        attempt: 2,
        maxAttempts: 20,
        lastFailureAt: "2026-05-31T00:00:12.000Z",
        nextRetryAt: "2026-05-31T00:03:12.000Z"
      }
    });
    expect(retrying.flowPause).toBeUndefined();
  });

  it("flags flowPause role-recovery-failed when recovery failed on a stopped round", async () => {
    const stopped = await driveRoundToStopped();

    const failed = await stopped.service.setRoleRecovery({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      recovery: {
        role: "project-manager",
        status: "failed",
        attempt: 20,
        maxAttempts: 20,
        lastFailureAt: "2026-05-31T00:00:12.000Z"
      }
    });

    expect(failed.status).toBe("stopped");
    expect(failed.flowPause).toMatchObject({
      paused: true,
      reason: "role-recovery-failed",
      role: "project-manager"
    });
  });

  it("flags flowPause awaiting-user when a user-facing role settles with no onward route", async () => {
    const stopped = await driveRoundToStopped("project-manager");

    expect(stopped.state.status).toBe("stopped");
    expect(stopped.state.flowPause).toEqual({
      paused: true,
      reason: "awaiting-user",
      role: "project-manager",
      since: stopped.state.stoppedAt
    });
  });

  it("keeps awaiting-user sticky when a gate-reviewer turn resumes the round", async () => {
    const stopped = await driveRoundToStopped("project-manager");

    const resumed = await stopped.service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "UserPromptSubmit"
    });

    expect(resumed.status).toBe("running");
    expect(resumed.flowPause).toMatchObject({
      paused: true,
      reason: "awaiting-user",
      role: "project-manager"
    });
  });

  it("does not clear awaiting-user across round-state polling", async () => {
    const stopped = await driveRoundToStopped("project-manager");

    const polled = await stopped.service.getSessionRoundState({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });

    expect(polled.flowPause).toMatchObject({
      paused: true,
      reason: "awaiting-user",
      role: "project-manager"
    });
  });

  it("clears awaiting-user when the awaiting role receives its next prompt", async () => {
    const stopped = await driveRoundToStopped("project-manager");

    const resumed = await stopped.service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "UserPromptSubmit"
    });

    expect(resumed.status).toBe("running");
    expect(resumed.flowPause).toBeUndefined();
  });

  it("promotes a captured user-facing Stop reply to the awaiting-user message at settle", async () => {
    const stopped = await driveRoundToStopped("project-manager", {
      text: "Please confirm the rollout window.",
      truncated: false
    });

    expect(stopped.state.flowPause).toMatchObject({
      reason: "awaiting-user",
      role: "project-manager",
      message: "Please confirm the rollout window.",
      messageTruncated: undefined
    });
  });

  it("carries the truncation flag onto the awaiting-user message", async () => {
    const stopped = await driveRoundToStopped("project-manager", {
      text: "truncated reply",
      truncated: true
    });

    expect(stopped.state.flowPause).toMatchObject({
      reason: "awaiting-user",
      message: "truncated reply",
      messageTruncated: true
    });
  });

  it("emits awaiting-user without a message when no reply was captured", async () => {
    const stopped = await driveRoundToStopped("project-manager");

    expect(stopped.state.flowPause).toMatchObject({
      reason: "awaiting-user",
      role: "project-manager"
    });
    expect(stopped.state.flowPause?.message).toBeUndefined();
  });

  it("keeps the captured message sticky through a gate-reviewer resume", async () => {
    const stopped = await driveRoundToStopped("project-manager", {
      text: "Decision needed.",
      truncated: false
    });

    const resumed = await stopped.service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "UserPromptSubmit"
    });

    expect(resumed.flowPause).toMatchObject({
      reason: "awaiting-user",
      role: "project-manager",
      message: "Decision needed."
    });
  });

  it("does not attach a stale stash to a later non-user-facing anchor", async () => {
    const fs = createMemoryFs();
    const timers = createManualTimers();
    let currentTime = "2026-05-31T00:00:00.000Z";
    let roundCounter = 0;
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => `round_${++roundCounter}`,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });
    const input = { stateRepoRoot: "/repo", stateRoot: ".ai/vcm", taskSlug: "demo-task" } as const;

    // PM stops with a reply, then answers (UserPromptSubmit) before any settle:
    // the stash must be dropped so it cannot attach to a later coder anchor.
    await service.recordClaudeHookEvent({ ...input, role: "project-manager", eventName: "UserPromptSubmit" });
    currentTime = "2026-05-31T00:00:02.000Z";
    await service.recordClaudeHookEvent({
      ...input,
      role: "project-manager",
      eventName: "Stop",
      userFacingReply: { text: "stale PM text", truncated: false }
    });
    currentTime = "2026-05-31T00:00:03.000Z";
    await service.recordClaudeHookEvent({ ...input, role: "project-manager", eventName: "UserPromptSubmit" });

    // A coder turn then stops and settles; its anchor is non-user-facing, so no
    // awaiting-user pause and certainly no leaked PM message.
    currentTime = "2026-05-31T00:00:04.000Z";
    await service.recordClaudeHookEvent({ ...input, role: "coder", eventName: "UserPromptSubmit" });
    currentTime = "2026-05-31T00:00:05.000Z";
    await service.recordClaudeHookEvent({ ...input, role: "coder", eventName: "Stop" });
    currentTime = "2026-05-31T00:00:20.000Z";
    timers.entries.at(-1)?.callback();
    await flushAsyncWork();

    const state = await service.getSessionRoundState(input);
    expect(state.flowPause).toMatchObject({ reason: "stopped-no-next-turn", role: "coder" });
    expect(state.flowPause?.message).toBeUndefined();
  });
});

async function driveRoundToStopped(
  role: RoleName = "project-manager",
  userFacingReply?: { text: string; truncated: boolean }
) {
  const fs = createMemoryFs();
  const timers = createManualTimers();
  let currentTime = "2026-05-31T00:00:00.000Z";
  const service = createRoundService({
    fs,
    now: () => currentTime,
    id: () => "round_1",
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });

  await service.recordClaudeHookEvent({
    stateRepoRoot: "/repo",
    stateRoot: ".ai/vcm",
    taskSlug: "demo-task",
    role,
    eventName: "UserPromptSubmit"
  });
  currentTime = "2026-05-31T00:00:02.000Z";
  await service.recordClaudeHookEvent({
    stateRepoRoot: "/repo",
    stateRoot: ".ai/vcm",
    taskSlug: "demo-task",
    role,
    eventName: "Stop",
    ...(userFacingReply ? { userFacingReply } : {})
  });
  currentTime = "2026-05-31T00:00:12.000Z";
  timers.entries[0]?.callback();
  await flushAsyncWork();

  const state = await service.getSessionRoundState({
    stateRepoRoot: "/repo",
    stateRoot: ".ai/vcm",
    taskSlug: "demo-task"
  });

  return { service, state };
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

function createManualTimers() {
  const entries: Array<{
    callback: () => void;
    delayMs: number;
    cleared: boolean;
  }> = [];

  return {
    entries,
    setTimeout(callback: () => void, delayMs: number) {
      const entry = {
        callback,
        delayMs,
        cleared: false
      };
      entries.push(entry);
      return entry;
    },
    clearTimeout(timer: unknown) {
      const entry = timer as { cleared?: boolean };
      entry.cleared = true;
    }
  };
}

function createRoleSession(role: RoleSessionRecord["role"], patch: Partial<RoleSessionRecord> = {}): RoleSessionRecord {
  return {
    id: `${role}-session`,
    claudeSessionId: `${role}-claude-session`,
    taskSlug: "demo-task",
    role,
    status: "running",
    activityStatus: "idle",
    command: `claude --agent ${role}`,
    permissionMode: "default",
    cwd: "/repo",
    terminalBackend: "node-pty",
    updatedAt: "2026-05-31T00:00:00.000Z",
    ...patch
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}
