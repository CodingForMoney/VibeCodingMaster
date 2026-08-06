import type { FastifyInstance } from "fastify";
import type { WorkflowOverrideDecisionRequest } from "../../shared/types/workflow.js";
import { VcmError } from "../errors.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import type { ProjectService } from "../services/project-service.js";
import type { SessionService } from "../services/session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";
import type { WorkflowControlService } from "../services/workflow-control-service.js";

export interface WorkflowControlRouteDeps {
  projectService: ProjectService;
  taskService: Pick<TaskService, "loadTask">;
  sessionService: Pick<SessionService, "getRoleSession" | "markRoleActivityRunning">;
  workflowControlService: WorkflowControlService;
  runtime: TerminalRuntime;
}

export function registerWorkflowControlRoutes(app: FastifyInstance, deps: WorkflowControlRouteDeps): void {
  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/workflow-control", async (request) => {
    const context = await getContext(deps, request.params.taskSlug);
    return deps.workflowControlService.getState(context);
  });

  app.post<{
    Params: { taskSlug: string; overrideId: string };
    Body: WorkflowOverrideDecisionRequest;
  }>("/api/tasks/:taskSlug/workflow-overrides/:overrideId/approve", async (request) => {
    const authorizationText = request.body?.authorizationText?.trim();
    if (!authorizationText) {
      throw new VcmError({
        code: "WORKFLOW_OVERRIDE_AUTHORIZATION_REQUIRED",
        message: "Enter the exact workflow exception that the user authorizes.",
        statusCode: 400
      });
    }
    const context = await getContext(deps, request.params.taskSlug);
    const state = await deps.workflowControlService.approveOverride(
      context,
      request.params.overrideId,
      authorizationText
    );
    await notifyProjectManager(deps, context, request.params.overrideId, "approved", authorizationText);
    return state;
  });

  app.post<{ Params: { taskSlug: string; overrideId: string } }>(
    "/api/tasks/:taskSlug/workflow-overrides/:overrideId/reject",
    async (request) => {
      const context = await getContext(deps, request.params.taskSlug);
      const state = await deps.workflowControlService.rejectOverride(context, request.params.overrideId);
      await notifyProjectManager(deps, context, request.params.overrideId, "rejected");
      return state;
    }
  );
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

async function notifyProjectManager(
  deps: WorkflowControlRouteDeps,
  context: Awaited<ReturnType<typeof getContext>>,
  overrideId: string,
  decision: "approved" | "rejected",
  authorizationText?: string
): Promise<void> {
  const session = await deps.sessionService.getRoleSession(context.repoRoot, context.taskSlug, "project-manager");
  if (!session || session.status !== "running" || session.activityStatus === "running") return;
  const prompt = decision === "approved"
    ? `[VCM Workflow Override Decision]\nDecision: approved\nAuthorization ID: ${overrideId}\nAuthorization Text: ${authorizationText}\n\nResubmit workflow-progress.md with this Authorization ID and exact Authorization Text.`
    : `[VCM Workflow Override Decision]\nDecision: rejected\nAuthorization ID: ${overrideId}\n\nKeep the current workflow and choose a legal next dispatch.`;
  await submitTerminalInput(deps.runtime, session.id, prompt);
  await deps.sessionService.markRoleActivityRunning(
    context.repoRoot,
    context.taskSlug,
    "project-manager",
    session.id
  );
}
