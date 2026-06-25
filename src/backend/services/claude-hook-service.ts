import type {
  ClaudeHookEventName,
  ClaudeHookRequest,
  ClaudeHookResult,
  ClaudePermissionRequestHookResult
} from "../../shared/types/claude-hook.js";
import { isGateReviewerRoleName, isHarnessEngineerToolRoleName, isTranslatorToolRoleName, isVcmRoleName } from "../../shared/constants.js";
import { VcmError } from "../errors.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { HarnessService } from "./harness-service.js";
import type { HarnessFeedbackService } from "./harness-feedback-service.js";
import type { JobGuardService } from "./job-guard-service.js";
import type { MessageService } from "./message-service.js";
import type { ProjectService } from "./project-service.js";
import type { RoundService } from "./round-service.js";
import type { RoleName } from "../../shared/types/role.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";
import type { TranslationService } from "./translation-service.js";
import type { TranslationWorkerService } from "./translation-worker-service.js";

const MAX_ROLE_RETRY_ATTEMPTS = 20;
const ROLE_RETRY_BASE_DELAY_MS = 60_000;
const NON_RETRYABLE_STOP_FAILURE_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "invalid_request",
  "model_not_found",
  "max_output_tokens"
]);
const DIAGNOSTIC_SNIPPET_MAX_LENGTH = 2000;
type StopFailureRetryTimer = ReturnType<typeof setTimeout>;

interface StopFailureDiagnostic {
  error: string;
  errorDetails?: string;
  lastAssistantMessage?: string;
  retryable: boolean;
}

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
  translationWorkerService?: Pick<TranslationWorkerService, "handleTranslatorHook">;
  appSettings: Pick<AppSettingsService, "getPreferences">;
  runtime?: Pick<TerminalRuntime, "write">;
  now?: () => string;
  retrySetTimeout?: (callback: () => void, delayMs: number) => StopFailureRetryTimer;
  retryClearTimeout?: (timer: StopFailureRetryTimer) => void;
  harnessService?: Pick<HarnessService, "recordHarnessBootstrapHook">;
  harnessFeedbackService?: Pick<HarnessFeedbackService, "recordHarnessEngineerHook">;
  gatewayService?: Pick<GatewayService, "handlePmStop">;
  jobGuard?: Pick<JobGuardService, "evaluateStop" | "notePromptSubmitted">;
}

