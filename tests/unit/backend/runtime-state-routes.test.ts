import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerRuntimeStateRoutes } from "../../../src/backend/api/runtime-state-routes.js";

describe("runtime state routes", () => {
  it("returns aggregated project runtime state for the active task", async () => {
    const app = Fastify({ logger: false });

    registerRuntimeStateRoutes(app, {
      projectService: {
        async getCurrentProject() {
          return {
            repoRoot: "/repo"
          };
        }
      } as never,
      taskService: {
        async loadTask(_repoRoot: string, taskSlug: string) {
          return {
            taskSlug,
            worktreePath: `/repo/.claude/worktrees/${taskSlug}`
          };
        }
      } as never,
      sessionService: {
        async getProjectTranslatorSession() {
          return {
            id: "translator-runtime",
            role: "translator",
            status: "running"
          };
        },
        async getProjectHarnessEngineerSession() {
          return {
            id: "harness-runtime",
            role: "harness-engineer",
            status: "resumable"
          };
        }
      } as never,
      translationWorkerService: {
        async getState() {
          return {
            memoryInitialized: true,
            queue: { version: 1, updatedAt: "", items: [] },
            fileIndex: { version: 1, updatedAt: "", jobs: [] },
            bootstrapIndex: { version: 1, updatedAt: "", runs: [] }
          };
        }
      } as never,
      harnessService: {
        async getHarnessStatus(repoRoot: string) {
          return {
            version: 1,
            harnessRevision: 1,
            initialized: repoRoot.endsWith("/demo-task"),
            files: [],
            needsApply: false,
            plannedChanges: [],
            warnings: []
          };
        },
        async getBootstrapStatus() {
          return {
            status: "complete",
            canStart: false,
            checks: [],
            warnings: []
          };
        }
      } as never,
      harnessFeedbackService: {
        async getState() {
          return {
            status: "idle",
            queue: []
          };
        }
      } as never
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/projects/runtime-state?taskSlug=demo-task"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      translatorSession: { id: "translator-runtime" },
      translationState: { memoryInitialized: true },
      harnessEngineerSession: { id: "harness-runtime" },
      harnessStatus: { initialized: true },
      harnessBootstrapStatus: { status: "complete" },
      harnessFeedbackState: { status: "idle" }
    });
    await app.close();
  });
});
