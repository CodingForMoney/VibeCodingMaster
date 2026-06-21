import type {
  ClaudeHookEventName,
  ClaudeHookRequest,
  ClaudeHookResult,
  ClaudePermissionRequestHookResult
} from "../../shared/types/claude-hook.js";
import { isGateReviewerRoleName, isVcmRoleName } from "../../shared/constants.js";
import { VcmError } from "../errors.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { JobGuardService } from "./job-guard-service.js";
import type { MessageService } from "./message-service.js";
import type { ProjectService } from "./project-service.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";
import type { TranslationService } from "./translation-service.js";

const MAX_STOP_FAILURE_RECOVERY_ATTEMPTS = 2;

export interface ClaudeHookService {
  handleHook(input: ClaudeHookRequest): Promise<ClaudeHookResult>;
  handleStopHook(input: ClaudeHookRequest): Promise<ClaudeHookResult>;
  handlePermissionRequestHook(input: ClaudeHookRequest): Promise<ClaudePermissionRequestHookResult | undefined>;
}

export interface ClaudeHookServiceDeps {
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: SessionService;
  messageService: MessageService;
  roundService: RoundService;
  translationService: Pick<TranslationService, "recordConversationBoundary">;
  appSettings: Pick<AppSettingsService, "getPreferences">;
  runtime?: Pick<TerminalRuntime, "write">;
  gatewayService?: Pick<GatewayService, "handlePmStop">;
  jobGuard?: Pick<JobGuardService, "evaluateStop" | "notePromptSubmitted">;
}