export function createClaudeHookService(deps: ClaudeHookServiceDeps): ClaudeHookService {
  const stopFailureRetryTimers = new Map<string, StopFailureRetryTimer>();
  const now = deps.now ?? (() => new Date().toISOString());
  const retrySetTimeout = deps.retrySetTimeout ?? ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
  const retryClearTimeout = deps.retryClearTimeout ?? ((timer: StopFailureRetryTimer) => globalThis.clearTimeout(timer));

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

  async function getTranslatorHookContext() {
    const project = await deps.projectService.getCurrentProject();
    if (!project) {
      throw new VcmError({
        code: "PROJECT_NOT_CONNECTED",
        message: "Connect a repository before accepting Translator hooks.",
        statusCode: 409
      });
    }
    return { project };
  }

  async function getProjectToolHookContext(toolLabel: string) {
    const project = await deps.projectService.getCurrentProject();
    if (!project) {
      throw new VcmError({
        code: "PROJECT_NOT_CONNECTED",
        message: `Connect a repository before accepting ${toolLabel} hooks.`,
        statusCode: 409
      });
    }
    return { project };
  }

  async function processTranslatorHook(input: ClaudeHookRequest): Promise<ClaudeHookResult> {
    const eventName = parseHookEvent(input.event.hook_event_name);
    const context = await getTranslatorHookContext();
    const session = await deps.sessionService.recordProjectTranslatorHookEvent(context.project.repoRoot, {
      eventName,
      sessionId: stringOrUndefined(input.event.session_id),
      transcriptPath: stringOrUndefined(input.event.transcript_path),
      cwd: stringOrUndefined(input.event.cwd) ?? stringOrUndefined(input.event.new_cwd)
    });
    await deps.translationWorkerService?.handleTranslatorHook(context.project.repoRoot, eventName, input.taskSlug);
    return {
      ok: true,
      eventName,
      taskSlug: input.taskSlug,
      role: input.role,
      sessionUpdated: Boolean(session),
      dispatchedCount: 0
    };
  }

  async function processHarnessEngineerHook(input: ClaudeHookRequest): Promise<ClaudeHookResult> {
    const eventName = parseHookEvent(input.event.hook_event_name);
    const context = await getProjectToolHookContext("Harness Engineer");
    const session = await deps.sessionService.recordProjectHarnessEngineerHookEvent(context.project.repoRoot, {
      eventName,
      sessionId: stringOrUndefined(input.event.session_id),
      transcriptPath: stringOrUndefined(input.event.transcript_path),
      cwd: stringOrUndefined(input.event.cwd) ?? stringOrUndefined(input.event.new_cwd)
    });
    await deps.harnessService?.recordHarnessBootstrapHook(context.project.repoRoot, {
      eventName,
      sessionId: session?.id,
      claudeSessionId: stringOrUndefined(input.event.session_id)
    });
    await deps.harnessFeedbackService?.recordHarnessEngineerHook(context.project.repoRoot, eventName);
    return {
      ok: true,
      eventName,
      taskSlug: input.taskSlug,
      role: input.role,
      sessionUpdated: Boolean(session),
      dispatchedCount: 0
    };
  }

  async function resolveHookTaskSlug(repoRoot: string, input: ClaudeHookRequest): Promise<string> {
    void repoRoot;
    return input.taskSlug;
  }

  // Defensive task-binding guard: only mutate a task's round/status when the
  // posting role's authoritative session record is bound to that task. A session
  // whose record reports a different slug (e.g. a project-scoped sentinel session)
  // must not resume or clobber an unrelated task's flow. Absence of a record is
  // not proof of misattribution, so the normal flow proceeds.
  async function isHookSessionBoundToTask(
    context: Awaited<ReturnType<typeof getHookContext>>,
    role: RoleName
  ): Promise<boolean> {
    const session = await deps.sessionService.getRoleSession(
      context.project.repoRoot,
      context.taskSlug,
      role
    );
    return !session || session.taskSlug === context.taskSlug;
  }

  async function handleUserPromptSubmitHook(input: ClaudeHookRequest): Promise<ClaudeHookResult> {
    const eventName = parseHookEvent(input.event.hook_event_name);
    if (eventName !== "UserPromptSubmit") {
      throwUnsupportedEvent(eventName);
    }

    const context = await getHookContext(input);
    const boundToTask = await isHookSessionBoundToTask(context, input.role);
    if (boundToTask) {
      deps.jobGuard?.notePromptSubmitted({
        repoRoot: context.project.repoRoot,
        taskSlug: context.taskSlug,
        role: input.role
      });
    }
    const session = await deps.sessionService.recordClaudeHookEvent(context.project.repoRoot, {
      taskSlug: context.taskSlug,
      role: input.role,
      eventName,
      claudeSessionId: stringOrUndefined(input.event.session_id),
      transcriptPath: stringOrUndefined(input.event.transcript_path),
      cwd: stringOrUndefined(input.event.cwd) ?? stringOrUndefined(input.event.new_cwd)
    });
    if (boundToTask) {
      await deps.roundService.recordClaudeHookEvent({
        repoRoot: context.project.repoRoot,
        stateRepoRoot: context.taskRepoRoot,
        stateRoot: context.config.stateRoot,
        taskSlug: context.taskSlug,
        role: input.role,
        eventName
      });
    }
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
    await clearStopFailureRecoveryState(context, input.role);

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
      await clearStopFailureRecoveryState(context, input.role);
      return recordTurnEnd(input, context, eventName, {
        dispatchRouteFiles: !isGateReviewerRoleName(input.role),
        notifyGateway: false,
        settleGuard: true
      });
    }

    const failure = parseStopFailureDiagnostic(input.event);
    if (!failure.retryable) {
      await markStopFailureRecoveryFailed(input, context, failure, 0);
      return recordTurnEnd(input, context, eventName, {
        dispatchRouteFiles: false,
        notifyGateway: false,
        settleGuard: false
      });
    }

    const retryScheduled = await scheduleStopFailureRetry(input, context, failure);
    if (retryScheduled) {
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
      cwd: stringOrUndefined(input.event.cwd) ?? stringOrUndefined(input.event.new_cwd)
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

    const boundToTask = await isHookSessionBoundToTask(context, input.role);
    const session = await deps.sessionService.recordClaudeHookEvent(context.project.repoRoot, {
      taskSlug: context.taskSlug,
      role: input.role,
      eventName,
      claudeSessionId: stringOrUndefined(input.event.session_id),
      transcriptPath: stringOrUndefined(input.event.transcript_path),
      cwd: stringOrUndefined(input.event.cwd) ?? stringOrUndefined(input.event.new_cwd)
    });
    if (boundToTask) {
      // VCM:CODE SCF-106: when eventName === "Stop" && isUserFacingRole(input.role) && session,
      // best-effort capture the role's last user-facing turn text via
      // readLatestRoleTurnReply(session) (import from ./claude-transcript-reply.js) and pass it
      // as `userFacingReply: { text, truncated }` into the roundService.recordClaudeHookEvent
      // call below. Capture failure (undefined) must not block turn-end; just omit the field.
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
    }
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

  async function scheduleStopFailureRetry(
    input: ClaudeHookRequest,
    context: Awaited<ReturnType<typeof getHookContext>>,
    failure: StopFailureDiagnostic
  ): Promise<boolean> {
    const preferences = await deps.appSettings.getPreferences();
    if (!preferences.roleRetryEnabled || !deps.runtime) {
      return false;
    }

    const stateInput = createRoundStateInput(context);
    const currentRoundState = await deps.roundService.getSessionRoundState(stateInput);
    const previousAttempt = currentRoundState.roleRecovery?.role === input.role &&
      currentRoundState.roleRecovery.status !== "failed"
      ? currentRoundState.roleRecovery.attempt
      : 0;
    const attempt = previousAttempt + 1;
    const timestamp = now();

    if (attempt > MAX_ROLE_RETRY_ATTEMPTS) {
      clearStopFailureRetryTimer(context.project.repoRoot, context.taskSlug, input.role);
      await markStopFailureRecoveryFailed(input, context, failure, MAX_ROLE_RETRY_ATTEMPTS, timestamp);
      return false;
    }

    const nextRetryAt = new Date(Date.parse(timestamp) + attempt * ROLE_RETRY_BASE_DELAY_MS).toISOString();
    await deps.roundService.setRoleRecovery({
      ...stateInput,
      recovery: {
        role: input.role,
        status: "waiting",
        attempt,
        maxAttempts: MAX_ROLE_RETRY_ATTEMPTS,
        lastFailureAt: timestamp,
        error: failure.error,
        errorDetails: failure.errorDetails,
        lastAssistantMessage: failure.lastAssistantMessage,
        retryable: failure.retryable,
        nextRetryAt
      }
    });
    await deps.sessionService.markRoleActivityRunning(context.project.repoRoot, context.taskSlug, input.role);
    scheduleStopFailureRetryTimer(input, context, attempt, nextRetryAt);
    return true;
  }

  function scheduleStopFailureRetryTimer(
    input: ClaudeHookRequest,
    context: Awaited<ReturnType<typeof getHookContext>>,
    attempt: number,
    nextRetryAt: string
  ): void {
    const key = stopFailureRecoveryKey(context.project.repoRoot, context.taskSlug, input.role);
    clearStopFailureRetryTimer(context.project.repoRoot, context.taskSlug, input.role);
    const delayMs = Math.max(0, Date.parse(nextRetryAt) - Date.parse(now()));
    const timer = retrySetTimeout(() => {
      stopFailureRetryTimers.delete(key);
      void runScheduledStopFailureRetry(input, context, attempt).catch(() => undefined);
    }, delayMs);
    stopFailureRetryTimers.set(key, timer);
  }

  async function runScheduledStopFailureRetry(
    input: ClaudeHookRequest,
    context: Awaited<ReturnType<typeof getHookContext>>,
    attempt: number
  ): Promise<void> {
    const stateInput = createRoundStateInput(context);
    const currentRoundState = await deps.roundService.getSessionRoundState(stateInput);
    const recovery = currentRoundState.roleRecovery;
    if (!recovery || recovery.role !== input.role || recovery.attempt !== attempt || recovery.status !== "waiting") {
      return;
    }

    const timestamp = now();
    const session = await deps.sessionService.getRoleSession(context.project.repoRoot, context.taskSlug, input.role);
    if (!session || session.status !== "running" || !deps.runtime) {
      await deps.roundService.setRoleRecovery({
        ...stateInput,
        recovery: {
          ...recovery,
          status: "failed",
          failedAt: timestamp
        }
      });
      await recordTurnEnd(input, context, "StopFailure", {
        dispatchRouteFiles: false,
        notifyGateway: false,
        settleGuard: false
      });
      return;
    }

    await deps.roundService.setRoleRecovery({
      ...stateInput,
      recovery: {
        ...recovery,
        status: "retrying",
        nextRetryAt: undefined,
        lastRetryAt: timestamp
      }
    });
    await submitTerminalInput(deps.runtime, session.id, renderStopFailureRecoveryPrompt());
    await deps.sessionService.markRoleActivityRunning(context.project.repoRoot, context.taskSlug, input.role);
  }

  async function markStopFailureRecoveryFailed(
    input: ClaudeHookRequest,
    context: Awaited<ReturnType<typeof getHookContext>>,
    failure: StopFailureDiagnostic,
    attempt: number,
    timestamp = now()
  ): Promise<void> {
    clearStopFailureRetryTimer(context.project.repoRoot, context.taskSlug, input.role);
    await deps.roundService.setRoleRecovery({
      ...createRoundStateInput(context),
      recovery: {
        role: input.role,
        status: "failed",
        attempt,
        maxAttempts: MAX_ROLE_RETRY_ATTEMPTS,
        lastFailureAt: timestamp,
        error: failure.error,
        errorDetails: failure.errorDetails,
        lastAssistantMessage: failure.lastAssistantMessage,
        retryable: failure.retryable,
        failedAt: timestamp
      }
    });
  }

  function clearStopFailureRecovery(repoRoot: string, taskSlug: string, role: string): void {
    clearStopFailureRetryTimer(repoRoot, taskSlug, role);
  }

  async function clearStopFailureRecoveryState(
    context: Awaited<ReturnType<typeof getHookContext>>,
    role: RoleName
  ): Promise<void> {
    clearStopFailureRecovery(context.project.repoRoot, context.taskSlug, role);
    await deps.roundService.clearRoleRecovery?.({
      ...createRoundStateInput(context),
      role
    });
  }

  function clearStopFailureRetryTimer(repoRoot: string, taskSlug: string, role: string): void {
    const key = stopFailureRecoveryKey(repoRoot, taskSlug, role);
    const timer = stopFailureRetryTimers.get(key);
    if (timer === undefined) {
      return;
    }
    retryClearTimeout(timer);
    stopFailureRetryTimers.delete(key);
  }

  function stopFailureRecoveryKey(repoRoot: string, taskSlug: string, role: string): string {
    return `${repoRoot}:${taskSlug}:${role}`;
  }

  function createRoundStateInput(context: Awaited<ReturnType<typeof getHookContext>>) {
    return {
      repoRoot: context.project.repoRoot,
      stateRepoRoot: context.taskRepoRoot,
      stateRoot: context.config.stateRoot,
      taskSlug: context.taskSlug
    };
  }

  function renderStopFailureRecoveryPrompt(): string {
    return [
      "[VCM Recovery]",
      "Previous turn ended unexpectedly. Continue from current repo + VCM handoff state.",
      "",
      "Check whether your assigned work is already complete.",
      "If complete, write the expected VCM completion artifact now.",
      "Do not repeat completed edits, validation, or route messages."
    ].join("\n");
  }

  async function handlePermissionRequestHook(input: ClaudeHookRequest): Promise<ClaudePermissionRequestHookResult | undefined> {
    if (!isVcmRoleName(input.role)) {
      if (isTranslatorToolRoleName(input.role) || isHarnessEngineerToolRoleName(input.role)) {
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
      if (isTranslatorToolRoleName(input.role)) {
        return processTranslatorHook(input);
      }
      if (isHarnessEngineerToolRoleName(input.role)) {
        return processHarnessEngineerHook(input);
      }
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
      if (isTranslatorToolRoleName(input.role)) {
        return processTranslatorHook(input);
      }
      if (isHarnessEngineerToolRoleName(input.role)) {
        return processHarnessEngineerHook(input);
      }
      return processStopHook(input, { allowBlock: true });
    },
    handlePermissionRequestHook
  };
}

function parseHookEvent(value: unknown): ClaudeHookEventName {
  if (
    value === "UserPromptSubmit"
    || value === "Stop"
    || value === "StopFailure"
    || value === "PostCompact"
  ) {
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

function parseStopFailureDiagnostic(event: ClaudeHookRequest["event"]): StopFailureDiagnostic {
  const error = (normalizeDiagnosticString(event.error, 200) ?? "unknown").toLowerCase();
  const errorDetails = normalizeDiagnosticString(event.error_details, DIAGNOSTIC_SNIPPET_MAX_LENGTH);
  const lastAssistantMessage = normalizeDiagnosticString(event.last_assistant_message, DIAGNOSTIC_SNIPPET_MAX_LENGTH);
  return {
    error,
    errorDetails,
    lastAssistantMessage,
    retryable: !NON_RETRYABLE_STOP_FAILURE_ERRORS.has(error)
  };
}

function normalizeDiagnosticString(value: unknown, maxLength: number): string | undefined {
  let text: string | undefined;
  if (typeof value === "string") {
    text = value;
  } else if (value !== undefined && value !== null) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength)}...`
    : trimmed;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
