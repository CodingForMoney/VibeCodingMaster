import { afterEach, describe, expect, it } from "vitest";
import { CCR_GPT_MODEL_ID, CCR_GPT_SESSION_MODEL } from "../../../src/shared/types/session.js";
import { createMockClaudeE2eApp, roleLaunchBody } from "./helpers/e2e-app.js";
import { connectAndCreateTask } from "./helpers/e2e-actions.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("backend E2E CCR integration", () => {
  it("stores a write-only key and launches Claude Code with the CCR environment", async () => {
    const probeKeys: string[] = [];
    const env = await createMockClaudeE2eApp({
      ccrGateway: {
        async probe(apiKey) {
          probeKeys.push(apiKey);
          return { connectionState: "available", modelAvailable: true };
        }
      }
    });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "ccr-launch");

    const saved = await env.app.inject({
      method: "PUT",
      url: "/api/settings/ccr",
      payload: { apiKey: "local-ccr-secret" }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ enabled: false, apiKeyConfigured: true });
    expect(saved.body).not.toContain("local-ccr-secret");

    const enabled = await env.app.inject({
      method: "PUT",
      url: "/api/settings/ccr",
      payload: { enabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      enabled: true,
      connectionState: "available",
      modelAvailable: true
    });

    const start = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/project-manager/start`,
      payload: roleLaunchBody({ model: CCR_GPT_SESSION_MODEL, effort: "medium" })
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ model: CCR_GPT_SESSION_MODEL });

    const runtimeSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    expect(runtimeSession).toBeDefined();
    const input = env.mockRuntime.getCreateInput(runtimeSession!.id);
    expect(input.args).not.toContain("--model");
    expect(input.args).toEqual(expect.arrayContaining(["--effort", "medium"]));
    expect(input.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://host.docker.internal:3456",
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: CCR_GPT_MODEL_ID,
      VCM_TASK_SLUG: task.taskSlug
    });
    expect(JSON.stringify(input.env)).not.toContain("local-ccr-secret");
    expect(input.command).toBe("claude");
    expect(probeKeys).toEqual(["local-ccr-secret"]);
  });

  it("keeps native launches clean and blocks future CCR launches after disabling", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "ccr-disable");

    await env.app.inject({ method: "PUT", url: "/api/settings/ccr", payload: { apiKey: "saved", enabled: true } });
    const ccrStart = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/project-manager/start`,
      payload: roleLaunchBody({ model: CCR_GPT_SESSION_MODEL })
    });
    expect(ccrStart.statusCode).toBe(200);
    const ccrSessionId = ccrStart.json<{ id: string }>().id;
    const nativeStart = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/architect/start`,
      payload: roleLaunchBody({ model: "opus" })
    });
    expect(nativeStart.statusCode).toBe(200);
    const nativeRuntime = env.mockRuntime.getSessionByRole(task.taskSlug, "architect");
    const nativeInput = env.mockRuntime.getCreateInput(nativeRuntime!.id);
    expect(nativeInput.args).toEqual(expect.arrayContaining(["--model", "opus"]));
    expect(nativeInput.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(nativeInput.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");

    await env.app.inject({ method: "PUT", url: "/api/settings/ccr", payload: { enabled: false } });
    const blockedRestart = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/project-manager/restart`,
      payload: roleLaunchBody({ model: CCR_GPT_SESSION_MODEL })
    });
    expect(blockedRestart.statusCode).toBe(409);
    expect(env.mockRuntime.getSession(ccrSessionId)?.status).toBe("running");

    const blocked = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/coder/start`,
      payload: roleLaunchBody({ model: CCR_GPT_SESSION_MODEL })
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toContain("CCR GPT models are disabled");
    expect(env.mockRuntime.getSessionByRole(task.taskSlug, "coder")).toBeUndefined();
  });

  it("uses the same CCR launch path for Gate Reviewer and auxiliary sessions", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "ccr-role-paths");
    await env.app.inject({
      method: "PUT",
      url: "/api/settings/ccr",
      payload: { apiKey: "saved", enabled: true }
    });

    const launches = [
      await env.app.inject({
        method: "POST",
        url: `/api/tasks/${task.taskSlug}/sessions/gate-reviewer/start`,
        payload: roleLaunchBody({ model: CCR_GPT_SESSION_MODEL })
      }),
      await env.app.inject({
        method: "POST",
        url: "/api/translation/session/start",
        payload: { ...roleLaunchBody({ model: CCR_GPT_SESSION_MODEL }), taskSlug: task.taskSlug }
      }),
      await env.app.inject({
        method: "POST",
        url: "/api/projects/harness/engineer/session/start",
        payload: { ...roleLaunchBody({ model: CCR_GPT_SESSION_MODEL }), taskSlug: task.taskSlug }
      })
    ];

    for (const response of launches) {
      expect(response.statusCode).toBe(200);
      const session = response.json<{ id: string; model: string }>();
      expect(session.model).toBe(CCR_GPT_SESSION_MODEL);
      const input = env.mockRuntime.getCreateInput(session.id);
      expect(input.args).not.toContain("--model");
      expect(input.env).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_MODEL: CCR_GPT_MODEL_ID
      });
    }
  });
});
