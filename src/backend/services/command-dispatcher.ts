import type { DispatchRoleCommandResult } from "../../shared/types/api.js";
import type { DispatchableRole } from "../../shared/types/role.js";
import { VcmError } from "../errors.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import type { ArtifactService } from "./artifact-service.js";
import type { SessionService } from "./session-service.js";
import type { TaskService } from "./task-service.js";

export interface CommandDispatcher {
  dispatchRoleCommand(input: DispatchRoleCommandInput): Promise<DispatchRoleCommandResult>;
}

export interface DispatchRoleCommandInput {
  repoRoot: string;
  taskSlug: string;
  role: DispatchableRole;
}

export interface CommandDispatcherDeps {
  runtime: TerminalRuntime;
  sessionService: SessionService;
  taskService: TaskService;
  artifactService: ArtifactService;
  now?: () => string;
}

export function createCommandDispatcher(deps: CommandDispatcherDeps): CommandDispatcher {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async dispatchRoleCommand(input) {
      const task = await deps.taskService.loadTask(input.repoRoot, input.taskSlug);
      await deps.artifactService.readRoleCommand({
        repoRoot: input.repoRoot,
        handoffDir: task.handoffDir,
        role: input.role
      });
      const commandPath = await deps.artifactService.resolveRoleCommandPath({
        repoRoot: input.repoRoot,
        handoffDir: task.handoffDir,
        role: input.role
      });
      const session = await deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, input.role);

      if (!session || session.status !== "running") {
        throw new VcmError({
          code: "SESSION_NOT_RUNNING",
          message: `${input.role} session is not running.`,
          statusCode: 409,
          hint: `Start the ${input.role} session before sending a role command.`
        });
      }

      const instruction = `Please read and execute the role command at: ${commandPath}`;
      deps.runtime.write(session.id, `${instruction}\r`);

      return {
        taskSlug: input.taskSlug,
        role: input.role,
        commandPath,
        instruction,
        dispatchedAt: now()
      };
    }
  };
}
