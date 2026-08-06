import type { FastifyInstance } from "fastify";
import { isDispatchableRole, isRoleName } from "../../shared/constants.js";
import type { ArtifactSubmissionRequest } from "../../shared/types/artifact.js";
import type { DispatchableRole } from "../../shared/types/role.js";
import { VcmError } from "../errors.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { ProjectService } from "../services/project-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";
import type { SessionService } from "../services/session-service.js";

export interface ArtifactRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  artifactService: ArtifactService;
  sessionService: Pick<
    SessionService,
    "getRoleSession" | "getProjectTranslatorSession" | "getProjectHarnessEngineerSession"
  >;
}

export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRouteDeps): void {
  app.get<{ Params: { taskSlug: string } }>("/api/tasks/:taskSlug/artifacts", async (request) => {
    const project = await requireCurrentProject(deps.projectService);
    const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    return deps.artifactService.listArtifacts({
      repoRoot: taskRepoRoot,
      handoffDir: task.handoffDir
    });
  });

  app.get<{ Params: { taskSlug: string; artifactName: string } }>(
    "/api/tasks/:taskSlug/artifacts/:artifactName",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      const paths = deps.artifactService.getHandoffPaths(taskRepoRoot, task.handoffDir);
      const artifactPath = artifactNameToPath(paths, request.params.artifactName);
      return {
        path: artifactPath,
        content: await deps.artifactService.readArtifact({
          repoRoot: taskRepoRoot,
          artifactPath
        })
      };
    }
  );

  app.get<{ Params: { taskSlug: string; role: string } }>(
    "/api/tasks/:taskSlug/role-commands/:role",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseDispatchableRole(request.params.role);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      return {
        role,
        content: await deps.artifactService.readRoleCommand({
          repoRoot: taskRepoRoot,
          handoffDir: task.handoffDir,
          role
        })
      };
    }
  );

  app.put<{ Params: { taskSlug: string; role: string }; Body: { content: string } }>(
    "/api/tasks/:taskSlug/role-commands/:role",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const role = parseDispatchableRole(request.params.role);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      await deps.artifactService.saveRoleCommand({
        repoRoot: taskRepoRoot,
        handoffDir: task.handoffDir,
        role,
        content: request.body.content
      });
      return { ok: true };
    }
  );

  app.post<{ Params: { taskSlug: string }; Body: ArtifactSubmissionRequest }>(
    "/api/tasks/:taskSlug/artifacts/submit",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      const body = request.body;
      if (!body || !isRoleName(body.role)) {
        throw new VcmError({
          code: "ARTIFACT_ROLE_INVALID",
          message: `Unknown artifact role: ${body?.role ?? "missing"}`,
          statusCode: 400
        });
      }
      if (body.mode !== "draft" && body.mode !== "final") {
        throw new VcmError({
          code: "ARTIFACT_MODE_INVALID",
          message: "Artifact mode must be draft or final.",
          statusCode: 400
        });
      }
      if (typeof body.content !== "string") {
        throw new VcmError({
          code: "ARTIFACT_CONTENT_INVALID",
          message: "Artifact content must be text.",
          statusCode: 400
        });
      }
      const session = body.role === "translator"
        ? await deps.sessionService.getProjectTranslatorSession(project.repoRoot)
        : body.role === "harness-engineer"
          ? await deps.sessionService.getRoleSession(project.repoRoot, task.taskSlug, body.role)
            ?? await deps.sessionService.getProjectHarnessEngineerSession(project.repoRoot)
          : await deps.sessionService.getRoleSession(project.repoRoot, task.taskSlug, body.role);
      if (!session || !session.runtimeSessionToken || session.runtimeSessionToken !== body.runtimeSessionToken) {
        throw new VcmError({
          code: "ARTIFACT_SESSION_INVALID",
          message: `${body.role} does not have the active VCM Session that owns this artifact submission.`,
          statusCode: 409,
          hint: "Submit from the active role terminal with .ai/tools/vcm-artifact."
        });
      }
      return deps.artifactService.submitArtifact({
        repoRoot: getTaskRuntimeRepoRoot(task),
        baseRepoRoot: project.repoRoot,
        handoffDir: task.handoffDir,
        taskSlug: task.taskSlug,
        kind: body.kind,
        mode: body.mode,
        role: body.role,
        content: body.content,
        artifactPath: body.path
      });
    }
  );

}

function parseDispatchableRole(role: string): DispatchableRole {
  if (!isDispatchableRole(role)) {
    throw new VcmError({
      code: "ROLE_NOT_DISPATCHABLE",
      message: `${role} cannot receive role commands.`,
      statusCode: 400
    });
  }
  return role;
}

function artifactNameToPath(paths: ReturnType<ArtifactService["getHandoffPaths"]>, artifactName: string): string {
  if (artifactName === "architecture-brief.md") {
    return paths.architectureBriefPath;
  }
  if (artifactName === "architecture-evidence.md") {
    return paths.architectureEvidencePath;
  }
  if (artifactName === "planning-progress.md") {
    return paths.planningProgressPath;
  }
  if (artifactName === "architecture-plan.md") {
    return paths.architecturePlanPath;
  }
  if (artifactName === "known-issues.md") {
    return paths.knownIssuesPath;
  }
  if (artifactName === "coder-completion.md") {
    return paths.coderCompletionPath;
  }
  if (artifactName === "architect-debug.md") {
    return paths.architectDebugPath;
  }
  if (artifactName === "architecture-diagnosis.md") {
    return paths.architectureDiagnosisPath;
  }
  if (artifactName === "test-report.md") {
    return paths.testReportPath;
  }
  if (artifactName === "docs-sync-report.md") {
    return paths.docsSyncReportPath;
  }
  if (artifactName === "final-acceptance.md") {
    return paths.finalAcceptancePath;
  }
  throw new VcmError({
    code: "ARTIFACT_UNKNOWN",
    message: `Unknown artifact: ${artifactName}`,
    statusCode: 404
  });
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