export function createClaudeHookService(deps: ClaudeHookServiceDeps): ClaudeHookService {
  const stopFailureRecoveryAttempts = new Map<string, number>();

  async function getHookContext(input: ClaudeHookRequest) {
    if (!isVcmRoleName(input.role)) {
      throw new VcmError({
        code: "HOOK_ROLE_INVALID",
        message: `Unknown hook role: ${input.role}`,
        statusCode: 400
      });
    }

    const project = await deps.projectService.getCurrentProject();
    if (!project) {
      throw new VcmError({
        code: "PROJECT_NOT_CONNECTED",
        message: "Connect a repository before accepting Claude Code hooks.",
        statusCode: 409
      });
    }
    const config = await deps.projectService.loadConfig(project.repoRoot);
    const taskSlug = await resolveHookTaskSlug(project.repoRoot, input);
    const task = await deps.taskService.loadTask(project.repoRoot, taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);

    return {
      project,
      config,
      task,
      taskSlug,
      taskRepoRoot
    };
  }

  async function resolveHookTaskSlug(repoRoot: string, input: ClaudeHookRequest): Promise<string> {
    if (!isGateReviewerRoleName(input.role)) {
      return input.taskSlug;
    }

    const session = await deps.sessionService.getProjectGateReviewerSession(repoRoot);
    if (session?.activeTaskSlug) {
      return session.activeTaskSlug;
    }
    throw new VcmError({
      code: "GATE_REVIEWER_TASK_UNBOUND",
      message: "Gate Reviewer hook arrived without an active task binding.",
      statusCode: 409,
      hint: "Start or resume Gate Reviewer from the current task before submitting work."
    });
  }

  async function handleUserPromptSubmitHook(input: ClaudeHookRequest): Promise<ClaudeHookResult> {
    const eventName = parseHookEvent(input.event.hook_event_name);
    if (eventName !== "UserPromptSubmit") {
      throwUnsupportedEvent(eventName);
    }

    const context = await getHookContext(input);
    deps.jobGuard?.notePromptSubmitted({
      repoRoot: context.project.repoRoot,
      taskSlug: context.taskSlug,
      role: input.role
    });
    const session = await deps.sessionService.recordClaudeHookEvent(context.project.repoRoot, {
      taskSlug: context.taskSlug,
      role: input.role,
      eventName,
      claudeSessionId: stringOrUndefined(input.event.session_id),
      transcriptPath: stringOrUndefined(input.event.transcript_path),
      cwd: stringOrUndefined(input.event.cwd)
    });
    await deps.roundService.recordClaudeHookEvent({
      repoRoot: context.project.repoRoot,
      stateRepoRoot: context.taskRepoRoot,
      stateRoot: context.config.stateRoot,
      taskSlug: context.taskSlug,
      role: input.role,
      eventName
    });
    if (session) {
      await deps.translationService.recordConversationBoundary({
        repoRoot: context.project.repoRoot,
        taskRepoRoot: context.taskRepoRoot,
        taskSlug: context.taskSlug,
        role: input.role,
        sessionId: session.id,
        boundaryKind: "start",
        occurredAt: session.lastTurnStartedAt ?? session.updatedAt
      });
    }
    const submitted = await deps.messageService.confirmPromptSubmitted({
      repoRoot: context.project.repoRoot,
      taskRepoRoot: context.taskRepoRoot,
      stateRepoRoot: context.taskRepoRoot,
      stateRoot: context.config.stateRoot,
      handoffDir: context.task.handoffDir,
      taskSlug: context.taskSlug,
      role: input.role,
      prompt: stringOrUndefined(input.event.prompt)
    });

    return {
      ok: true,
      eventName,
      taskSlug: context.taskSlug,
      role: input.role,
      sessionUpdated: Boolean(session),
      dispatchedCount: 0,
      acceptedMessageId: submitted?.id
    };
  }

  async function processStopHook(input: ClaudeHookRequest, options: { allowBlock: boolean }): Promise<ClaudeHookResult> {
    const eventName = parseHookEvent(input.event.hook_event_name ?? "Stop");
    if (eventName !== "Stop") {
      throwUnsupportedEvent(eventName);
    }

    const context = await getHookContext(input);
    clearStopFailureRecovery(context.project.repoRoot, context.taskSlug, input.role);

    if (options.allowBlock && deps.jobGuard) {
      const verdict = await deps.jobGuard.evaluateStop({
        repoRoot: context.project.repoRoot,
        taskSlug: context.taskSlug,
        role: input.role,
        taskRepoRoot: context.taskRepoRoot
      });
      if (verdict.behavior === "block") {
        // The role turn stays alive: skip all turn-end bookkeeping so the
        // round keeps running and no route dispatch happens yet.
        return {
          ok: true,
          eventName,
          taskSlug: context.taskSlug,
          role: input.role,
          sessionUpdated: false,
          dispatchedCount: 0,
          stopDecision: { behavior: "block", reason: verdict.reason }
        };
      }
    }

    return recordTurnEnd(input, context, eventName, {
      dispatchRouteFiles: !isGateReviewerRoleName(input.role),
      notifyGateway: true,
      settleGuard: true
    });
  }

  async function processStopFailureHook(input: ClaudeHookRequest): Promise<ClaudeHookResult> {
    const eventName = parseHookEvent(input.event.hook_event_name);
    if (eventName !== "StopFailure") {
      throwUnsupportedEvent(eventName);
    }

    const context = await getHookContext(input);
    const routeDispatchInput = createRouteDispatchInput(input, context);
    const pending = await deps.messageService.listPendingRouteFiles(routeDispatchInput);
    const hasCompletionEvidence = pending.some((routeFile) => routeFile.fromRole === input.role);

    if (hasCompletionEvidence) {
      clearStopFailureRecovery(context.project.repoRoot, context.taskSlug, input.role);
      return recordTurnEnd(input, context, eventName, {
        dispatchRouteFiles: !isGateReviewerRoleName(input.role),
        notifyGateway: false,
        settleGuard: true
      });
    }

    const recovered = await dispatchStopFailureRecovery(input, context);
    if (recovered) {
      return {
        ok: true,
        eventName,
        taskSlug: context.taskSlug,
        role: input.role,
        sessionUpdated: true,
        dispatchedCount: 0
      };
    }

    return recordTurnEnd(input, context, eventName, {
      dispatchRouteFiles: false,
      notifyGateway: false,
      settleGuard: false
    });
  }

  async function processPostCompactHook(input: ClaudeHookRequest): Promise<ClaudeHookResult> {
    const eventName = parseHookEvent(input.event.hook_event_name);
    if (eventName !== "PostCompact") {
      throwUnsupportedEvent(eventName);
    }

    const context = await getHookContext(input);
    const session = await deps.sessionService.recordClaudeHookEvent(context.project.repoRoot, {
      taskSlug: context.taskSlug,
      role: input.role,
      eventName,
      claudeSessionId: stringOrUndefined(input.event.session_id),
      transcriptPath: stringOrUndefined(input.event.transcript_path),
      cwd: stringOrUndefined(input.event.cwd)
    });

    return {
      ok: true,
      eventName,
      taskSlug: context.taskSlug,
      role: input.role,
      sessionUpdated: Boolean(session),
      dispatchedCount: 0
    };
  }

  async function recordTurnEnd(
    input: ClaudeHookRequest,
    context: Awaited<ReturnType<typeof getHookContext>>,
    eventName: "Stop" | "StopFailure",
    options: {
      dispatchRouteFiles: boolean;
      notifyGateway: boolean;
      settleGuard: boolean;
    }
  ): Promise<ClaudeHookResult> {
    const scopedRouteDispatchInput = createRouteDispatchInput(input, context, input.role);
    const settleRouteDispatchInput = createRouteDispatchInput(input, context);

    const session = await deps.sessionService.recordClaudeHookEvent(context.project.repoRoot, {
      taskSlug: context.taskSlug,
      role: input.role,
      eventName,
      claudeSessionId: stringOrUndefined(input.event.session_id),
      transcriptPath: stringOrUndefined(input.event.transcript_path),
      cwd: stringOrUndefined(input.event.cwd)
    });
    await deps.roundService.recordClaudeHookEvent({
      repoRoot: context.project.repoRoot,
      stateRepoRoot: context.taskRepoRoot,
      stateRoot: context.config.stateRoot,
      taskSlug: context.taskSlug,
      role: input.role,
      eventName,
      ...(options.settleGuard
        ? {
            settleGuard: async () => {
              const pending = await deps.messageService.listPendingRouteFiles(settleRouteDispatchInput);
              if (pending.length === 0) {
                return { action: "stop" };
              }
              const retried = await deps.messageService.scanAndDispatchPendingRouteFiles(settleRouteDispatchInput);
              return retried.some((result) => result.delivered)
                ? { action: "continue", reason: "pending route message dispatched" }
                : { action: "stop" };
            }
          }
        : {})
    });
    if (session) {
      await deps.translationService.recordConversationBoundary({
        repoRoot: context.project.repoRoot,
        taskRepoRoot: context.taskRepoRoot,
        taskSlug: context.taskSlug,
        role: input.role,
        sessionId: session.id,
        boundaryKind: "end",
        occurredAt: session.lastTurnEndedAt ?? session.updatedAt
      });
    }
    if (options.notifyGateway && session && input.role === "project-manager") {
      void deps.gatewayService?.handlePmStop({
        repoRoot: context.project.repoRoot,
        taskSlug: context.taskSlug,
        session
      }).catch(() => undefined);
    }

    const dispatched = options.dispatchRouteFiles
      ? await deps.messageService.scanAndDispatchPendingRouteFiles(scopedRouteDispatchInput)
      : [];

    return {
      ok: true,
      eventName,
      taskSlug: context.taskSlug,
      role: input.role,
      sessionUpdated: Boolean(session),
      dispatchedCount: dispatched.filter((result) => result.delivered).length
    };
  }

  function createRouteDispatchInput(
    input: ClaudeHookRequest,
    context: Awaited<ReturnType<typeof getHookContext>>,
    stoppedRole?: typeof input.role
  ) {
    return {
      repoRoot: context.project.repoRoot,
      taskRepoRoot: context.taskRepoRoot,
      stateRepoRoot: context.taskRepoRoot,
      stateRoot: context.config.stateRoot,
      handoffDir: context.task.handoffDir,
      taskSlug: context.taskSlug,
      ...(stoppedRole ? { stoppedRole } : {})
    };
  }

  async function dispatchStopFailureRecovery(
    input: ClaudeHookRequest,
    context: Awaited<ReturnType<typeof getHookContext>>
  ): Promise<boolean> {
    if (!deps.runtime) {
      return false;
    }

    const key = stopFailureRecoveryKey(context.project.repoRoot, context.taskSlug, input.role);
    const attempt = (stopFailureRecoveryAttempts.get(key) ?? 0) + 1;
    if (attempt > MAX_STOP_FAILURE_RECOVERY_ATTEMPTS) {
      return false;
    }

    const session = await deps.sessionService.getRoleSession(context.project.repoRoot, context.taskSlug, input.role);
    if (!session || session.status !== "running") {
      return false;
    }

    stopFailureRecoveryAttempts.set(key, attempt);
    await submitTerminalInput(deps.runtime, session.id, renderStopFailureRecoveryPrompt(attempt));
    await deps.sessionService.markRoleActivityRunning(context.project.repoRoot, context.taskSlug, input.role);
    return true;
  }

  function clearStopFailureRecovery(repoRoot: string, taskSlug: string, role: string): void {
    stopFailureRecoveryAttempts.delete(stopFailureRecoveryKey(repoRoot, taskSlug, role));
  }

  function stopFailureRecoveryKey(repoRoot: string, taskSlug: string, role: string): string {
    return `${repoRoot}:${taskSlug}:${role}`;
  }

  function renderStopFailureRecoveryPrompt(attempt: number): string {
    return [
      "[VCM Recovery]",
      "Your previous turn ended unexpectedly after context compaction or an API error.",
      "Continue the same assigned work from the current repository and VCM handoff state.",
      "Do not repeat completed edits, duplicate validation, or duplicate route messages.",
      "If the assigned work is already complete, write/send the expected VCM handoff now.",
      `Recovery attempt: ${attempt}/${MAX_STOP_FAILURE_RECOVERY_ATTEMPTS}.`
    ].join("\n");
  }

  async function handlePermissionRequestHook(input: ClaudeHookRequest): Promise<ClaudePermissionRequestHookResult | undefined> {
    if (!isVcmRoleName(input.role)) {
      throw new VcmError({
        code: "HOOK_ROLE_INVALID",
        message: `Unknown hook role: ${input.role}`,
        statusCode: 400
      });
    }
    const eventName = input.event.hook_event_name;
    if (eventName !== "PermissionRequest") {
      throw new VcmError({
        code: "HOOK_EVENT_UNSUPPORTED",
        message: `Unsupported Claude Code permission hook event: ${String(eventName)}`,
        statusCode: 400,
        hint: "Use this endpoint for Claude Code PermissionRequest hooks only."
      });
    }

    const preferences = await deps.appSettings.getPreferences();
    if (preferences.permissionRequestMode !== "allowAll") {
      return undefined;
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow"
        }
      }
    };
  }

  return {
    async handleHook(input) {
      const eventName = parseHookEvent(input.event.hook_event_name);
      if (eventName === "UserPromptSubmit") {
        return handleUserPromptSubmitHook(input);
      }
      if (eventName === "StopFailure") {
        return processStopFailureHook(input);
      }
      if (eventName === "PostCompact") {
        return processPostCompactHook(input);
      }
      // Legacy combined endpoint: the installed hook discards the response,
      // so a block decision could not be enforced. Never block here.
      return processStopHook(input, { allowBlock: false });
    },
    handleStopHook(input) {
      return processStopHook(input, { allowBlock: true });
    },
    handlePermissionRequestHook
  };
}

function parseHookEvent(value: unknown): ClaudeHookEventName {
  if (value === "UserPromptSubmit" || value === "Stop" || value === "StopFailure" || value === "PostCompact") {
    return value;
  }
  throw new VcmError({
    code: "HOOK_EVENT_UNSUPPORTED",
    message: `Unsupported Claude Code hook event: ${String(value)}`,
    statusCode: 400,
    hint: "VCM accepts UserPromptSubmit, Stop, StopFailure, and PostCompact hooks only."
  });
}

function throwUnsupportedEvent(eventName: ClaudeHookEventName): never {
  throw new VcmError({
    code: "HOOK_EVENT_UNSUPPORTED",
    message: `Unsupported Claude Code hook event: ${eventName}`,
    statusCode: 400,
    hint: "Use the matching VCM hook endpoint for this event."
  });
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
