import type { FastifyInstance } from "fastify";
import { isDispatchableRole, isRoleName } from "../../shared/constants.js";
import type { DispatchableRole } from "../../shared/types/role.js";
import { VcmError } from "../errors.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { ProjectService } from "../services/project-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "../services/task-service.js";

export interface ArtifactRouteDeps {
  projectService: ProjectService;
  taskService: TaskService;
  artifactService: ArtifactService;
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

  app.get<{ Params: { taskSlug: string; role: string } }>(
    "/api/tasks/:taskSlug/logs/:role",
    async (request) => {
      const project = await requireCurrentProject(deps.projectService);
      if (!isRoleName(request.params.role)) {
        throw new VcmError({
          code: "UNKNOWN_ROLE",
          message: `Unknown role: ${request.params.role}`,
          statusCode: 400
        });
      }
      const task = await deps.taskService.loadTask(project.repoRoot, request.params.taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      const paths = deps.artifactService.getHandoffPaths(taskRepoRoot, task.handoffDir);
      const artifactPath = paths.roleLogPaths[request.params.role];
      if (!artifactPath) {
        return {
          role: request.params.role,
          content: ""
        };
      }
      return {
        role: request.params.role,
        content: await deps.artifactService.readArtifact({
          repoRoot: taskRepoRoot,
          artifactPath
        })
      };
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
  if (artifactName === "architecture-plan.md") {
    return paths.architecturePlanPath;
  }
  if (artifactName === "known-issues.md") {
    return paths.knownIssuesPath;
  }
  if (artifactName === "review-report.md") {
    return paths.reviewReportPath;
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
