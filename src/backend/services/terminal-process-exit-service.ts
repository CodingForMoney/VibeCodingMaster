import { isVcmRoleName } from "../../shared/constants.js";
import type { TerminalProcessExitEvent, TerminalRuntime, Unsubscribe } from "../runtime/terminal-runtime.js";
import type { ProjectService } from "./project-service.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";

export interface TerminalProcessExitService {
  start(): void;
  stop(): void;
  handleProcessExit(event: TerminalProcessExitEvent): Promise<void>;
}

export interface TerminalProcessExitServiceDeps {
  runtime: Pick<TerminalRuntime, "subscribeProcessExits">;
  projectService: Pick<ProjectService, "loadConfig">;
  taskService: Pick<TaskService, "loadTask">;
  sessionService: Pick<SessionService, "recordTerminalProcessExit">;
  roundService: Pick<RoundService, "recordTerminalExit">;
}

export function createTerminalProcessExitService(
  deps: TerminalProcessExitServiceDeps
): TerminalProcessExitService {
  let unsubscribe: Unsubscribe | undefined;

  async function handleProcessExit(event: TerminalProcessExitEvent): Promise<void> {
    const repoRoot = event.session.repoRoot;
    if (!repoRoot) {
      return;
    }

    const recorded = await deps.sessionService.recordTerminalProcessExit(repoRoot, {
      sessionId: event.session.id,
      status: event.session.status === "crashed" ? "crashed" : "exited",
      exitCode: event.exitCode
    });
    if (!recorded?.turnWasRunning || !isVcmRoleName(recorded.record.role)) {
      return;
    }

    const config = await deps.projectService.loadConfig(repoRoot);
    const task = await deps.taskService.loadTask(repoRoot, recorded.record.taskSlug);
    await deps.roundService.recordTerminalExit({
      repoRoot,
      stateRepoRoot: getTaskRuntimeRepoRoot(task),
      stateRoot: config.stateRoot,
      taskSlug: recorded.record.taskSlug,
      role: recorded.record.role
    });
  }

  return {
    start() {
      if (unsubscribe) {
        return;
      }
      unsubscribe = deps.runtime.subscribeProcessExits((event) => {
        void handleProcessExit(event).catch(() => undefined);
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
    handleProcessExit
  };
}
