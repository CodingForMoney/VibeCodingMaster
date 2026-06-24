import type { FastifyInstance } from "fastify";
import { DISPATCHABLE_ROLES, VCM_ROLE_NAMES } from "../../shared/constants.js";
import type { ArtifactSummary } from "../../shared/types/artifact.js";
import type { DispatchableRole } from "../../shared/types/role.js";
import type { TaskStatusReport } from "../../shared/types/api.js";
import type { CleanupTaskRequest, CreateTaskRequest } from "../../shared/types/task.js";
import { isOpenFileLimitError, VcmError } from "../errors.js";
import type { ProjectService } from "../services/project-service.js";
import type { SessionService } from "../services/session-service.js";
import type { StatusService } from "../services/status-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";
import type { TranslationService } from "../services/translation-service.js";
import type { RoundService } from "../services/round-service.js";

export interface TaskRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: Pick<SessionService, "listRoleSessions" | "stopRoleSession" | "moveProjectTranslatorSessionToSafeCwd" | "moveProjectHarnessEngineerSessionToSafeCwd">;
  statusService: StatusService;
  translationService: Pick<TranslationService, "stopTask">;
  roundService: Pick<RoundService, "stopTask">;
}

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  app.get("/api/tasks", async () => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.taskService.listTasks(project.repoRoot);
  });

  app.post<{ Body: CreateTaskRequest }>("/api/tasks", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.taskService.createTask(project.repoRoot, request.body);
  });

  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
  });

  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/status", async (request) => {
    let repoRoot = "unknown";
    try {
      const project = await requireCurrentProject(deps.projectService);
      repoRoot = project.repoRoot;
      return await deps.statusService.getTaskStatus(project.repoRoot, request.params.taskSlug);
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return degradedTaskStatus(repoRoot, request.params.taskSlug, error);
      }
      throw error;
    }
  });

  app.post<{ Params: { taskSlug: string }; Body: CleanupTaskRequest }>(
    "/api/tasks/:taskSlug/cleanup",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      await stopRunningRoleSessions(deps, project.repoRoot, request.params.taskSlug);
      await moveProjectToolSessionsToSafeCwd(deps, project.repoRoot);
      await deps.translationService.stopTask(getTaskRuntimeRepoRoot(task), request.params.taskSlug, { clearCache: true });
      deps.roundService.stopTask(request.params.taskSlug);
      return deps.taskService.cleanupTask(project.repoRoot, request.params.taskSlug, request.body ?? {});
    }
  );
}

async function stopRunningRoleSessions(
  deps: Pick<TaskRouteDeps, "sessionService">,
  repoRoot: string,
  taskSlug: string
): Promise<void> {
  const sessions = await deps.sessionService.listRoleSessions(repoRoot, taskSlug);
  for (const session of sessions) {
    if (session.status === "running" && VCM_ROLE_NAMES.some((role) => role === session.role)) {
      await deps.sessionService.stopRoleSession(repoRoot, taskSlug, session.role);
    }
  }
}

async function moveProjectToolSessionsToSafeCwd(
  deps: Pick<TaskRouteDeps, "sessionService">,
  repoRoot: string
): Promise<void> {
  await Promise.all([
    ignoreMissingSession(deps.sessionService.moveProjectTranslatorSessionToSafeCwd(repoRoot)),
    ignoreMissingSession(deps.sessionService.moveProjectHarnessEngineerSessionToSafeCwd(repoRoot))
  ]);
}

async function ignoreMissingSession(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof VcmError && error.code === "SESSION_MISSING") {
      return;
    }
    throw error;
  }
}

async function requireCurrentProject(projectService: ProjectService) {
  const project = await projectService.getCurrentProject();
  if (!project) {
    throw new VcmError({
      code: "PROJECT_NOT_CONNECTED",
      message: "Connect a repository first.",
      statusCode: 409
    });
  }
  return project;
}

function degradedTaskStatus(repoRoot: string, taskSlug: string, error: unknown): TaskStatusReport {
  const timestamp = new Date().toISOString();
  const handoffDir = ".ai/vcm/handoffs";
  return {
    task: {
      version: 1,
      taskSlug,
      createdAt: timestamp,
      updatedAt: timestamp,
      repoRoot,
      worktreePath: `${repoRoot}/.claude/worktrees/${taskSlug}`,
      branch: "unknown",
      handoffDir,
      status: "stopped"
    },
    sessions: [],
    artifacts: degradedArtifactSummary(handoffDir),
    warnings: [
      `Task status is temporarily unavailable because the backend hit the open-files limit: ${errorMessage(error)}`
    ]
  };
}

function degradedArtifactSummary(handoffDir: string): ArtifactSummary {
  const roleCommandsDir = `${handoffDir}/role-commands`;
  const messagesDir = `${handoffDir}/messages`;
  return {
    paths: {
      handoffDir,
      roleCommandsDir,
      messagesDir,
      roleCommandPaths: Object.fromEntries(
        DISPATCHABLE_ROLES.map((role) => [role, `${roleCommandsDir}/${role}.md`])
      ) as Record<DispatchableRole, string>,
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
