import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerArtifactRoutes } from "../../../src/backend/api/artifact-routes.js";

describe("artifact routes", () => {
  it("submits an artifact only through the matching active role Session", async () => {
    const app = Fastify({ logger: false });
    const submissions: unknown[] = [];
    registerArtifactRoutes(app, {
      projectService: {
        async getCurrentProject() {
          return { repoRoot: "/repo" };
        }
      },
      taskService: {
        async loadTask() {
          return {
            taskSlug: "demo-task",
            repoRoot: "/repo",
            worktreePath: "/repo/.claude/worktrees/demo-task",
            handoffDir: ".ai/vcm/handoffs"
          };
        }
      },
      artifactService: {
        async submitArtifact(input: unknown) {
          submissions.push(input);
          return {
            ok: true,
            kind: "coder-completion",
            mode: "final",
            path: ".ai/vcm/handoffs/coder-completion.md",
            status: "ok"
          };
        }
      },
      sessionService: {
        async getRoleSession() {
          return { runtimeSessionToken: "runtime-token" };
        }
      }
    } as never);

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/demo-task/artifacts/submit",
      payload: {
        kind: "coder-completion",
        mode: "final",
        role: "coder",
        runtimeSessionToken: "runtime-token",
        content: "# candidate"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(submissions).toEqual([expect.objectContaining({
      repoRoot: "/repo/.claude/worktrees/demo-task",
      baseRepoRoot: "/repo",
      taskSlug: "demo-task",
      role: "coder",
      kind: "coder-completion"
    })]);
    await app.close();
  });

  it("rejects a stale runtime Session token before writing", async () => {
    const app = Fastify({ logger: false });
    let submitted = false;
    registerArtifactRoutes(app, {
      projectService: {
        async getCurrentProject() {
          return { repoRoot: "/repo" };
        }
      },
      taskService: {
        async loadTask() {
          return {
            taskSlug: "demo-task",
            repoRoot: "/repo",
            worktreePath: "/repo/.claude/worktrees/demo-task",
            handoffDir: ".ai/vcm/handoffs"
          };
        }
      },
      artifactService: {
        async submitArtifact() {
          submitted = true;
        }
      },
      sessionService: {
        async getRoleSession() {
          return { runtimeSessionToken: "current-token" };
        }
      }
    } as never);

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/demo-task/artifacts/submit",
      payload: {
        kind: "coder-completion",
        mode: "final",
        role: "coder",
        runtimeSessionToken: "stale-token",
        content: "# candidate"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(submitted).toBe(false);
    await app.close();
  });
});
