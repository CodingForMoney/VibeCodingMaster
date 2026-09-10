import type { FastifyInstance } from "fastify";
import { DISPATCHABLE_ROLES } from "../../shared/constants.js";
import type { ArtifactSummary } from "../../shared/types/artifact.js";
import type { DispatchableRole } from "../../shared/types/role.js";
import type { TaskStatusReport, TaskWorkspaceState } from "../../shared/types/api.js";
import type { VcmSessionRoundState } from "../../shared/types/round.js";
import type { CreateTaskRequest } from "../../shared/types/task.js";
import type { TaskWorkflowState, UpdateTaskWorkflowStateRequest } from "../../shared/types/workflow.js";
import { isOpenFileLimitError, VcmError } from "../errors.js";
import type { MessageService } from "../services/message-service.js";
import type { ProjectService } from "../services/project-service.js";
import type { StatusService } from "../services/status-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";
import type { TaskCloseService } from "../services/task-close-service.js";
import type { TaskLaunchService } from "../services/task-launch-service.js";
import type { RoundService } from "../services/round-service.js";
import type { TaskWorkflowService } from "../services/task-workflow-service.js";
import type { ArchitectRestartService } from "../services/architect-restart-service.js";
import type { TranslationService } from "../services/translation-service.js";

export interface TaskRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  taskCloseService: Pick<TaskCloseService, "closeTask">;
  statusService: StatusService;
  messageService: MessageService;
  taskLaunchService: Pick<TaskLaunchService, "startTaskRoleSessions">;
  roundService: Pick<RoundService, "getSessionRoundState">;
  taskWorkflowService?: Pick<TaskWorkflowService, "getState" | "declare">;
  architectRestartService: Pick<ArchitectRestartService, "getState">;
  translationService?: Pick<TranslationService, "shouldDelayFlowPauseNotification">;
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

  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/workspace-state", async (request) => {
    const taskSlug = request.params.taskSlug;
    let repoRoot = "unknown";
    try {
      const project = await requireCurrentProject(deps.projectService);
      repoRoot = project.repoRoot;
      const config = await deps.projectService.loadConfig(project.repoRoot);
      const task = await deps.taskService.loadTask(project.repoRoot, taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      const context = {
        repoRoot: project.repoRoot,
        taskRepoRoot,
        stateRepoRoot: taskRepoRoot,
        stateRoot: config.stateRoot,
        handoffDir: task.handoffDir,
        taskSlug
      };

      const [taskStatus, messages, orchestration, roundState, workflowState] = await Promise.all([
        withOpenFileLimitFallback(
          () => deps.statusService.getTaskStatus(project.repoRoot, taskSlug),
          (error) => degradedTaskStatus(project.repoRoot, taskSlug, error)
        ),
        withOpenFileLimitFallback(
          () => deps.messageService.listMessages(context),
          () => []
        ),
        withOpenFileLimitFallback(
          () => deps.messageService.getOrchestrationState(context),
          () => ({
            taskSlug,
            mode: "auto" as const,
            updatedAt: new Date().toISOString()
          })
        ),
        withOpenFileLimitFallback(
          () => deps.roundService.getSessionRoundState({
            repoRoot: project.repoRoot,
            stateRepoRoot: taskRepoRoot,
            stateRoot: config.stateRoot,
            taskSlug
          }),
          () => degradedRoundState(taskSlug)
        ),
        deps.taskWorkflowService?.getState({
          taskRepoRoot,
          stateRoot: config.stateRoot,
          taskSlug
        }) ?? Promise.resolve(degradedWorkflowState(taskSlug))
      ]);
      const displayedRoundState = await delayFlowPauseForTranslation(deps, {
        repoRoot: project.repoRoot,
        taskRepoRoot,
        taskSlug,
        roundState
      });

      return {
        taskStatus,
        messages,
        orchestration,
        roundState: displayedRoundState,
        workflowState,
        architectRestart: deps.architectRestartService.getState(project.repoRoot, taskSlug)
      } satisfies TaskWorkspaceState;
    } catch (error) {
      if (isOpenFileLimitError(error)) {
        return {
          taskStatus: degradedTaskStatus(repoRoot, taskSlug, error),
          messages: [],
          orchestration: {
            taskSlug,
            mode: "auto" as const,
            updatedAt: new Date().toISOString()
          },
          roundState: degradedRoundState(taskSlug),
          workflowState: degradedWorkflowState(taskSlug),
          architectRestart: deps.architectRestartService.getState(repoRoot, taskSlug)
        } satisfies TaskWorkspaceState;
      }
      throw error;
    }
  });

  app.post<{
    Params: { taskSlug: string };
    Body: UpdateTaskWorkflowStateRequest;
  }>("/api/tasks/:taskSlug/workflow-state", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const config = await deps.projectService.loadConfig(project.repoRoot);
    const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
    if (!deps.taskWorkflowService) {
      return degradedWorkflowState(task.taskSlug);
    }
    return deps.taskWorkflowService.declare({
      taskRepoRoot: getTaskRuntimeRepoRoot(task),
      stateRoot: config.stateRoot,
      taskSlug: task.taskSlug
    }, request.body ?? {});
  });

  app.post<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/one-click-start", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.taskLaunchService.startTaskRoleSessions(project.repoRoot, {
      taskSlug: request.params.taskSlug,
      requireFreshStart: true
    });
  });

  app.post<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/cleanup", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    return deps.taskCloseService.closeTask(project.repoRoot, request.params.taskSlug);
  });
}

