import type { ClaudeHookEventName, ClaudeHookRequest, ClaudeHookResult } from "../../shared/types/claude-hook.js";
import { isRoleName } from "../../shared/constants.js";
import { VcmError } from "../errors.js";
import type { MessageService } from "./message-service.js";
import type { ProjectService } from "./project-service.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";
import type { TranslationService } from "./translation-service.js";

export interface ClaudeHookService {
  handleHook(input: ClaudeHookRequest): Promise<ClaudeHookResult>;
  handleStopHook(input: ClaudeHookRequest): Promise<ClaudeHookResult>;
}

export interface ClaudeHookServiceDeps {
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: SessionService;
  messageService: MessageService;
  roundService: RoundService;
  translationService: Pick<TranslationService, "recordConversationBoundary">;
}

export function createClaudeHookService(deps: ClaudeHookServiceDeps): ClaudeHookService {
  async function getHookContext(input: ClaudeHookRequest) {
    if (!isRoleName(input.role)) {
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
    const session = await deps.sessionService.recordClaudeHookEvent(context.project.repoRoot, {
      taskSlug: input.taskSlug,
      role: input.role,
      eventName,
      claudeSessionId: stringOrUndefined(input.event.session_id),
      transcriptPath: stringOrUndefined(input.event.transcript_path),
      cwd: stringOrUndefined(input.event.cwd)
    });
    await deps.roundService.recordClaudeHookEvent({
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
        occurredAt: session.lastPromptSubmittedAt ?? session.updatedAt
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

  async function handleStopHook(input: ClaudeHookRequest): Promise<ClaudeHookResult> {
    const eventName = parseHookEvent(input.event.hook_event_name ?? "Stop");
    if (eventName !== "Stop") {
      throwUnsupportedEvent(eventName);
    }

    const context = await getHookContext(input);

    const session = await deps.sessionService.recordClaudeHookEvent(context.project.repoRoot, {
      taskSlug: input.taskSlug,
      role: input.role,
      eventName,
      claudeSessionId: stringOrUndefined(input.event.session_id),
      transcriptPath: stringOrUndefined(input.event.transcript_path),
      cwd: stringOrUndefined(input.event.cwd)
    });
    await deps.roundService.recordClaudeHookEvent({
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
        boundaryKind: "end",
        occurredAt: session.lastStopAt ?? session.updatedAt
      });
    }

    const dispatched = await deps.messageService.scanAndDispatchPendingRouteFiles({
      repoRoot: context.project.repoRoot,
      taskRepoRoot: context.taskRepoRoot,
      stateRepoRoot: context.taskRepoRoot,
      stateRoot: context.config.stateRoot,
      handoffDir: context.task.handoffDir,
      taskSlug: input.taskSlug,
      stoppedRole: input.role
    });

    return {
      ok: true,
      eventName,
      taskSlug: input.taskSlug,
      role: input.role,
      sessionUpdated: Boolean(session),
      dispatchedCount: dispatched.filter((result) => result.delivered).length
    };
  }

  return {
    async handleHook(input) {
      const eventName = parseHookEvent(input.event.hook_event_name);
      if (eventName === "UserPromptSubmit") {
        return handleUserPromptSubmitHook(input);
      }
      return handleStopHook(input);
    },
    handleStopHook
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
