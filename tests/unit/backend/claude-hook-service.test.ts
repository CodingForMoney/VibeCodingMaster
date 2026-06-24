import { describe, expect, it } from "vitest";
import { createClaudeHookService } from "../../../src/backend/services/claude-hook-service.js";
import type { MessageService } from "../../../src/backend/services/message-service.js";
import type { ProjectService } from "../../../src/backend/services/project-service.js";
import type { RoundService, RoundSettleGuard } from "../../../src/backend/services/round-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import type { TranslationService } from "../../../src/backend/services/translation-service.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

describe("createClaudeHookService", () => {
  it("marks UserPromptSubmit activity running and confirms delivered VCM messages", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.role}:${input.claudeSessionId}`);
          return {
            id: "runtime_coder",
            claudeSessionId: "claude_coder",
            taskSlug: input.taskSlug,
            role: input.role,
            status: "running",
            activityStatus: "running",
            command: "claude --agent coder",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            updatedAt: "2026-06-01T00:00:00.000Z"
          };
        }
      } as SessionService,
      messageService: {
        async confirmPromptSubmitted(input) {
          calls.push(`confirm:${input.taskSlug}:${input.role}:${input.prompt?.includes("msg_123")}`);
          return {
            id: "msg_123",
            taskSlug: input.taskSlug,
            fromRole: "project-manager",
            toRole: input.role,
            type: "task",
            body: "Do it.",
            artifactRefs: [],
            createdAt: "2026-06-01T00:00:00.000Z",
            deliveredAt: "2026-06-01T00:00:00.000Z",
            acceptedAt: "2026-06-01T00:00:01.000Z"
          };
        }
      } as MessageService,
      roundService: {
        async recordClaudeHookEvent(input) {
          calls.push(`round:${input.eventName}:${input.role}`);
          return {} as never;
        }
      } as RoundService,
      translationService: {
        async recordConversationBoundary(input) {
          calls.push(`boundary:${input.boundaryKind}:${input.role}:${input.sessionId}`);
          return undefined;
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub()
    });

    const result = await service.handleHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "claude_coder",
        prompt: "[VCM MESSAGE]\nid: msg_123\n[/VCM MESSAGE]"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "UserPromptSubmit",
      sessionUpdated: true,
      dispatchedCount: 0,
      acceptedMessageId: "msg_123"
    });
    expect(calls).toEqual([
      "session:UserPromptSubmit:coder:claude_coder",
      "round:UserPromptSubmit:coder",
      "boundary:start:coder:runtime_coder",
      "confirm:demo-task:coder:true"
    ]);
  });

  it("marks Stop activity idle and scans pending route files", async () => {
    const calls: string[] = [];
    let capturedSettleGuard: RoundSettleGuard | undefined;
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.role}:${input.claudeSessionId}`);
          return {
            id: "runtime_coder",
            claudeSessionId: "claude_coder",
            taskSlug: input.taskSlug,
            role: input.role,
            status: "running",
            activityStatus: "idle",
            command: "claude --agent coder",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            updatedAt: "2026-06-01T00:00:00.000Z"
          };
        }
      } as SessionService,
      messageService: {
        async listPendingRouteFiles(input) {
          calls.push(`list:${input.taskSlug}:${input.handoffDir}:${input.stateRepoRoot}`);
          return [
            {
              path: ".ai/vcm/handoffs/messages/coder-project-manager.md",
              fromRole: "coder",
              toRole: "project-manager",
              type: "result",
              body: "Done.",
              artifactRefs: [],
              exists: true,
              pending: true
            }
          ];
        },
        async scanAndDispatchPendingRouteFiles(input) {
          calls.push(`scan:${input.taskSlug}:${input.stoppedRole}:${input.handoffDir}:${input.stateRepoRoot}`);
          return [
            {
              delivered: true,
              requiresUserApproval: false,
              clearedRouteFile: true,
              message: {
                id: "msg_123",
                taskSlug: input.taskSlug,
                fromRole: "coder",
                toRole: "project-manager",
                type: "result",
                body: "Done.",
                artifactRefs: [],
                createdAt: "2026-06-01T00:00:00.000Z"
              }
            }
          ];
        }
      } as MessageService,
      roundService: {
        async recordClaudeHookEvent(input) {
          calls.push(`round:${input.eventName}:${input.role}`);
          capturedSettleGuard = input.settleGuard;
          return {} as never;
        }
      } as RoundService,
      translationService: {
        async recordConversationBoundary(input) {
          calls.push(`boundary:${input.boundaryKind}:${input.role}:${input.sessionId}`);
          return undefined;
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub("allowAll")
    });

    const result = await service.handleStopHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "Stop",
        session_id: "claude_coder",
        transcript_path: "/Users/sheldon/.claude/projects/demo/claude_coder.jsonl"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "Stop",
      sessionUpdated: true,
      dispatchedCount: 1
    });
    expect(calls).toEqual([
      "session:Stop:coder:claude_coder",
      "round:Stop:coder",
      "boundary:end:coder:runtime_coder",
      "scan:demo-task:coder:.ai/vcm/handoffs:/repo/.claude/worktrees/demo-task"
    ]);

    calls.length = 0;
    const settleDecision = await capturedSettleGuard?.({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder",
      roundId: "round_1",
      settleDeadlineAt: "2026-06-01T00:00:10.000Z"
    });
    expect(settleDecision).toMatchObject({ action: "continue" });
    expect(calls).toEqual([
      "list:demo-task:.ai/vcm/handoffs:/repo/.claude/worktrees/demo-task",
      "scan:demo-task:undefined:.ai/vcm/handoffs:/repo/.claude/worktrees/demo-task"
    ]);
  });

  it("treats StopFailure with outgoing route evidence as completed before marking idle", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.role}:${input.claudeSessionId}`);
          return {
            id: "runtime_coder",
            claudeSessionId: "claude_coder",
            taskSlug: input.taskSlug,
            role: input.role,
            status: "running",
            activityStatus: "idle",
            command: "claude --agent coder",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            lastTurnEndedAt: "2026-06-01T00:00:02.000Z",
            updatedAt: "2026-06-01T00:00:02.000Z"
          };
        }
      } as SessionService,
      messageService: {
        async listPendingRouteFiles(input) {
          calls.push(`list:${input.taskSlug}:${input.handoffDir}:${input.stateRepoRoot}`);
          return [
            {
              path: ".ai/vcm/handoffs/messages/coder-project-manager.md",
              fromRole: "coder",
              toRole: "project-manager",
              type: "result",
              body: "Done.",
              artifactRefs: [],
              exists: true,
              pending: true
            }
          ];
        },
        async scanAndDispatchPendingRouteFiles(input) {
          calls.push(`scan:${input.taskSlug}:${input.stoppedRole}:${input.handoffDir}:${input.stateRepoRoot}`);
          return [
            {
              delivered: true,
              requiresUserApproval: false,
              clearedRouteFile: true
            }
          ];
        }
      } as never,
      roundService: {
        async recordClaudeHookEvent(input) {
          calls.push(`round:${input.eventName}:${input.role}`);
          return {} as never;
        }
      } as RoundService,
      translationService: {
        async recordConversationBoundary(input) {
          calls.push(`boundary:${input.boundaryKind}:${input.role}:${input.sessionId}:${input.occurredAt}`);
          return undefined;
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub()
    });

    const result = await service.handleHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "StopFailure",
        session_id: "claude_coder",
        transcript_path: "/Users/sheldon/.claude/projects/demo/claude_coder.jsonl"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "StopFailure",
      sessionUpdated: true,
      dispatchedCount: 1
    });
    expect(calls).toEqual([
      "list:demo-task:.ai/vcm/handoffs:/repo/.claude/worktrees/demo-task",
      "session:StopFailure:coder:claude_coder",
      "round:StopFailure:coder",
      "boundary:end:coder:runtime_coder:2026-06-01T00:00:02.000Z",
      "scan:demo-task:coder:.ai/vcm/handoffs:/repo/.claude/worktrees/demo-task"
    ]);
  });

  it("schedules StopFailure retry without marking idle when no completion evidence exists", async () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    let recovery: unknown;
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async getRoleSession(_repoRoot, _taskSlug, role) {
          calls.push(`get-session:${role}`);
          return {
            id: "runtime_coder",
            claudeSessionId: "claude_coder",
            taskSlug: "demo-task",
            role,
            status: "running",
            activityStatus: "running",
            command: "claude --agent coder",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            updatedAt: "2026-06-01T00:00:00.000Z"
          };
        },
        async markRoleActivityRunning(_repoRoot, _taskSlug, role) {
          calls.push(`mark-running:${role}`);
          return undefined;
        },
        async recordClaudeHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.role}`);
          return undefined;
        }
      } as never,
      messageService: {
        async listPendingRouteFiles(input) {
          calls.push(`list:${input.taskSlug}:${input.handoffDir}:${input.stateRepoRoot}`);
          return [];
        },
        async scanAndDispatchPendingRouteFiles() {
          calls.push("scan");
          return [];
        }
      } as never,
      roundService: {
        async getSessionRoundState() {
          calls.push("round-state");
          return {
            taskSlug: "demo-task",
            status: "running",
            turnCount: 1,
            completedTurnCount: 0,
            totalRoundCount: 1,
            totalTurnCount: 1,
            totalCompletedTurnCount: 0,
            totalCcActiveMs: 0,
            currentRoundCcActiveMs: 0,
            roleRecovery: recovery,
            roles: ["coder"],
            updatedAt: "2026-06-01T00:00:00.000Z"
          } as never;
        },
        async setRoleRecovery(input) {
          recovery = input.recovery;
          calls.push(`set-recovery:${input.recovery.status}:${input.recovery.attempt}:${input.recovery.nextRetryAt}`);
          return {} as never;
        },
        async recordClaudeHookEvent() {
          calls.push("round");
          return {} as never;
        }
      } as RoundService,
      translationService: {
        async recordConversationBoundary() {
          calls.push("boundary");
          return undefined;
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub(),
      runtime: {
        write(_sessionId, data) {
          writes.push(data);
        }
      },
      now: () => "2026-06-01T00:00:00.000Z",
      retrySetTimeout(callback, delayMs) {
        timers.push({ callback, delayMs });
        return timers.length;
      },
      retryClearTimeout() {}
    });

    const result = await service.handleHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "StopFailure",
        session_id: "claude_coder",
        error: "overloaded",
        error_details: { retry_after: 60 },
        last_assistant_message: "Still working."
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "StopFailure",
      sessionUpdated: true,
      dispatchedCount: 0
    });
    expect(calls).toEqual([
      "list:demo-task:.ai/vcm/handoffs:/repo/.claude/worktrees/demo-task",
      "round-state",
      "set-recovery:waiting:1:2026-06-01T00:01:00.000Z",
      "mark-running:coder"
    ]);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(60_000);
    expect(recovery).toMatchObject({
      role: "coder",
      status: "waiting",
      attempt: 1,
      error: "overloaded",
      errorDetails: "{\"retry_after\":60}",
      lastAssistantMessage: "Still working.",
      retryable: true
    });
    expect(writes).toEqual([]);

    calls.length = 0;
    timers[0]?.callback();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls).toEqual([
      "round-state",
      "get-session:coder",
      "set-recovery:retrying:1:undefined",
      "mark-running:coder"
    ]);
    expect(writes.join("")).toContain([
      "[VCM Recovery]",
      "Previous turn ended unexpectedly. Continue from current repo + VCM handoff state.",
      "",
      "Check whether your assigned work is already complete.",
      "If complete, write the expected VCM completion artifact now.",
      "Do not repeat completed edits, validation, or route messages."
    ].join("\n"));
    expect(writes.join("\n")).not.toContain("Recovery attempt");
    expect(writes.join("\n")).not.toContain("Continue the same assigned work");
    expect(writes.at(-1)).toBe("\r");
  });

  it("does not retry non-retryable StopFailure errors", async () => {
    const calls: string[] = [];
    const writes: string[] = [];
    let recovery: unknown;
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.role}`);
          return {
            id: "runtime_coder",
            claudeSessionId: "claude_coder",
            taskSlug: input.taskSlug,
            role: input.role,
            status: "running",
            activityStatus: "idle",
            command: "claude --agent coder",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            updatedAt: "2026-06-01T00:00:00.000Z"
          };
        }
      } as never,
      messageService: {
        async listPendingRouteFiles() {
          calls.push("list");
          return [];
        }
      } as never,
      roundService: {
        async setRoleRecovery(input) {
          recovery = input.recovery;
          calls.push(`set-recovery:${input.recovery.status}:${input.recovery.attempt}:${input.recovery.error}:${input.recovery.retryable}`);
          return {} as never;
        },
        async recordClaudeHookEvent(input) {
          calls.push(`round:${input.eventName}:${input.role}`);
          return {} as never;
        }
      } as never,
      translationService: {
        async recordConversationBoundary(input) {
          calls.push(`boundary:${input.boundaryKind}:${input.role}`);
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub(),
      runtime: {
        write(_sessionId, data) {
          writes.push(data);
        }
      },
      now: () => "2026-06-01T00:00:00.000Z"
    });

    const result = await service.handleHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "StopFailure",
        session_id: "claude_coder",
        error: "billing_error",
        error_details: "Payment required",
        last_assistant_message: "Cannot continue."
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "StopFailure",
      sessionUpdated: true,
      dispatchedCount: 0
    });
    expect(calls).toEqual([
      "list",
      "set-recovery:failed:0:billing_error:false",
      "session:StopFailure:coder",
      "round:StopFailure:coder",
      "boundary:end:coder"
    ]);
    expect(recovery).toMatchObject({
      role: "coder",
      status: "failed",
      attempt: 0,
      error: "billing_error",
      errorDetails: "Payment required",
      lastAssistantMessage: "Cannot continue.",
      retryable: false,
      failedAt: "2026-06-01T00:00:00.000Z"
    });
    expect(writes).toEqual([]);
  });

  it("ends StopFailure without retry when role retry is disabled", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.role}`);
          return {
            id: "runtime_coder",
            claudeSessionId: "claude_coder",
            taskSlug: input.taskSlug,
            role: input.role,
            status: "running",
            activityStatus: "idle",
            command: "claude --agent coder",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            updatedAt: "2026-06-01T00:00:00.000Z"
          };
        }
      } as never,
      messageService: {
        async listPendingRouteFiles() {
          calls.push("list");
          return [];
        }
      } as never,
      roundService: {
        async recordClaudeHookEvent(input) {
          calls.push(`round:${input.eventName}:${input.role}`);
          return {} as never;
        }
      } as never,
      translationService: {
        async recordConversationBoundary(input) {
          calls.push(`boundary:${input.boundaryKind}:${input.role}`);
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub("off", false),
      runtime: {
        write() {
          calls.push("write");
        }
      }
    });

    const result = await service.handleHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "StopFailure",
        session_id: "claude_coder"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "StopFailure",
      sessionUpdated: true,
      dispatchedCount: 0
    });
    expect(calls).toEqual([
      "list",
      "session:StopFailure:coder",
      "round:StopFailure:coder",
      "boundary:end:coder"
    ]);
  });

  it("records PostCompact metadata without changing turn state", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.role}:${input.transcriptPath}`);
          return {
            id: "runtime_coder",
            claudeSessionId: "claude_coder",
            transcriptPath: input.transcriptPath,
            taskSlug: input.taskSlug,
            role: input.role,
            status: "running",
            activityStatus: "running",
            command: "claude --agent coder",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            lastCompactAt: "2026-06-01T00:00:02.000Z",
            updatedAt: "2026-06-01T00:00:02.000Z"
          };
        }
      } as SessionService,
      messageService: {} as MessageService,
      roundService: {
        async recordClaudeHookEvent(input) {
          calls.push(`round:${input.eventName}:${input.role}`);
          return {} as never;
        }
      } as RoundService,
      translationService: {
        async recordConversationBoundary() {
          calls.push("boundary");
          return undefined;
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub()
    });

    const result = await service.handleHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "PostCompact",
        session_id: "claude_coder",
        transcript_path: "/Users/sheldon/.claude/projects/demo/compact.jsonl"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "PostCompact",
      sessionUpdated: true,
      dispatchedCount: 0
    });
    expect(calls).toEqual([
      "session:PostCompact:coder:/Users/sheldon/.claude/projects/demo/compact.jsonl"
    ]);
  });

  it("blocks Stop and skips all turn-end bookkeeping while a validation job is running", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent() {
          calls.push("session");
          return undefined;
        }
      } as never,
      messageService: {
        async scanAndDispatchPendingRouteFiles() {
          calls.push("scan");
          return [];
        }
      } as never,
      roundService: {
        async recordClaudeHookEvent() {
          calls.push("round");
          return {} as never;
        }
      } as never,
      translationService: {
        async recordConversationBoundary() {
          calls.push("boundary");
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub(),
      jobGuard: {
        async evaluateStop(input) {
          calls.push(`guard:${input.taskSlug}:${input.role}:${input.taskRepoRoot}`);
          return {
            behavior: "block",
            reason: "VCM: validation job job-1 (running) is still running."
          };
        },
        notePromptSubmitted() {
          calls.push("guard-reset");
        }
      }
    });

    const result = await service.handleStopHook({
      taskSlug: "demo-task",
      role: "coder",
      event: { hook_event_name: "Stop", session_id: "claude_coder" }
    });

    expect(result.stopDecision).toEqual({
      behavior: "block",
      reason: "VCM: validation job job-1 (running) is still running."
    });
    expect(result).toMatchObject({ ok: true, sessionUpdated: false, dispatchedCount: 0 });
    expect(calls).toEqual(["guard:demo-task:coder:/repo/.claude/worktrees/demo-task"]);
  });

  it("never blocks Stop on the legacy combined endpoint", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent() {
          calls.push("session");
          return undefined;
        }
      } as never,
      messageService: {
        async scanAndDispatchPendingRouteFiles() {
          calls.push("scan");
          return [];
        }
      } as never,
      roundService: {
        async recordClaudeHookEvent() {
          calls.push("round");
          return {} as never;
        }
      } as never,
      translationService: {
        async recordConversationBoundary() {
          calls.push("boundary");
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub(),
      jobGuard: {
        async evaluateStop() {
          calls.push("guard");
          return { behavior: "block", reason: "should not be used" };
        },
        notePromptSubmitted() {
          calls.push("guard-reset");
        }
      }
    });

    const result = await service.handleHook({
      taskSlug: "demo-task",
      role: "coder",
      event: { hook_event_name: "Stop", session_id: "claude_coder" }
    });

    expect(result.stopDecision).toBeUndefined();
    expect(calls).toEqual(["session", "round", "scan"]);
  });

  it("resets the job-guard block counter on UserPromptSubmit", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent() {
          return undefined;
        }
      } as never,
      messageService: {
        async confirmPromptSubmitted() {
          return undefined;
        }
      } as never,
      roundService: {
        async recordClaudeHookEvent() {
          return {} as never;
        }
      } as never,
      translationService: {
        async recordConversationBoundary() {}
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub(),
      jobGuard: {
        async evaluateStop() {
          return { behavior: "allow" };
        },
        notePromptSubmitted(input) {
          calls.push(`guard-reset:${input.repoRoot}:${input.taskSlug}:${input.role}`);
        }
      }
    });

    await service.handleHook({
      taskSlug: "demo-task",
      role: "coder",
      event: { hook_event_name: "UserPromptSubmit", session_id: "claude_coder" }
    });

    expect(calls).toEqual(["guard-reset:/repo:demo-task:coder"]);
  });

  it("allows Claude Code PermissionRequest hooks when the setting is allow all", async () => {
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {} as SessionService,
      messageService: {} as MessageService,
      roundService: {} as RoundService,
      translationService: {} as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub("allowAll")
    });

    await expect(service.handlePermissionRequestHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: {
          command: "npm test"
        }
      }
    })).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow"
        }
      }
    });
  });

  it("leaves Claude Code PermissionRequest hooks untouched when the setting is off", async () => {
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {} as SessionService,
      messageService: {} as MessageService,
      roundService: {} as RoundService,
      translationService: {} as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub("off")
    });

    await expect(service.handlePermissionRequestHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: {
          command: "npm test"
        }
      }
    })).resolves.toBeUndefined();
  });

  it("routes Translator hooks to the project translation worker without VCM flow side effects", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordProjectTranslatorHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.sessionId}`);
          return {
            id: "runtime_translator",
            claudeSessionId: input.sessionId ?? "translator_session",
            taskSlug: "__project__",
            role: "translator",
            status: "running",
            activityStatus: input.eventName === "Stop" ? "idle" : "running",
            command: "claude --agent translator",
            permissionMode: "default",
            cwd: input.cwd ?? "/repo",
            terminalBackend: "node-pty",
            updatedAt: "2026-06-01T00:00:00.000Z"
          };
        }
      } as SessionService,
      messageService: {
        async confirmPromptSubmitted() {
          calls.push("message");
          return undefined;
        }
      } as unknown as MessageService,
      roundService: {
        async recordClaudeHookEvent() {
          calls.push("round");
          return {} as never;
        }
      } as RoundService,
      translationService: {
        async recordConversationBoundary() {
          calls.push("boundary");
          return undefined;
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      translationWorkerService: {
        async handleTranslatorHook(_repoRoot, eventName, taskSlug) {
          calls.push(`worker:${eventName}:${taskSlug}`);
        }
      },
      appSettings: createAppSettingsStub()
    });

    const result = await service.handleStopHook({
      taskSlug: "__project__",
      role: "translator",
      event: {
        hook_event_name: "Stop",
        session_id: "translator_session",
        cwd: "/repo"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "Stop",
      role: "translator",
      sessionUpdated: true,
      dispatchedCount: 0
    });
    expect(calls).toEqual([
      "session:Stop:translator_session",
      "worker:Stop:__project__"
    ]);
  });

  it("routes Harness Engineer Stop hooks to bootstrap completion without VCM flow side effects", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordProjectHarnessEngineerHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.sessionId}`);
          return {
            id: "runtime_harness_engineer",
            claudeSessionId: input.sessionId ?? "harness_engineer_session",
            taskSlug: "__project_harness_engineer__",
            role: "harness-engineer",
            status: "running",
            activityStatus: input.eventName === "Stop" ? "idle" : "running",
            command: "claude --agent harness-engineer",
            permissionMode: "default",
            cwd: input.cwd ?? "/repo",
            terminalBackend: "node-pty",
            updatedAt: "2026-06-01T00:00:00.000Z"
          };
        }
      } as SessionService,
      messageService: {
        async confirmPromptSubmitted() {
          calls.push("message");
          return undefined;
        }
      } as unknown as MessageService,
      roundService: {
        async recordClaudeHookEvent() {
          calls.push("round");
          return {} as never;
        }
      } as RoundService,
      translationService: {
        async recordConversationBoundary() {
          calls.push("boundary");
          return undefined;
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      harnessService: {
        async recordHarnessBootstrapHook(_repoRoot, input) {
          calls.push(`bootstrap:${input.eventName}:${input.sessionId}:${input.claudeSessionId}`);
          return {} as never;
        }
      },
      appSettings: createAppSettingsStub()
    });

    const result = await service.handleStopHook({
      taskSlug: "__project_harness_engineer__",
      role: "harness-engineer",
      event: {
        hook_event_name: "Stop",
        session_id: "harness_engineer_session",
        cwd: "/repo"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "Stop",
      role: "harness-engineer",
      sessionUpdated: true,
      dispatchedCount: 0
    });
    expect(calls).toEqual([
      "session:Stop:harness_engineer_session",
      "bootstrap:Stop:runtime_harness_engineer:harness_engineer_session"
    ]);
  });
});

function createAppSettingsStub(permissionRequestMode: "off" | "allowAll" = "off", roleRetryEnabled = true) {
  return {
    async getPreferences() {
      return {
        themeMode: "system",
        flowPauseAlerts: true,
        roleRetryEnabled,
        permissionRequestMode
      };
    }
  };
}

function createProjectServiceStub(): ProjectService {
  return {
    async getCurrentProject() {
      return {
        repoRoot: "/repo",
        branch: "main",
        isDirty: false,
        config: {
          version: 1,
          repoRoot: "/repo",
          defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
          handoffRoot: ".ai/vcm/handoffs",
          stateRoot: ".ai/vcm",
          terminalBackend: "node-pty",
          claudeCommand: "claude"
        },
        warnings: []
      };
    },
    async loadConfig() {
      return {
        version: 1,
        repoRoot: "/repo",
        defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
        handoffRoot: ".ai/vcm/handoffs",
        stateRoot: ".ai/vcm",
        terminalBackend: "node-pty",
        claudeCommand: "claude"
      };
    },
    getProjectDataRoot() {
      return "/home/.vcm/projects/demo";
    },
    getConfigPath() {
      return "/home/.vcm/projects/demo/config.json";
    },
    async connectProject() {
      throw new Error("not used");
    },
    async getRecentRepositoryPaths() {
      return [];
    },
    async saveConfig() {
      throw new Error("not used");
    }
  };
}

function createTaskServiceStub() {
  return {
    async loadTask(): Promise<TaskRecord> {
      return {
        version: 1,
        taskSlug: "demo-task",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        repoRoot: "/repo",
        worktreePath: "/repo/.claude/worktrees/demo-task",
        branch: "feature/demo-task",
        handoffDir: ".ai/vcm/handoffs",
        status: "running"
      };
    }
  } as never;
}
