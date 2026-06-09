import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createRoundService } from "../../../src/backend/services/round-service.js";

describe("round-service", () => {
  it("starts a flow round on the first UserPromptSubmit", async () => {
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
      status: "active",
      roundId: "round_1",
      activeRole: "project-manager",
      startedAt: "2026-05-31T00:00:00.000Z",
      lastPromptSubmittedAt: "2026-05-31T00:00:00.000Z",
      promptSubmitCount: 1,
      stopCount: 0,
      totalRoundCount: 1,
      totalPromptSubmitCount: 1,
      totalStopCount: 0,
      totalCcActiveMs: 0,
      currentRoundCcActiveMs: 0,
      roles: ["project-manager"]
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
      status: "active",
      roundId: "round_1",
      activeRole: "coder",
      startedAt: "2026-05-31T00:00:00.000Z",
      lastPromptSubmittedAt: "2026-05-31T00:00:08.000Z",
      promptSubmitCount: 2,
      stopCount: 1,
      totalRoundCount: 1,
      totalPromptSubmitCount: 2,
      totalStopCount: 1,
      totalCcActiveMs: 2000,
      currentRoundCcActiveMs: 2000,
      roles: ["project-manager", "coder"]
    });
    expect(state.pauseId).toBeUndefined();
    expect(state.pausedAt).toBeUndefined();
    expect(state.settleDeadlineAt).toBeUndefined();
  });

  it("pauses the round after Stop settles for ten seconds without a new prompt", async () => {
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
    const settling = await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "project-manager",
      eventName: "Stop"
    });

    expect(settling).toMatchObject({
      status: "settling",
      lastStopAt: "2026-05-31T00:00:02.000Z",
      settleDeadlineAt: "2026-05-31T00:00:12.000Z",
      totalCcActiveMs: 2000,
      currentRoundCcActiveMs: 2000
    });

    currentTime = "2026-05-31T00:00:12.000Z";
    const paused = await service.getTaskRoundState({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });

    expect(paused).toMatchObject({
      status: "paused",
      pauseId: "round_1:2026-05-31T00:00:12.000Z",
      pausedAt: "2026-05-31T00:00:12.000Z",
      promptSubmitCount: 1,
      stopCount: 1,
      totalRoundCount: 1,
      totalPromptSubmitCount: 1,
      totalStopCount: 1,
      totalCcActiveMs: 2000,
      currentRoundCcActiveMs: 2000
    });
  });

  it("actively pauses from the Stop timer without waiting for a round-state poll", async () => {
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
        pausedAt: string;
      };
    }>("/repo/.ai/vcm/rounds/demo-task.json");
    expect(persisted.currentRound).toMatchObject({
      status: "paused",
      pausedAt: "2026-05-31T00:00:12.000Z"
    });
  });

  it("does not pause from a stale Stop timer after the round continues", async () => {
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
        promptSubmitCount: number;
      };
    }>("/repo/.ai/vcm/rounds/demo-task.json");
    expect(persisted.currentRound).toMatchObject({
      status: "active",
      activeRole: "coder",
      promptSubmitCount: 2
    });
  });

  it("starts a new round after a paused round receives a new prompt", async () => {
    const fs = createMemoryFs();
    const ids = ["round_1", "round_2"];
    let currentTime = "2026-05-31T00:00:00.000Z";
    const service = createRoundService({
      fs,
      now: () => currentTime,
      id: () => ids.shift() ?? "round_fallback"
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
    await service.getTaskRoundState({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });

    currentTime = "2026-05-31T00:00:20.000Z";
    const next = await service.recordClaudeHookEvent({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder",
      eventName: "UserPromptSubmit"
    });

    expect(next).toMatchObject({
      status: "active",
      roundId: "round_2",
      activeRole: "coder",
      startedAt: "2026-05-31T00:00:20.000Z",
      promptSubmitCount: 1,
      stopCount: 0,
      totalRoundCount: 2,
      totalPromptSubmitCount: 2,
      totalStopCount: 1,
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
    const state = await service.getTaskRoundState({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task"
    });

    expect(state).toMatchObject({
      status: "active",
      runningSince: "2026-05-31T00:00:00.000Z",
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
      status: "settling",
      promptSubmitCount: 2,
      stopCount: 2,
      totalRoundCount: 1,
      totalPromptSubmitCount: 2,
      totalStopCount: 2,
      totalCcActiveMs: 15000,
      currentRoundCcActiveMs: 15000
    });
  });
});

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

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
