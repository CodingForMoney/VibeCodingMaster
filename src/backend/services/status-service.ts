import type { ArtifactKind, ArtifactSummary } from "../../shared/types/artifact.js";
import type { TaskStatusReport, TaskWorkflowReport, TaskWorkflowStep } from "../../shared/types/api.js";
import type { RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
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
        workflow: buildWorkflowReport(artifacts, sessions),
        warnings
      };
    }
  };
}

function buildWorkflowReport(artifacts: ArtifactSummary, sessions: RoleSessionRecord[]): TaskWorkflowReport {
  const isComplete = (kind: ArtifactKind) => artifacts.checks.find((check) => check.kind === kind)?.status === "ok";
  const roleIsRunning = (role: RoleName) => sessions.some((session) => session.role === role && session.status === "running");

  const architectureComplete = isComplete("architecture-plan");
  const implementationComplete = isComplete("implementation-log") && isComplete("validation-log");
  const reviewComplete = isComplete("review-report");
  const docsSyncComplete = isComplete("docs-sync-report");

  const steps: TaskWorkflowStep[] = [
    {
      id: "architecture-plan",
      label: "Architecture",
      role: "architect",
      artifactPaths: [artifacts.paths.architecturePlanPath],
      status: architectureComplete ? "complete" : "ready",
      detail: architectureComplete
        ? "architecture-plan.md is ready."
        : roleIsRunning("architect")
          ? "Architect is running; produce architecture-plan.md before coder work."
          : "Start architect and produce architecture-plan.md before coder work."
    },
    {
      id: "implementation",
      label: "Implementation",
      role: "coder",
      artifactPaths: [artifacts.paths.implementationLogPath, artifacts.paths.validationLogPath],
      status: implementationComplete ? "complete" : architectureComplete ? "ready" : "blocked",
      detail: implementationComplete
        ? "implementation-log.md and validation-log.md are ready."
        : architectureComplete
          ? "Start coder, then update implementation-log.md and validation-log.md."
          : "Blocked until architecture-plan.md is complete."
    },
    {
      id: "review",
      label: "Review",
      role: "reviewer",
      artifactPaths: [artifacts.paths.reviewReportPath],
      status: reviewComplete ? "complete" : implementationComplete ? "ready" : "blocked",
      detail: reviewComplete
        ? "review-report.md is ready."
        : implementationComplete
          ? "Start reviewer for independent review and final test adequacy."
          : "Blocked until implementation-log.md and validation-log.md are complete."
    },
    {
      id: "docs-sync",
      label: "Docs Sync",
      role: "architect",
      artifactPaths: [artifacts.paths.docsSyncReportPath],
      status: docsSyncComplete ? "complete" : reviewComplete ? "ready" : "blocked",
      detail: docsSyncComplete
        ? "docs-sync-report.md is ready."
        : reviewComplete
          ? "Send architect a docs-sync / architecture drift check task."
          : "Blocked until review-report.md is complete."
    },
    {
      id: "final-acceptance",
      label: "PM Final",
      role: "project-manager",
      artifactPaths: [],
      status: docsSyncComplete ? "ready" : "blocked",
      detail: docsSyncComplete
        ? "Project Manager can prepare final acceptance, commit, and PR."
        : "Blocked until architect docs sync is complete."
    }
  ];

  const current = steps.find((step) => step.status !== "complete") ?? steps[steps.length - 1];

  return {
    currentStepId: current.id,
    nextAction: current.detail,
    blocked: current.status === "blocked",
    steps
  };
}
