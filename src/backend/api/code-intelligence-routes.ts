import type { FastifyInstance } from "fastify";
import { isRoleName } from "../../shared/constants.js";
import {
  CODE_INTELLIGENCE_OPERATIONS,
  type CodeIntelligenceQueryRequest
} from "../../shared/types/code-intelligence.js";
import { VcmError } from "../errors.js";
import { roleUsesCodeIntelligence } from "../services/lsp-plugin.js";
import type { CodeIntelligenceManager } from "../services/code-intelligence-service.js";
import type { ProjectService } from "../services/project-service.js";
import type { SessionService } from "../services/session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";

export interface CodeIntelligenceRouteDeps {
  projectService: ProjectService;
  taskService: Pick<TaskService, "loadTask">;
  sessionService: Pick<SessionService, "getRoleSession">;
  codeIntelligenceManager: CodeIntelligenceManager;
}

export function registerCodeIntelligenceRoutes(app: FastifyInstance, deps: CodeIntelligenceRouteDeps): void {
  app.post<{ Body: CodeIntelligenceQueryRequest }>("/api/code-intelligence/query", async (request) => {
    const body = request.body ?? {} as CodeIntelligenceQueryRequest;
    if (!isRoleName(body.role) || !roleUsesCodeIntelligence(body.role)) {
      throw new VcmError({
        code: "CODE_INTELLIGENCE_ROLE_FORBIDDEN",
        message: `${body.role || "Unknown role"} cannot use VCM shared code intelligence.`,
        statusCode: 403
      });
    }
    if (!CODE_INTELLIGENCE_OPERATIONS.includes(body.operation)) {
      throw new VcmError({
        code: "CODE_INTELLIGENCE_OPERATION_INVALID",
        message: `Unsupported code intelligence operation: ${body.operation ?? "missing"}.`,
        statusCode: 400
      });
    }
    const project = await deps.projectService.getCurrentProject();
    if (!project) {
      throw new VcmError({
        code: "PROJECT_NOT_CONNECTED",
        message: "Connect a repository before using shared code intelligence.",
        statusCode: 409
      });
    }
    const task = await deps.taskService.loadTask(project.repoRoot, body.taskSlug);
    const session = await deps.sessionService.getRoleSession(project.repoRoot, task.taskSlug, body.role);
    if (!session?.runtimeSessionToken || session.runtimeSessionToken !== body.runtimeSessionToken) {
      throw new VcmError({
        code: "CODE_INTELLIGENCE_SESSION_STALE",
        message: "The code intelligence request does not belong to the current role Session.",
        statusCode: 409,
        hint: "Restart or resume the role Session before retrying the query."
      });
    }
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    return deps.codeIntelligenceManager.query(taskRepoRoot, body);
  });
}
