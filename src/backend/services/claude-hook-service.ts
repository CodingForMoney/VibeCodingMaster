import type {
  ClaudeHookEventName,
  ClaudeHookRequest,
  ClaudeHookResult,
  ClaudePermissionRequestHookResult
} from "../../shared/types/claude-hook.js";
import { isVcmRoleName } from "../../shared/constants.js";
import { VcmError } from "../errors.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { JobGuardService } from "./job-guard-service.js";
import type { MessageService } from "./message-service.js";
import type { ProjectService } from "./project-service.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";
import type { TranslationService } from "./translation-service.js";

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
  gatewayService?: Pick<GatewayService, "handlePmStop">;
  jobGuard?: Pick<JobGuardService, "evaluateStop" | "notePromptSubmitted">;
}

export function createClaudeHookService(deps: ClaudeHookServiceDeps): ClaudeHookService {
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
    const task = await deps.taskService.loadTask(project.repoRoot, input.taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);

    return {
      project,
      config,
      task,
      taskRepoRoot
    };
  }

  async function handleUserPromptSubmitHook(input: ClaudeHookRequest): Promise<ClaudeHookResult> {
    const eventName = parseHookEvent(input.event.hook_event_name);
    if (eventName !== "UserPromptSubmit") {
      throwUnsupportedEvent(eventName);
    }

    const context = await getHookContext(input);
    deps.jobGuard?.notePromptSubmitted({
      repoRoot: context.project.repoRoot,
      taskSlug: input.taskSlug,
      role: input.role
    });
    const session = await deps.sessionService.recordClaudeHookEvent(context.project.repoRoot, {
      taskSlug: input.taskSlug,
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
      taskSlug: input.taskSlug,
      role: input.role,
      eventName
    });
    if (session) {
      await deps.translationService.recordConversationBoundary({
        repoRoot: context.project.repoRoot,
        taskRepoRoot: context.taskRepoRoot,
        taskSlug: input.taskSlug,
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
      taskSlug: input.taskSlug,
      role: input.role,
      prompt: stringOrUndefined(input.event.prompt)
    });

    return {
      ok: true,
      eventName,
      taskSlug: input.taskSlug,
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

    if (options.allowBlock && deps.jobGuard) {
      const verdict = await deps.jobGuard.evaluateStop({
        repoRoot: context.project.repoRoot,
        taskSlug: input.taskSlug,
        role: input.role,
        taskRepoRoot: context.taskRepoRoot
      });
      if (verdict.behavior === "block") {
        // The role turn stays alive: skip all turn-end bookkeeping so the
        // round keeps running and no route dispatch happens yet.
        return {
          ok: true,
          eventName,
          taskSlug: input.taskSlug,
          role: input.role,
          sessionUpdated: false,
          dispatchedCount: 0,
          stopDecision: { behavior: "block", reason: verdict.reason }
        };
      }
    }

    const scopedRouteDispatchInput = {
      repoRoot: context.project.repoRoot,
      taskRepoRoot: context.taskRepoRoot,
      stateRepoRoot: context.taskRepoRoot,
      stateRoot: context.config.stateRoot,
      handoffDir: context.task.handoffDir,
      taskSlug: input.taskSlug,
      stoppedRole: input.role
    };
    const settleRouteDispatchInput = {
      repoRoot: context.project.repoRoot,
      taskRepoRoot: context.taskRepoRoot,
      stateRepoRoot: context.taskRepoRoot,
      stateRoot: context.config.stateRoot,
      handoffDir: context.task.handoffDir,
      taskSlug: input.taskSlug
    };

    const session = await deps.sessionService.recordClaudeHookEvent(context.project.repoRoot, {
      taskSlug: input.taskSlug,
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
      taskSlug: input.taskSlug,
      role: input.role,
      eventName,
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
    });
    if (session) {
      await deps.translationService.recordConversationBoundary({
        repoRoot: context.project.repoRoot,
        taskRepoRoot: context.taskRepoRoot,
        taskSlug: input.taskSlug,
        role: input.role,
        sessionId: session.id,
        boundaryKind: "end",
        occurredAt: session.lastTurnEndedAt ?? session.updatedAt
      });
    }
    if (session && input.role === "project-manager") {
      void deps.gatewayService?.handlePmStop({
        repoRoot: context.project.repoRoot,
        taskSlug: input.taskSlug,
        session
      }).catch(() => undefined);
    }

    const dispatched = await deps.messageService.scanAndDispatchPendingRouteFiles(scopedRouteDispatchInput);

    return {
      ok: true,
      eventName,
      taskSlug: input.taskSlug,
      role: input.role,
      sessionUpdated: Boolean(session),
      dispatchedCount: dispatched.filter((result) => result.delivered).length
    };
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
  if (value === "UserPromptSubmit" || value === "Stop") {
    return value;
  }
  throw new VcmError({
    code: "HOOK_EVENT_UNSUPPORTED",
    message: `Unsupported Claude Code hook event: ${String(value)}`,
    statusCode: 400,
    hint: "VCM accepts UserPromptSubmit and Stop hooks only."
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
