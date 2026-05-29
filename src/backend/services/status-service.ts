import type { TaskStatusReport } from "../../shared/types/api.js";
import type { ArtifactService } from "./artifact-service.js";
import type { SessionService } from "./session-service.js";
import type { TaskService } from "./task-service.js";

export interface StatusService {
  getTaskStatus(repoRoot: string, taskSlug: string): Promise<TaskStatusReport>;
}

export interface StatusServiceDeps {
  taskService: TaskService;
  sessionService: SessionService;
  artifactService: ArtifactService;
}

export function createStatusService(deps: StatusServiceDeps): StatusService {
  return {
    async getTaskStatus(repoRoot, taskSlug) {
      const task = await deps.taskService.loadTask(repoRoot, taskSlug);
      const artifacts = await deps.artifactService.listArtifacts({
        repoRoot,
        handoffDir: task.handoffDir
      });
      const sessions = await deps.sessionService.listRoleSessions(repoRoot, taskSlug);
      const warnings = artifacts.checks
        .filter((check) => check.status !== "ok")
        .map((check) => `${check.path}: ${check.status}`);

      return {
        task,
        sessions,
        artifacts,
        warnings
      };
    }
  };
}
