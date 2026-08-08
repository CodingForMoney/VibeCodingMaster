import type { FastifyInstance } from "fastify";
import { VcmError } from "../errors.js";
import type { ProjectService } from "../services/project-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";
import type { WorkflowControlService } from "../services/workflow-control-service.js";

export interface WorkflowControlRouteDeps {
  projectService: ProjectService;
  taskService: Pick<TaskService, "loadTask">;
  workflowControlService: WorkflowControlService;
}

export function registerWorkflowControlRoutes(app: FastifyInstance, deps: WorkflowControlRouteDeps): void {
  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/workflow-control", async (request) => {
    const context = await getContext(deps, request.params.taskSlug);
    return deps.workflowControlService.getState(context);
  });

  app.post<{
    Params: { taskSlug: string };
    Body: { question?: string };
  }>("/api/tasks/:taskSlug/ask-user", async (request) => {
    const context = await getContext(deps, request.params.taskSlug);
    const question = typeof request.body?.question === "string" ? request.body.question.trim() : "";
    if (!question) {
      throw new VcmError({
        code: "WORKFLOW_USER_QUESTION_REQUIRED",
        message: "A non-empty user question is required.",
        statusCode: 400
      });
    }
    return deps.workflowControlService.requestUserInput(context, question);
  });
}

async function getContext(deps: WorkflowControlRouteDeps, taskSlug: string) {
  const project = await deps.projectService.getCurrentProject();
  if (!project) {
    throw new VcmError({ code: "PROJECT_NOT_CONNECTED", message: "Connect a repository first.", statusCode: 409 });
  }
  const [config, task] = await Promise.all([
    deps.projectService.loadConfig(project.repoRoot),
    deps.taskService.loadTask(project.repoRoot, taskSlug)
  ]);
  return {
    repoRoot: project.repoRoot,
    taskRepoRoot: getTaskRuntimeRepoRoot(task),
    stateRoot: config.stateRoot,
    handoffDir: task.handoffDir,
    taskSlug: task.taskSlug
  };
}
