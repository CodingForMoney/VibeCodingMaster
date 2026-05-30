import { describe, expect, it } from "vitest";
import { createStatusService } from "../../../src/backend/services/status-service.js";
import type { ArtifactSummary } from "../../../src/shared/types/artifact.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

describe("createStatusService", () => {
  it("suggests architect docs sync after review is complete", async () => {
    const service = createStatusService({
      taskService: {
        async loadTask(): Promise<TaskRecord> {
          return createTask();
        }
      } as never,
      sessionService: {
        async listRoleSessions() {
          return [];
        }
      } as never,
      artifactService: {
        async listArtifacts(): Promise<ArtifactSummary> {
          return createArtifactSummary({
            "architecture-plan": "ok",
            "implementation-log": "ok",
            "validation-log": "ok",
            "review-report": "ok",
            "docs-sync-report": "incomplete"
          });
        }
      } as never
    });

    const report = await service.getTaskStatus("/repo", "demo-task");

    expect(report.workflow.currentStepId).toBe("docs-sync");
    expect(report.workflow.nextAction).toContain("docs-sync");
    expect(report.workflow.blocked).toBe(false);
  });

  it("blocks PM final acceptance until docs sync is complete", async () => {
    const service = createStatusService({
      taskService: {
        async loadTask(): Promise<TaskRecord> {
          return createTask();
        }
      } as never,
      sessionService: {
        async listRoleSessions() {
          return [];
        }
      } as never,
      artifactService: {
        async listArtifacts(): Promise<ArtifactSummary> {
          return createArtifactSummary({
            "architecture-plan": "ok",
            "implementation-log": "ok",
            "validation-log": "ok",
            "review-report": "ok",
            "docs-sync-report": "ok"
          });
        }
      } as never
    });

    const report = await service.getTaskStatus("/repo", "demo-task");

    expect(report.workflow.currentStepId).toBe("final-acceptance");
    expect(report.workflow.nextAction).toContain("final acceptance");
    expect(report.workflow.blocked).toBe(false);
  });
});

function createTask(): TaskRecord {
  return {
    version: 1,
    taskSlug: "demo-task",
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    repoRoot: "/repo",
    branch: "feature/vcm",
    handoffDir: ".ai/handoffs/demo-task",
    status: "running"
  };
}

function createArtifactSummary(statuses: Record<ArtifactSummary["checks"][number]["kind"], ArtifactSummary["checks"][number]["status"]>): ArtifactSummary {
  return {
    paths: {
      handoffDir: ".ai/handoffs/demo-task",
      roleCommandsDir: ".ai/handoffs/demo-task/role-commands",
      logsDir: ".ai/handoffs/demo-task/logs",
      roleCommandPaths: {
        architect: ".ai/handoffs/demo-task/role-commands/architect.md",
        coder: ".ai/handoffs/demo-task/role-commands/coder.md",
        reviewer: ".ai/handoffs/demo-task/role-commands/reviewer.md"
      },
      roleLogPaths: {
        "project-manager": ".ai/handoffs/demo-task/logs/project-manager.log",
        architect: ".ai/handoffs/demo-task/logs/architect.log",
        coder: ".ai/handoffs/demo-task/logs/coder.log",
        reviewer: ".ai/handoffs/demo-task/logs/reviewer.log"
      },
      architecturePlanPath: ".ai/handoffs/demo-task/architecture-plan.md",
      implementationLogPath: ".ai/handoffs/demo-task/implementation-log.md",
      validationLogPath: ".ai/handoffs/demo-task/validation-log.md",
      reviewReportPath: ".ai/handoffs/demo-task/review-report.md",
      docsSyncReportPath: ".ai/handoffs/demo-task/docs-sync-report.md"
    },
    checks: Object.entries(statuses).map(([kind, status]) => ({
      kind: kind as ArtifactSummary["checks"][number]["kind"],
      path: `.ai/handoffs/demo-task/${kind}.md`,
      exists: status !== "missing",
      isEmpty: status === "empty" || status === "missing",
      hasPlaceholder: status === "incomplete",
      missingHeadings: [],
      status
    }))
  };
}
