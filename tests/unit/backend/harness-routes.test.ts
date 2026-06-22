import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerHarnessRoutes } from "../../../src/backend/api/harness-routes.js";

describe("harness routes", () => {
  it("degrades harness status when the backend hits the open-files limit", async () => {
    const app = Fastify({ logger: false });
    registerHarnessRoutes(app, {
      projectService: createProjectServiceStub(),
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
      url: "/api/projects/harness"
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
      url: "/api/projects/harness/bootstrap"
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.status).toBe("not_ready");
    expect(payload.checks[0].status).toBe("unknown");
    expect(payload.warnings[0]).toContain("open-files limit");
    await app.close();
  });

  it("commits and rebases the selected task worktree", async () => {
    const app = Fastify({ logger: false });
    const calls: unknown[] = [];
    registerHarnessRoutes(app, {
      projectService: createProjectServiceStub(),
      taskService: {
        async loadTask(repoRoot: string, taskSlug: string) {
          calls.push(["loadTask", repoRoot, taskSlug]);
          return {
            version: 1,
            taskSlug,
            createdAt: "",
            updatedAt: "",
            repoRoot,
            worktreePath: "/workspace/.claude/worktrees/demo-task",
            branch: "feature/demo-task",
            handoffDir: ".ai/vcm/handoffs",
            status: "created"
          };
        }
      },
      harnessService: {
        async getHarnessStatus() {
          throw new Error("not used");
        },
        async applyHarness() {
          throw new Error("not used");
        },
        async commitAndRebaseTask(repoRoot, input) {
          calls.push(["commitAndRebaseTask", repoRoot, input]);
          return {
            taskSlug: input.taskSlug,
            branch: input.branch,
            worktreePath: input.worktreePath,
            baseBranch: "main",
            baseCommitBefore: "abc",
            baseCommitAfter: "def",
            committed: true,
            rebased: true,
            changedFiles: input.changedFiles,
            message: "done"
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
      method: "POST",
      url: "/api/projects/harness/tasks/demo-task/commit-and-rebase",
      payload: {
        changedFiles: [{ path: "CLAUDE.md", action: "update", reason: "updated" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskSlug: "demo-task",
      branch: "feature/demo-task",
      committed: true,
      rebased: true
    });
    expect(calls).toEqual([
      ["loadTask", "/workspace", "demo-task"],
      ["commitAndRebaseTask", "/workspace", {
        taskSlug: "demo-task",
        branch: "feature/demo-task",
        worktreePath: "/workspace/.claude/worktrees/demo-task",
        changedFiles: [{ path: "CLAUDE.md", action: "update", reason: "updated" }]
      }]
    ]);
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

function openFilesError(targetPath: string): Error {
  return Object.assign(new Error(`EMFILE: too many open files, open '${targetPath}'`), {
    code: "EMFILE"
  });
}
