import type {
  CodexHookRequest,
  CodexHookResult
} from "../../shared/types/codex-hook.js";
import { isCodexRoleName } from "../../shared/constants.js";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import { VcmError } from "../errors.js";
import type { ProjectService } from "./project-service.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import type { CodexTranslationService } from "./codex-translation-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";

export interface CodexHookService {
  handleHook(input: CodexHookRequest): Promise<CodexHookResult>;
  handleStopHook(input: CodexHookRequest): Promise<CodexHookResult>;
}

export interface CodexHookServiceDeps {
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: Pick<SessionService, "recordRoleHookEvent">;
  roundService: Pick<RoundService, "recordRoleTurnEvent">;
  codexTranslationService?: Pick<CodexTranslationService, "handleCodexHook">;
}

export function createCodexHookService(deps: CodexHookServiceDeps): CodexHookService {
  async function getHookContext(input: CodexHookRequest) {
    if (!isCodexRoleName(input.role)) {
      throw new VcmError({
        code: "CODEX_HOOK_ROLE_INVALID",
        message: `Unknown Codex hook role: ${input.role}`,
        statusCode: 400
      });
    }

    const project = await deps.projectService.getCurrentProject();
    if (!project) {
      throw new VcmError({
        code: "PROJECT_NOT_CONNECTED",
        message: "Connect a repository before accepting Codex hooks.",
        statusCode: 409
      });
    }
    const config = await deps.projectService.loadConfig(project.repoRoot);
    const task = await deps.taskService.loadTask(project.repoRoot, input.taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);

    return {
      project,
      config,
      taskRepoRoot
    };
  }

  async function processHook(input: CodexHookRequest, expectedEventName: ClaudeHookEventName): Promise<CodexHookResult> {
    const eventName = parseHookEvent(input.event.hook_event_name);
    if (eventName !== expectedEventName) {
      throw new VcmError({
        code: "CODEX_HOOK_EVENT_UNSUPPORTED",
        message: `Unsupported Codex hook event for this endpoint: ${eventName}`,
        statusCode: 400
      });
    }

    const context = await getHookContext(input);
    const session = await deps.sessionService.recordRoleHookEvent(context.project.repoRoot, {
      taskSlug: input.taskSlug,
      role: input.role,
      eventName,
      sessionId: stringOrUndefined(input.event.session_id),
      transcriptPath: stringOrUndefined(input.event.transcript_path),
      cwd: stringOrUndefined(input.event.cwd),
      allowSessionMismatch: true
    });
    await deps.roundService.recordRoleTurnEvent({
      repoRoot: context.project.repoRoot,
      stateRepoRoot: context.taskRepoRoot,
      stateRoot: context.config.stateRoot,
      taskSlug: input.taskSlug,
      role: input.role,
      eventName
    });
    if (input.role === "codex-translator") {
      await deps.codexTranslationService?.handleCodexHook(context.project.repoRoot, eventName, input.taskSlug);
    }

    return {
      ok: true,
      eventName,
      taskSlug: input.taskSlug,
      role: input.role,
      sessionUpdated: Boolean(session)
    };
  }

  return {
    handleHook(input) {
      return processHook(input, "UserPromptSubmit");
    },
    handleStopHook(input) {
      return processHook(input, "Stop");
    }
  };
}

function parseHookEvent(value: unknown): ClaudeHookEventName {
  if (value === "UserPromptSubmit" || value === "Stop") {
    return value;
  }
  throw new VcmError({
    code: "CODEX_HOOK_EVENT_UNSUPPORTED",
    message: `Unsupported Codex hook event: ${String(value)}`,
    statusCode: 400,
    hint: "VCM accepts Codex UserPromptSubmit and Stop hooks only."
  });
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