async function delayFlowPauseForTranslation(
  deps: Pick<TaskRouteDeps, "translationService">,
  input: {
    repoRoot: string;
    taskRepoRoot: string;
    taskSlug: string;
    roundState: VcmSessionRoundState;
  }
): Promise<VcmSessionRoundState> {
  if (!input.roundState.flowPause?.paused || !deps.translationService) {
    return input.roundState;
  }
  try {
    const pending = await deps.translationService.shouldDelayFlowPauseNotification(input);
    return pending ? { ...input.roundState, flowPause: undefined } : input.roundState;
  } catch {
    // Translation-state failures must release, rather than suppress, the pause alert.
    return input.roundState;
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

function degradedRoundState(taskSlug: string): VcmSessionRoundState {
  return {
    taskSlug,
    status: "stopped",
    turnCount: 0,
    completedTurnCount: 0,
    totalRoundCount: 0,
    totalTurnCount: 0,
    totalCompletedTurnCount: 0,
    totalCcActiveMs: 0,
    currentRoundCcActiveMs: 0,
    roles: [],
    updatedAt: new Date().toISOString()
  };
}

function degradedWorkflowState(taskSlug: string): TaskWorkflowState {
  return {
    version: 1,
    taskSlug,
    revision: 0,
    declared: null,
    lastDispatch: null,
    warnings: ["Task workflow state is temporarily unavailable."],
    updatedAt: new Date().toISOString()
  };
}

async function withOpenFileLimitFallback<T>(
  run: () => Promise<T>,
  fallback: (error: unknown) => T
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isOpenFileLimitError(error)) {
      return fallback(error);
    }
    throw error;
  }
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
      architectureBriefPath: `${handoffDir}/architecture-brief.md`,
      architectureEvidencePath: `${handoffDir}/architecture-evidence.md`,
      planningProgressPath: `${handoffDir}/planning-progress.md`,
      architecturePlanPath: `${handoffDir}/architecture-plan.md`,
      knownIssuesPath: `${handoffDir}/known-issues.md`,
      coderCompletionPath: `${handoffDir}/coder-completion.md`,
      architectDebugPath: `${handoffDir}/architect-debug.md`,
      architectureDiagnosisPath: `${handoffDir}/architecture-diagnosis.md`,
      testReportPath: `${handoffDir}/test-report.md`,
      docsUpdateReportPath: `${handoffDir}/docs-update-report.md`,
      docsSyncReportPath: `${handoffDir}/docs-sync-report.md`,
      workflowProgressPath: `${handoffDir}/workflow-progress.md`,
      finalAcceptancePath: `${handoffDir}/final-acceptance.md`
    },
    checks: []
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
