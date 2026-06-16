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
