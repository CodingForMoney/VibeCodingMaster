import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerHarnessRoutes } from "../../../src/backend/api/harness-routes.js";

describe("harness routes", () => {
  it("degrades harness status when the backend hits the open-files limit", async () => {
    const app = Fastify({ logger: false });
    registerHarnessRoutes(app, {
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      harnessService: {
        async getHarnessStatus() {
          throw openFilesError("/workspace/CLAUDE.md");
        },
        async applyHarness() {
          throw new Error("not used");
        },
        async getBootstrapStatus() {
          throw new Error("not used");
        },
        async startHarnessBootstrap() {
          throw new Error("not used");
        }
      }
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/api/projects/harness?taskSlug=demo-task"
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.initialized).toBe(false);
    expect(payload.warnings[0]).toContain("open-files limit");
    await app.close();
  });

  it("degrades bootstrap status when the backend hits the open-files limit", async () => {
    const app = Fastify({ logger: false });
    registerHarnessRoutes(app, {
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      harnessService: {
        async getHarnessStatus() {
          throw new Error("not used");
        },
        async applyHarness() {
          throw new Error("not used");
        },
        async getBootstrapStatus() {
          throw openFilesError("/workspace/CLAUDE.md");
        },
        async startHarnessBootstrap() {
          throw new Error("not used");
        }
      }
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/api/projects/harness/bootstrap?taskSlug=demo-task"
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.status).toBe("not_ready");
    expect(payload.checks[0].status).toBe("unknown");
    expect(payload.warnings[0]).toContain("open-files limit");
    await app.close();
  });

  it("requires a task before reading harness status", async () => {
    const app = Fastify({ logger: false });
    registerHarnessRoutes(app, {
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      harnessService: {
        async getHarnessStatus() {
          throw new Error("not used");
        }
      }
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/api/projects/harness"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("HARNESS_TASK_REQUIRED");
    await app.close();
  });

  it("returns repository diff using the selected commit", async () => {
    const app = Fastify({ logger: false });
    const calls: unknown[] = [];
    registerHarnessRoutes(app, {
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      harnessService: {
        async getHarnessStatus() {
          throw new Error("not used");
        },
        async applyHarness() {
          throw new Error("not used");
        },
        async getRepositoryDiff(repoRoot, input) {
          calls.push(["getRepositoryDiff", repoRoot, input]);
          return {
            version: 1,
            repoRoot,
            generatedAt: "2026-06-23T00:00:00.000Z",
            commits: [{
              sha: "abc1234567890",
              shortSha: "abc123456789",
              subject: "chore(vcm-harness): bootstrap",
              committedAt: "2026-06-23T00:00:00.000Z"
            }],
            commit: {
              sha: "abc1234567890",
              shortSha: "abc123456789",
              subject: "chore(vcm-harness): bootstrap",
              committedAt: "2026-06-23T00:00:00.000Z"
            },
            summary: {
              totalFiles: 0,
              committedFiles: 0,
              stagedFiles: 0,
              unstagedFiles: 0,
              untrackedFiles: 0,
              additions: 0,
              deletions: 0,
              harnessFiles: 0,
              productCodeFiles: 0,
              truncatedFiles: 0,
              binaryFiles: 0
            },
            files: [],
            warnings: []
          };
        },
        async getBootstrapStatus() {
          throw new Error("not used");
        },
        async startHarnessBootstrap() {
          throw new Error("not used");
        }
      }
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/api/projects/harness/repository-diff?taskSlug=demo-task&commit=abc1234567890"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ repoRoot: "/workspace/.claude/worktrees/demo-task" });
    expect(calls).toEqual([[
      "getRepositoryDiff",
      "/workspace/.claude/worktrees/demo-task",
      {
        baseRepoRoot: "/workspace",
        commitSha: "abc1234567890"
      }
    ]]);
    await app.close();
  });
});

function createProjectServiceStub() {
  return {
    async getCurrentProject() {
      return {
        repoRoot: "/workspace"
      };
    }
  };
}

function createTaskServiceStub() {
  return {
    async loadTask(repoRoot: string, taskSlug: string) {
      return {
        version: 1,
        taskSlug,
        createdAt: "",
        updatedAt: "",
        repoRoot,
        worktreePath: `/workspace/.claude/worktrees/${taskSlug}`,
        branch: `feature/${taskSlug}`,
        handoffDir: ".ai/vcm/handoffs",
        status: "created"
      };
    }
  };
}

function openFilesError(targetPath: string): Error {
  return Object.assign(new Error(`EMFILE: too many open files, open '${targetPath}'`), {
    code: "EMFILE"
  });
}
