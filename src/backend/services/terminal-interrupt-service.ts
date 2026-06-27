import { isVcmRoleName } from "../../shared/constants.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import type { ProjectService } from "./project-service.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";

export interface TerminalInterruptService {
  handleManualInterrupt(sessionId: string): Promise<void>;
}

export interface TerminalInterruptServiceDeps {
  runtime: TerminalRuntime;
  projectService: Pick<ProjectService, "getCurrentProject" | "loadConfig">;
  taskService: Pick<TaskService, "loadTask">;
  sessionService: Pick<SessionService, "markTerminalSessionActivityIdle">;
  roundService: Pick<RoundService, "recordManualInterrupt">;
}

export function createTerminalInterruptService(deps: TerminalInterruptServiceDeps): TerminalInterruptService {
  return {
    async handleManualInterrupt(sessionId) {
      const terminalSession = deps.runtime.getSession(sessionId);
      if (!terminalSession) {
        return;
      }

      const repoRoot = terminalSession.repoRoot ?? (await deps.projectService.getCurrentProject())?.repoRoot;
      if (!repoRoot) {
        return;
      }

      await deps.sessionService.markTerminalSessionActivityIdle(repoRoot, sessionId);

      if (!isVcmRoleName(terminalSession.role)) {
        return;
      }

      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await deps.taskService.loadTask(repoRoot, terminalSession.taskSlug);
      await deps.roundService.recordManualInterrupt({
        repoRoot,
        stateRepoRoot: getTaskRuntimeRepoRoot(task),
        stateRoot: config.stateRoot,
        taskSlug: terminalSession.taskSlug,
        role: terminalSession.role
      });
    }
  };
}
