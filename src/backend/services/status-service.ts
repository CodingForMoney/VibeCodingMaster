import { DISPATCHABLE_ROLES, ROLE_NAMES } from "../../shared/constants.js";
import type { ArtifactSummary } from "../../shared/types/artifact.js";
import type { TaskStatusReport } from "../../shared/types/api.js";
import type { DispatchableRole, RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import type { ArtifactService } from "./artifact-service.js";
import { isOpenFileLimitError } from "../errors.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";

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
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      const warnings: string[] = [];
      let artifacts: ArtifactSummary;
      let sessions: RoleSessionRecord[] = [];

      try {
        artifacts = await deps.artifactService.listArtifacts({
          repoRoot: taskRepoRoot,
          handoffDir: task.handoffDir
        });
      } catch (error) {
        if (!isOpenFileLimitError(error)) {
          throw error;
        }
        artifacts = degradedArtifactSummary(task.handoffDir);
        warnings.push(`Artifacts are temporarily unavailable because the backend hit the open-files limit: ${errorMessage(error)}`);
      }

      try {
        sessions = await deps.sessionService.listRoleSessions(repoRoot, taskSlug);
      } catch (error) {
        if (!isOpenFileLimitError(error)) {
          throw error;
        }
        warnings.push(`Role sessions are temporarily unavailable because the backend hit the open-files limit: ${errorMessage(error)}`);
      }

      warnings.push(...artifacts.checks
        .filter((check) => check.status !== "ok")
        .map((check) => `${check.path}: ${check.status}`));

      return {
        task,
        sessions,
        artifacts,
        warnings
      };
    }
  };
}

function degradedArtifactSummary(handoffDir: string): ArtifactSummary {
  const roleCommandsDir = `${handoffDir}/role-commands`;
  const logsDir = `${handoffDir}/logs`;
  const messagesDir = `${handoffDir}/messages`;
  return {
    paths: {
      handoffDir,
      roleCommandsDir,
      logsDir,
      messagesDir,
      roleCommandPaths: Object.fromEntries(
        DISPATCHABLE_ROLES.map((role) => [role, `${roleCommandsDir}/${role}.md`])
      ) as Record<DispatchableRole, string>,
      roleLogPaths: Object.fromEntries(
        ROLE_NAMES.map((role: RoleName) => [role, `${logsDir}/${role}.log`])
      ) as Record<RoleName, string>,
      messageRoutePaths: {},
      architecturePlanPath: `${handoffDir}/architecture-plan.md`,
      knownIssuesPath: `${handoffDir}/known-issues.md`,
      reviewReportPath: `${handoffDir}/review-report.md`,
      docsSyncReportPath: `${handoffDir}/docs-sync-report.md`,
      finalAcceptancePath: `${handoffDir}/final-acceptance.md`
    },
    checks: []
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
