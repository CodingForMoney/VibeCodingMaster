import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VcmRoleName } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";
import { connectAndCreateTask, connectProject, injectOk, startRole } from "./helpers/e2e-actions.js";

const cleanups: Array<() => Promise<void>> = [];
const VCM_ROLES: readonly VcmRoleName[] = [
  "project-manager",
  "architect",
  "coder",
  "tester",
  "reviewer"
];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E Restart With Context", () => {
  it("restarts every VCM workflow role with its existing task artifacts and clears intent on the first prompt", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createRepo(true);
    const task = await connectAndCreateTask(env.app, repo, "restart-with-context-roles");

    for (const role of VCM_ROLES) {
      const original = await startRole(env.app, task.taskSlug, role);
      env.mockRuntime.onPrompt(role, "[VCM RESTART WITH CONTEXT]", async (ctx) => {
        await ctx.userPromptSubmit();
      });

      const response = await injectOk(env.app, {
        method: "POST",
        url: `/api/tasks/${task.taskSlug}/sessions/${role}/restart-with-context`,
        payload: {
          permissionMode: "bypassPermissions",
          model: "default",
          effort: "medium",
          cols: 100,
          rows: 28
        }
      });
      const replacement = response.json<RoleSessionRecord>();
      await env.mockRuntime.waitForIdle();

      expect(replacement.id).not.toBe(original.id);
      const createInput = env.mockRuntime.getCreateInput(replacement.id);
      expect(createInput.args).toContain("--append-system-prompt");
      expect(createInput.args.join("\n")).toContain(expectedContextPath(role));
      const writes = env.mockRuntime.getWrites(replacement.id).join("\n");
      expect(writes).toContain("[VCM RESTART WITH CONTEXT]");
      if (role === "project-manager") {
        expect(writes).not.toContain("[VCM TASK STATE]");
      }
      await expect(fs.access(statePath(task.worktreePath, role))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects tool Agents because they are outside the VCM workflow role set", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createRepo(true);
    const task = await connectAndCreateTask(env.app, repo, "restart-with-context-tools");

    for (const role of ["translator", "harness-engineer"] as const) {
      const response = await env.app.inject({
        method: "POST",
        url: `/api/tasks/${task.taskSlug}/sessions/${role}/restart-with-context`,
        payload: {}
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("ROLE_CONTEXT_RESTART_UNSUPPORTED");
    }
  });

  it("recreates an unconfirmed replacement after the VCM backend restarts", async () => {
    const first = await createMockClaudeE2eApp();
    const tempRoot = first.tempRoot;
    const repo = await createRepo(false);
    let firstClosed = false;
    let second: Awaited<ReturnType<typeof createMockClaudeE2eApp>> | undefined;
    cleanups.push(async () => {
      if (second) {
        await second.close();
      } else if (!firstClosed) {
        await first.close();
      } else {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
      await repo.cleanup();
    });

    const task = await connectAndCreateTask(first.app, repo, "restart-with-context-recovery");
    await startRole(first.app, task.taskSlug, "coder");
    await injectOk(first.app, {
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/coder/restart-with-context`,
      payload: {
        permissionMode: "bypassPermissions",
        model: "default",
        effort: "high"
      }
    });
    await first.mockRuntime.waitForIdle();
    await expect(fs.access(statePath(task.worktreePath, "coder"))).resolves.toBeUndefined();

    await first.close({ preserveTempRoot: true });
    firstClosed = true;
    second = await createMockClaudeE2eApp({ tempRoot });
    second.mockRuntime.onPrompt("coder", "[VCM RESTART WITH CONTEXT]", async (ctx) => {
      await ctx.userPromptSubmit();
    });
    await connectProject(second.app, repo.repoRoot);
    await second.mockRuntime.waitForIdle();

    const recovered = second.mockRuntime.getSessionByRole(task.taskSlug, "coder");
    const recoveryState = await fs.readFile(statePath(task.worktreePath, "coder"), "utf8").catch((error) => String(error));
    expect(recovered, recoveryState).toBeDefined();
    const createInput = second.mockRuntime.getCreateInput(recovered!.id);
    expect(createInput.args).toContain("--append-system-prompt");
    expect(createInput.args).toContain("high");
    expect(second.mockRuntime.getWrites(recovered!.id).join("\n")).toContain("[VCM RESTART WITH CONTEXT]");
    await expect(fs.access(statePath(task.worktreePath, "coder"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels an unconfirmed context restart when the user chooses ordinary Restart", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createRepo(true);
    const task = await connectAndCreateTask(env.app, repo, "restart-with-context-cancel");
    await startRole(env.app, task.taskSlug, "tester");

    await injectOk(env.app, {
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/tester/restart-with-context`,
      payload: {
        permissionMode: "bypassPermissions",
        model: "default",
        effort: "medium"
      }
    });
    await env.mockRuntime.waitForIdle();
    await expect(fs.access(statePath(task.worktreePath, "tester"))).resolves.toBeUndefined();

    const response = await injectOk(env.app, {
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/tester/restart`,
      payload: {
        permissionMode: "bypassPermissions",
        model: "default",
        effort: "medium"
      }
    });
    const ordinary = response.json<RoleSessionRecord>();

    expect(env.mockRuntime.getCreateInput(ordinary.id).args).not.toContain("--append-system-prompt");
    await expect(fs.access(statePath(task.worktreePath, "tester"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createRepo(registerCleanup: boolean) {
  const repo = await createE2eRepo();
  if (registerCleanup) {
    cleanups.push(() => repo.cleanup());
  }
  return repo;
}

function expectedContextPath(role: VcmRoleName): string {
  switch (role) {
    case "project-manager":
      return ".ai/vcm/handoffs/workflow-progress.md";
    case "architect":
      return ".ai/vcm/handoffs/architecture-evidence.md";
    case "coder":
      return ".ai/vcm/handoffs/coder-completion.md";
    case "tester":
      return ".ai/vcm/handoffs/test-report.md";
    case "reviewer":
      return ".ai/vcm/gate-reviews/requests/";
  }
}

function statePath(taskRepoRoot: string, role: VcmRoleName): string {
  return path.join(taskRepoRoot, ".ai/vcm/restart-with-context", `${role}.json`);
}
