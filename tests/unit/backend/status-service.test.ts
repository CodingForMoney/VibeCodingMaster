import { describe, expect, it } from "vitest";
import { createStatusService } from "../../../src/backend/services/status-service.js";
import type { ArtifactSummary } from "../../../src/shared/types/artifact.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

describe("createStatusService", () => {
  it("returns task status without computing a workflow report", async () => {
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
            "known-issues": "ok",
            "review-report": "ok",
            "docs-sync-report": "incomplete",
            "final-acceptance": "ok"
          });
        }
      } as never
    });

    const report = await service.getTaskStatus("/repo", "demo-task");

    expect("workflow" in report).toBe(false);
    expect(report.task.taskSlug).toBe("demo-task");
    expect(report.artifacts.checks).toHaveLength(5);
    expect(report.warnings).toContain(".ai/vcm/handoffs/docs-sync-report.md: incomplete");
  });

  it("keeps recoverable sessions when artifact status hits the open-files limit", async () => {
    const service = createStatusService({
      taskService: {
        async loadTask(): Promise<TaskRecord> {
          return createTask();
        }
      } as never,
      sessionService: {
        async listRoleSessions() {
          return [{
            id: "runtime-coder",
            claudeSessionId: "claude-coder-session",
            taskSlug: "demo-task",
            role: "coder",
            status: "resumable",
            command: "claude --agent coder",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            logPath: ".ai/vcm/handoffs/logs/coder.log",
            updatedAt: "2026-05-30T00:00:00.000Z",
            exitCode: null
          }];
        }
      } as never,
      artifactService: {
        async listArtifacts(): Promise<ArtifactSummary> {
          throw Object.assign(new Error("EMFILE: too many open files"), {
            code: "EMFILE"
          });
        }
      } as never
    });

    const report = await service.getTaskStatus("/repo", "demo-task");

    expect(report.sessions).toMatchObject([{
      role: "coder",
      claudeSessionId: "claude-coder-session",
      status: "resumable"
    }]);
    expect(report.warnings[0]).toContain("Artifacts are temporarily unavailable");
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
    handoffDir: ".ai/vcm/handoffs",
    status: "running"
  };
}

function createArtifactSummary(statuses: Record<ArtifactSummary["checks"][number]["kind"], ArtifactSummary["checks"][number]["status"]>): ArtifactSummary {
  return {
    paths: {
      handoffDir: ".ai/vcm/handoffs",
      roleCommandsDir: ".ai/vcm/handoffs/role-commands",
      logsDir: ".ai/vcm/handoffs/logs",
      messagesDir: ".ai/vcm/handoffs/messages",
      roleCommandPaths: {
        architect: ".ai/vcm/handoffs/role-commands/architect.md",
        coder: ".ai/vcm/handoffs/role-commands/coder.md",
        reviewer: ".ai/vcm/handoffs/role-commands/reviewer.md"
      },
      roleLogPaths: {
        "project-manager": ".ai/vcm/handoffs/logs/project-manager.log",
        architect: ".ai/vcm/handoffs/logs/architect.log",
        coder: ".ai/vcm/handoffs/logs/coder.log",
        reviewer: ".ai/vcm/handoffs/logs/reviewer.log",
        "codex-reviewer": ".ai/vcm/handoffs/logs/codex-reviewer.log"
      },
      messageRoutePaths: {
        "project-manager-architect": ".ai/vcm/handoffs/messages/project-manager-architect.md",
        "project-manager-coder": ".ai/vcm/handoffs/messages/project-manager-coder.md",
        "project-manager-reviewer": ".ai/vcm/handoffs/messages/project-manager-reviewer.md",
        "architect-project-manager": ".ai/vcm/handoffs/messages/architect-project-manager.md",
        "coder-project-manager": ".ai/vcm/handoffs/messages/coder-project-manager.md",
        "reviewer-project-manager": ".ai/vcm/handoffs/messages/reviewer-project-manager.md"
      },
      architecturePlanPath: ".ai/vcm/handoffs/architecture-plan.md",
      knownIssuesPath: ".ai/vcm/handoffs/known-issues.md",
      reviewReportPath: ".ai/vcm/handoffs/review-report.md",
      docsSyncReportPath: ".ai/vcm/handoffs/docs-sync-report.md",
      finalAcceptancePath: ".ai/vcm/handoffs/final-acceptance.md"
    },
    checks: Object.entries(statuses).map(([kind, status]) => ({
      kind: kind as ArtifactSummary["checks"][number]["kind"],
      path: `.ai/vcm/handoffs/${kind}.md`,
      exists: status !== "missing",
      isEmpty: status === "empty" || status === "missing",
      hasPlaceholder: status === "incomplete",
      missingHeadings: [],
      status
    }))
  };
}
