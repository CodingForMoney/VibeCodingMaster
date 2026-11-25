import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createClaudeHookService } from "../../../src/backend/services/claude-hook-service.js";
import { createRoundService } from "../../../src/backend/services/round-service.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

// StopFailure retry state, exercised through the real round-service so the
// recovery entries are persisted and read back exactly as in production.
describe("Claude hook role recovery", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createHarness(options: { initialActivity?: "running" | "idle" } = {}) {
    const transcriptDir = await mkdtemp(path.join(tmpdir(), "vcm-hook-recovery-"));
    tempDirs.push(transcriptDir);
    const clock = { now: "2026-11-25T00:00:00.000Z" };
    const sessions = new Map<RoleName, RoleSessionRecord>();
    const writes: Array<{ sessionId: string; data: string }> = [];
    const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
    const gatewayFailures: Array<{ role: string }> = [];
    const gatewayStops: string[] = [];
    const routeScans: string[] = [];
    const activeJobs: Array<{ jobId: string; status: string }> = [];
    const roundService = createRoundService({ fs: createMemoryFs(), now: () => clock.now });

    function addSession(role: RoleName): RoleSessionRecord {
      const record: RoleSessionRecord = {
        id: `runtime_${role}`,
        claudeSessionId: `claude_${role}`,
        transcriptPath: path.join(transcriptDir, `claude_${role}.jsonl`),
        taskSlug: "demo-task",
        role,
        status: "running",
        activityStatus: options.initialActivity ?? "running",
        command: `claude --agent ${role}`,
        permissionMode: "default",
        cwd: "/repo/.claude/worktrees/demo-task",
        terminalBackend: "node-pty",
        lastTurnStartedAt: "2026-11-24T23:50:00.000Z",
        ...(options.initialActivity === "idle" ? { lastTurnEndedAt: "2026-11-24T23:55:00.000Z" } : {}),
        updatedAt: "2026-11-24T23:50:00.000Z"
      };
      sessions.set(role, record);
      return record;
    }

    function updateSession(role: RoleName, patch: Partial<RoleSessionRecord>): RoleSessionRecord | undefined {
      const current = sessions.get(role);
      if (!current) {
        return undefined;
      }
      const next = { ...current, ...patch, updatedAt: clock.now };
      sessions.set(role, next);
      return next;
    }

    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async getRoleSession(_repoRoot: string, _taskSlug: string, role: RoleName) {
          return sessions.get(role);
        },
        async listRoleSessions() {
          return [...sessions.values()];
        },
        async markRoleActivityRunning(_repoRoot: string, _taskSlug: string, role: RoleName) {
          return updateSession(role, { activityStatus: "running", lastTurnStartedAt: clock.now });
        },
        async markRoleActivityIdle(_repoRoot: string, _taskSlug: string, role: RoleName) {
          return updateSession(role, { activityStatus: "idle" });
        },
        async recordClaudeHookEvent(_repoRoot: string, input: { role: RoleName; eventName: string }) {
          if (input.eventName === "UserPromptSubmit") {
            return updateSession(input.role, { activityStatus: "running", lastTurnStartedAt: clock.now });
          }
          if (input.eventName === "Stop" || input.eventName === "StopFailure") {
            return updateSession(input.role, { activityStatus: "idle", lastTurnEndedAt: clock.now });
          }
          return sessions.get(input.role);
        }
      } as never,
      messageService: {
        async listPendingRouteFiles() {
          return [];
        },
        async scanAndDispatchPendingRouteFiles(input: { stoppedRole?: string }) {
          routeScans.push(input.stoppedRole ?? "settle");
          return [];
        }
      } as never,
      roundService,
      translationService: {
        async recordConversationBoundary() {
          return undefined;
        }
      },
      appSettings: {
        async getPreferences() {
          return { roleRetryEnabled: true } as never;
        }
      },
      gatewayService: {
        async handleRoleStop(input) {
          gatewayStops.push(input.session.role);
        },
        async handleRoleStopFailure(input) {
          gatewayFailures.push(input);
        }
      },
      runtime: {
        write(sessionId, data) {
          writes.push({ sessionId, data });
        }
      },
      jobGuard: {
        async findActiveJobs() {
          return activeJobs;
        },
        async evaluateStop() {
          return { behavior: "allow" };
        },
        notePromptSubmitted() {}
      },
      now: () => clock.now,
      retrySetTimeout(callback, delayMs) {
        timers.push({ callback, delayMs, cleared: false });
        return timers.length as never;
      },
      retryClearTimeout(timer) {
        const entry = timers[(timer as unknown as number) - 1];
        if (entry) {
          entry.cleared = true;
        }
      }
    });

    function stopFailure(role: RoleName, error = "server_error") {
      return service.handleHook({
        taskSlug: "demo-task",
        role,
        event: {
          hook_event_name: "StopFailure",
          session_id: `claude_${role}`,
          error,
          last_assistant_message: "API Error: Connection dropped (ECONNRESET)"
        }
      });
    }

    async function fireTimers(): Promise<void> {
      const pending = timers.filter((timer) => !timer.cleared);
      for (const timer of pending) {
        timer.cleared = true;
        timer.callback();
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    function recoveryPrompts(role: RoleName): number {
      return writes.filter((write) => write.sessionId === `runtime_${role}` && write.data.includes("[VCM Recovery]")).length;
    }

    async function writeTranscript(
      role: RoleName,
      records: Array<Record<string, unknown>>,
      modifiedAt?: string
    ): Promise<void> {
      const transcriptPath = path.join(transcriptDir, `claude_${role}.jsonl`);
      await writeFile(transcriptPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
      const lastTimestamp = modifiedAt ?? String(records.at(-1)?.timestamp ?? clock.now);
      await utimes(transcriptPath, new Date(lastTimestamp), new Date(lastTimestamp));
    }

    const roundInput = { repoRoot: "/repo", stateRepoRoot: "/repo/.claude/worktrees/demo-task", stateRoot: ".ai/vcm", taskSlug: "demo-task" };
    const roundState = () => roundService.getSessionRoundState(roundInput);

    return {
      clock,
      sessions,
      timers,
      gatewayFailures,
      gatewayStops,
      routeScans,
      activeJobs,
      roundService,
      roundInput,
      addSession,
      stopFailure,
      fireTimers,
      recoveryPrompts,
      writeTranscript,
      roundState,
      service
    };
  }

  describe("per-role retry state", () => {
    it("retries every role that fails within one retry delay, each with its own attempt", async () => {
      const harness = await createHarness();
      harness.addSession("coder");
      harness.addSession("tester");

      await harness.stopFailure("coder");
      harness.clock.now = "2026-11-25T00:00:20.000Z";
      await harness.stopFailure("tester");

      const state = await harness.roundState();
      expect(state.roleRecoveries).toEqual([
        expect.objectContaining({ role: "coder", status: "waiting", attempt: 1 }),
        expect.objectContaining({ role: "tester", status: "waiting", attempt: 1 })
      ]);

      harness.clock.now = "2026-11-25T00:01:30.000Z";
      await harness.fireTimers();

      expect(harness.recoveryPrompts("coder")).toBe(1);
      expect(harness.recoveryPrompts("tester")).toBe(1);
    });

    it("grows each role's attempt and backoff when failures alternate between roles", async () => {
      const harness = await createHarness();
      harness.addSession("coder");
      harness.addSession("tester");

      await harness.stopFailure("coder");
      await harness.stopFailure("tester");
      harness.clock.now = "2026-11-25T00:01:30.000Z";
      await harness.fireTimers();
      await harness.stopFailure("coder");
      await harness.stopFailure("tester");

      const state = await harness.roundState();
      expect(state.roleRecoveries).toEqual([
        expect.objectContaining({ role: "coder", attempt: 2, nextRetryAt: "2026-11-25T00:03:30.000Z" }),
        expect.objectContaining({ role: "tester", attempt: 2, nextRetryAt: "2026-11-25T00:03:30.000Z" })
      ]);
      expect(harness.timers.filter((timer) => !timer.cleared).map((timer) => timer.delayMs)).toEqual([120_000, 120_000]);
    });
  });

  describe("StopFailure outside a VCM-tracked turn", () => {
    it("ignores a background StopFailure for an idle role", async () => {
      const harness = await createHarness({ initialActivity: "idle" });
      harness.addSession("reviewer");
      await harness.writeTranscript("reviewer", [
        { type: "user", timestamp: "2026-11-24T23:50:00.000Z", message: { role: "user", content: "Review the gate." } },
        {
          type: "assistant",
          timestamp: "2026-11-24T23:54:59.000Z",
          message: { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] }
        }
      ]);

      const result = await harness.stopFailure("reviewer");

      expect(result.sessionUpdated).toBe(false);
      expect(harness.sessions.get("reviewer")?.activityStatus).toBe("idle");
      expect((await harness.roundState()).roleRecoveries).toBeUndefined();
      expect(harness.timers).toEqual([]);
      expect(harness.gatewayFailures).toEqual([]);
    });

    it("retries an idle role whose transcript records a main-thread API error after its last turn", async () => {
      const harness = await createHarness({ initialActivity: "idle" });
      harness.addSession("tester");
      await harness.writeTranscript("tester", [
        { type: "user", timestamp: "2026-11-24T23:58:00.000Z", message: { role: "user", content: "Run the suite." } },
        {
          type: "assistant",
          timestamp: "2026-11-24T23:59:30.000Z",
          isApiErrorMessage: true,
          error: "server_error",
          message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: Connection dropped" }] }
        }
      ]);

      await harness.stopFailure("tester");

      expect((await harness.roundState()).roleRecoveries).toEqual([
        expect.objectContaining({ role: "tester", status: "waiting", attempt: 1 })
      ]);
      expect(harness.sessions.get("tester")?.activityStatus).toBe("running");
    });

    it("ignores a StopFailure that arrives while the role only waits for its retry", async () => {
      const harness = await createHarness();
      harness.addSession("coder");
      await harness.writeTranscript("coder", [
        {
          type: "assistant",
          timestamp: "2026-11-24T23:59:59.000Z",
          isApiErrorMessage: true,
          error: "server_error",
          message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: Connection dropped" }] }
        }
      ]);

      await harness.stopFailure("coder");
      harness.clock.now = "2026-11-25T00:00:02.000Z";
      await harness.stopFailure("coder");

      expect((await harness.roundState()).roleRecoveries).toEqual([
        expect.objectContaining({ role: "coder", status: "waiting", attempt: 1 })
      ]);
      expect(harness.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
    });
  });

  describe("stale running activity", () => {
    const prompt = { type: "user", timestamp: "2026-11-24T23:50:00.000Z", message: { role: "user", content: "[VCM MESSAGE] Implement the plan." } };
    const endTurn = {
      type: "assistant",
      timestamp: "2026-11-24T23:52:00.000Z",
      message: { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Implementation committed." }] }
    };
    const stopHookSummary = { type: "system", subtype: "stop_hook_summary", timestamp: "2026-11-24T23:52:01.000Z" };

    it("settles a role whose Stop hook was lost after the turn ended", async () => {
      const harness = await createHarness();
      harness.addSession("coder");
      await harness.writeTranscript("coder", [prompt, endTurn, stopHookSummary]);

      const results = await harness.service.reconcileStaleRoleActivity("/repo", "demo-task");

      expect(results).toEqual([{ role: "coder", action: "stop" }]);
      expect(harness.sessions.get("coder")?.activityStatus).toBe("idle");
      expect(harness.routeScans).toEqual(["coder"]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(harness.gatewayStops).toEqual(["coder"]);
    });

    it("schedules the retry of a role whose StopFailure hook was lost", async () => {
      const harness = await createHarness();
      harness.addSession("tester");
      await harness.writeTranscript("tester", [prompt, {
        type: "assistant",
        timestamp: "2026-11-24T23:52:00.000Z",
        isApiErrorMessage: true,
        error: "server_error",
        message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: Connection dropped" }] }
      }]);

      const results = await harness.service.reconcileStaleRoleActivity("/repo", "demo-task");

      expect(results).toEqual([{ role: "tester", action: "stop-failure" }]);
      expect((await harness.roundState()).roleRecoveries).toEqual([
        expect.objectContaining({ role: "tester", status: "waiting", attempt: 1, error: "server_error" })
      ]);
    });

    it("marks a role idle when the transcript shows the user interrupted the turn", async () => {
      const harness = await createHarness();
      harness.addSession("architect");
      await harness.roundService.recordClaudeHookEvent({ ...harness.roundInput, role: "architect", eventName: "UserPromptSubmit" });
      await harness.writeTranscript("architect", [prompt, {
        type: "user",
        timestamp: "2026-11-24T23:51:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }
      }]);

      const results = await harness.service.reconcileStaleRoleActivity("/repo", "demo-task");

      expect(results).toEqual([{ role: "architect", action: "interrupt" }]);
      expect(harness.sessions.get("architect")?.activityStatus).toBe("idle");
      expect(await harness.roundState()).toMatchObject({ status: "stopped", stopReason: "manual-interrupt" });
    });

    it.each([
      {
        label: "the transcript was written recently",
        records: [prompt, endTurn],
        modifiedAt: "2026-11-24T23:58:00.000Z"
      },
      {
        label: "the turn is still waiting on a tool",
        records: [prompt, { ...endTurn, message: { ...endTurn.message, stop_reason: "tool_use" } }],
        modifiedAt: undefined
      },
      {
        label: "the completed reply belongs to an earlier turn",
        records: [{ ...endTurn, timestamp: "2026-11-24T23:40:00.000Z" }],
        modifiedAt: "2026-11-24T23:40:00.000Z"
      }
    ])("leaves a running role alone when $label", async ({ records, modifiedAt }) => {
      const harness = await createHarness();
      harness.addSession("coder");
      await harness.writeTranscript("coder", records, modifiedAt);

      await expect(harness.service.reconcileStaleRoleActivity("/repo", "demo-task")).resolves.toEqual([]);
      expect(harness.sessions.get("coder")?.activityStatus).toBe("running");
    });

    it("leaves a role alone while a long-running validation job is active", async () => {
      const harness = await createHarness();
      harness.addSession("coder");
      harness.activeJobs.push({ jobId: "job-1", status: "running" });
      await harness.writeTranscript("coder", [prompt, endTurn]);

      await expect(harness.service.reconcileStaleRoleActivity("/repo", "demo-task")).resolves.toEqual([]);
      expect(harness.sessions.get("coder")?.activityStatus).toBe("running");
    });

    it("leaves a role alone while its retry is pending", async () => {
      const harness = await createHarness();
      harness.addSession("coder");
      await harness.stopFailure("coder");
      harness.clock.now = "2026-11-25T00:00:30.000Z";
      await harness.writeTranscript("coder", [prompt, endTurn]);

      await expect(harness.service.reconcileStaleRoleActivity("/repo", "demo-task")).resolves.toEqual([]);
    });
  });

  describe("hook event diagnostics", () => {
    it("records how each hook was handled", async () => {
      const harness = await createHarness({ initialActivity: "idle" });
      harness.addSession("reviewer");

      await harness.stopFailure("reviewer");
      await harness.service.handleHook({
        taskSlug: "demo-task",
        role: "coder",
        event: { hook_event_name: "Stop", session_id: "claude_coder" }
      });

      expect(harness.service.listRecentHookEvents()).toEqual([
        expect.objectContaining({
          receivedAt: "2026-11-25T00:00:00.000Z",
          taskSlug: "demo-task",
          role: "reviewer",
          eventName: "StopFailure",
          sessionMatched: true,
          outcome: "ignored-background-stop-failure",
          detail: expect.stringContaining("server_error")
        }),
        expect.objectContaining({ role: "coder", eventName: "Stop", sessionMatched: false, outcome: "stale-session" })
      ]);
    });

    it("records a stale-activity reconciliation as its own event", async () => {
      const harness = await createHarness();
      harness.addSession("coder");
      await harness.writeTranscript("coder", [{
        type: "assistant",
        timestamp: "2026-11-24T23:52:00.000Z",
        message: { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] }
      }]);

      await harness.service.reconcileStaleRoleActivity("/repo", "demo-task");

      expect(harness.service.listRecentHookEvents().at(-1)).toMatchObject({
        role: "coder",
        eventName: "StaleActivityReconcile",
        outcome: "stop"
      });
    });

    it("keeps only the most recent hook events", async () => {
      const harness = await createHarness();
      for (let index = 0; index < 510; index += 1) {
        await harness.service.handleHook({
          taskSlug: "demo-task",
          role: "coder",
          event: { hook_event_name: "PostCompact", session_id: `stale_${index}` }
        });
      }

      const events = harness.service.listRecentHookEvents();
      expect(events).toHaveLength(500);
      expect(events[0]?.outcome).toBe("stale-session");
    });
  });

  it("does not paste a recovery prompt after the user interrupts the waiting role", async () => {
    const harness = await createHarness();
    harness.addSession("project-manager");

    await harness.stopFailure("project-manager");
    await harness.roundService.recordManualInterrupt({ ...harness.roundInput, role: "project-manager" });
    harness.clock.now = "2026-11-25T00:01:30.000Z";
    await harness.fireTimers();

    expect(harness.recoveryPrompts("project-manager")).toBe(0);
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

function createProjectServiceStub() {
  const config = {
    version: 1,
    repoRoot: "/repo",
    defaultRoles: ["project-manager", "architect", "coder", "tester"],
    handoffRoot: ".ai/vcm/handoffs",
    stateRoot: ".ai/vcm",
    terminalBackend: "node-pty",
    claudeCommand: "claude"
  };
  return {
    async getCurrentProject() {
      return { repoRoot: "/repo", branch: "main", isDirty: false, config, warnings: [] };
    },
    async loadConfig() {
      return config;
    }
  } as never;
}

function createTaskServiceStub() {
  return {
    async loadTask(): Promise<TaskRecord> {
      return {
        version: 1,
        taskSlug: "demo-task",
        createdAt: "2026-11-24T00:00:00.000Z",
        updatedAt: "2026-11-24T00:00:00.000Z",
        repoRoot: "/repo",
        worktreePath: "/repo/.claude/worktrees/demo-task",
        branch: "feature/demo-task",
        handoffDir: ".ai/vcm/handoffs",
        status: "running"
      };
    }
  } as never;
}
