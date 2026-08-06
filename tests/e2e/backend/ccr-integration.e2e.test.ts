import { afterEach, describe, expect, it } from "vitest";
import {
  CCR_GPT_AUTO_COMPACT_PERCENT,
  CCR_GPT_AUTO_COMPACT_WINDOW_TOKENS,
  CCR_GPT_EFFECTIVE_CONTEXT_TOKENS,
  CCR_GPT_MODEL_ID,
  CCR_GPT_SESSION_MODEL
} from "../../../src/shared/types/session.js";
import {
  CODE_ROLE_RUNTIME_DISALLOWED_TOOLS,
  REVIEWER_RUNTIME_DISALLOWED_TOOLS
} from "../../../src/backend/role-tool-policy.js";
import { VCM_LSP_PLUGIN_DIR } from "../../../src/backend/services/lsp-plugin.js";
import { createMockClaudeE2eApp, roleLaunchBody } from "./helpers/e2e-app.js";
import {
  connectAndCreateTask,
  getPreferences,
  updatePreferences
} from "./helpers/e2e-actions.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
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
    const ccrSettingsIndex = input.args.indexOf("--settings");
    expect(ccrSettingsIndex).toBeGreaterThan(-1);
    expect(JSON.parse(input.args[ccrSettingsIndex + 1]!)).toMatchObject({
      apiKeyHelper: expect.stringContaining("scripts/ccr-api-key-helper.mjs")
    });
    expect(input.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://host.docker.internal:3456",
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: CCR_GPT_MODEL_ID,
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_ENABLE_TELEMETRY: undefined,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(CCR_GPT_EFFECTIVE_CONTEXT_TOKENS),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CCR_GPT_AUTO_COMPACT_WINDOW_TOKENS),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(CCR_GPT_AUTO_COMPACT_PERCENT),
      CLAUDE_CONFIG_DIR: expect.stringContaining("/settings/claude/ccr"),
      OTEL_LOGS_EXPORTER: "none",
      VCM_TASK_SLUG: task.taskSlug
    });
    expect(JSON.stringify(input.env)).not.toContain("local-ccr-secret");
    expect(input.command).toBe("claude");
    expect(probeKeys).toEqual(["local-ccr-secret"]);
  });

  it("keeps native launches clean and blocks future CCR launches after disabling", async () => {
    const env = await createMockClaudeE2eApp({
      ccrBaseEnv: {
        ANTHROPIC_BASE_URL: "http://host.docker.internal:3456",
        ANTHROPIC_AUTH_TOKEN: "inherited-ccr-token",
        ANTHROPIC_MODEL: CCR_GPT_MODEL_ID,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
      }
    });
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
    expect(nativeInput.args).toEqual(expect.arrayContaining(["--plugin-dir", VCM_LSP_PLUGIN_DIR]));
    expect(nativeInput.args).toEqual(expect.arrayContaining([
      "--disallowedTools",
      CODE_ROLE_RUNTIME_DISALLOWED_TOOLS.join(",")
    ]));
    expect(nativeInput.args).not.toContain("--allowedTools");
    expect(nativeInput.env.ENABLE_LSP_TOOL).toBe("true");
    expect(nativeInput.args).not.toContain("--settings");
    expect(nativeInput.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(nativeInput.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(nativeInput.env.ANTHROPIC_MODEL).toBeUndefined();
    expect(nativeInput.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined();
    expect(nativeInput.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(nativeInput.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(nativeInput.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();
    expect(nativeInput.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(nativeInput.env.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(nativeInput.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe("http/json");
    expect(nativeInput.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toMatch(/\/api\/telemetry\/v1\/logs$/);
    expect(nativeInput.env.OTEL_RESOURCE_ATTRIBUTES).toMatch(
      /^vcm\.role=architect,vcm\.launch_id=[0-9a-f-]+$/
    );

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

  it("uses the same CCR launch path for Reviewer and auxiliary sessions", async () => {
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
        url: `/api/tasks/${task.taskSlug}/sessions/reviewer/start`,
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
      const settingsIndex = input.args.indexOf("--settings");
      expect(settingsIndex).toBeGreaterThan(-1);
      expect(JSON.parse(input.args[settingsIndex + 1]!)).toMatchObject({
        apiKeyHelper: expect.stringContaining("scripts/ccr-api-key-helper.mjs")
      });
      expect(input.env).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_MODEL: CCR_GPT_MODEL_ID,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(CCR_GPT_EFFECTIVE_CONTEXT_TOKENS),
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CCR_GPT_AUTO_COMPACT_WINDOW_TOKENS),
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(CCR_GPT_AUTO_COMPACT_PERCENT),
        CLAUDE_CONFIG_DIR: expect.stringContaining("/settings/claude/ccr")
      });
    }

    const reviewerInput = env.mockRuntime.getCreateInput(launches[0].json<{ id: string }>().id);
    expect(reviewerInput.args).toEqual(expect.arrayContaining(["--plugin-dir", VCM_LSP_PLUGIN_DIR]));
    expect(reviewerInput.args).toEqual(expect.arrayContaining([
      "--disallowedTools",
      REVIEWER_RUNTIME_DISALLOWED_TOOLS.join(",")
    ]));
    expect(reviewerInput.args).not.toContain("--allowedTools");
    expect(reviewerInput.env.ENABLE_LSP_TOOL).toBe("true");
    for (const auxiliary of launches.slice(1)) {
      const auxiliaryInput = env.mockRuntime.getCreateInput(auxiliary.json<{ id: string }>().id);
      expect(auxiliaryInput.args).not.toContain("--plugin-dir");
      expect(auxiliaryInput.args).toEqual(expect.arrayContaining(["--allowedTools", "Glob,Grep"]));
      expect(auxiliaryInput.env.ENABLE_LSP_TOOL).toBeUndefined();
    }
  });

  it("keeps Resume on the recorded provider and uses Restart to switch providers", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "ccr-provider-switch");
    await env.app.inject({
      method: "PUT",
      url: "/api/settings/ccr",
      payload: { apiKey: "saved", enabled: true }
    });

    env.mockRuntime.onPrompt("project-manager", "Persist this CCR session", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("CCR session persisted.");
      await ctx.stop();
    });

    const started = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/project-manager/start`,
      payload: roleLaunchBody({ model: CCR_GPT_SESSION_MODEL })
    });
    expect(started.statusCode).toBe(200);
    const startedSession = started.json<{ id: string }>();
    env.mockRuntime.write(startedSession.id, "Persist this CCR session");
    await env.mockRuntime.waitForIdle();

    const stopped = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/project-manager/stop`
    });
    expect(stopped.statusCode).toBe(200);
    const persisted = stopped.json<{ claudeSessionId: string; claudeConfigDir: string }>();
    expect(persisted.claudeSessionId).toMatch(/^mock-claude-project-manager-/);
    expect(persisted.claudeConfigDir).toContain("/settings/claude/ccr");

    const blockedNativeResume = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/project-manager/resume`,
      payload: roleLaunchBody({ model: "opus" })
    });
    expect(blockedNativeResume.statusCode).toBe(409);
    expect(blockedNativeResume.body).toContain("SESSION_PROVIDER_SWITCH_REQUIRES_RESTART");

    const resumed = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/project-manager/resume`,
      payload: roleLaunchBody({ model: CCR_GPT_SESSION_MODEL })
    });
    expect(resumed.statusCode).toBe(200);
    const resumedSession = resumed.json<{ id: string; claudeConfigDir: string }>();
    expect(resumedSession.claudeConfigDir).toBe(persisted.claudeConfigDir);
    const resumedInput = env.mockRuntime.getCreateInput(resumedSession.id);
    expect(resumedInput.args).toEqual(expect.arrayContaining([
      "--resume",
      persisted.claudeSessionId
    ]));
    expect(resumedInput.env.CLAUDE_CONFIG_DIR).toBe(persisted.claudeConfigDir);
    expect(resumedInput.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe(String(CCR_GPT_EFFECTIVE_CONTEXT_TOKENS));
    expect(resumedInput.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
      .toBe(String(CCR_GPT_AUTO_COMPACT_WINDOW_TOKENS));
    expect(resumedInput.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
      .toBe(String(CCR_GPT_AUTO_COMPACT_PERCENT));

    const restarted = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/project-manager/restart`,
      payload: roleLaunchBody({ model: "opus" })
    });
    expect(restarted.statusCode).toBe(200);
    const restartedSession = restarted.json<{ id: string; model: string; claudeConfigDir?: string }>();
    expect(restartedSession.model).toBe("opus");
    expect(restartedSession.claudeConfigDir).toBeUndefined();
    const restartedInput = env.mockRuntime.getCreateInput(restartedSession.id);
    expect(restartedInput.args).toEqual(expect.arrayContaining(["--model", "opus"]));
    expect(restartedInput.args).not.toContain("--resume");
    expect(restartedInput.args).not.toContain("--settings");
    expect(restartedInput.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(restartedInput.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(restartedInput.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(restartedInput.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(restartedInput.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();

    const restartedWithCcr = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/sessions/project-manager/restart`,
      payload: roleLaunchBody({ model: CCR_GPT_SESSION_MODEL })
    });
    expect(restartedWithCcr.statusCode).toBe(200);
    const ccrRestartInput = env.mockRuntime.getCreateInput(restartedWithCcr.json<{ id: string }>().id);
    expect(ccrRestartInput.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe(String(CCR_GPT_EFFECTIVE_CONTEXT_TOKENS));
    expect(ccrRestartInput.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
      .toBe(String(CCR_GPT_AUTO_COMPACT_WINDOW_TOKENS));
    expect(ccrRestartInput.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
      .toBe(String(CCR_GPT_AUTO_COMPACT_PERCENT));
  });

  it("applies the CCR context limit through one-click launch", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "ccr-one-click");
    await env.app.inject({
      method: "PUT",
      url: "/api/settings/ccr",
      payload: { apiKey: "saved", enabled: true }
    });

    const preferences = await getPreferences(env.app);
    for (const role of ["project-manager", "architect", "coder", "tester"] as const) {
      preferences.launchTemplate.roles[role].model = CCR_GPT_SESSION_MODEL;
    }
    await updatePreferences(env.app, { launchTemplate: preferences.launchTemplate });

    const response = await env.app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskSlug}/one-click-start`
    });
    expect(response.statusCode).toBe(200);

    for (const role of ["project-manager", "architect", "coder", "tester"] as const) {
      const session = env.mockRuntime.getSessionByRole(task.taskSlug, role);
      expect(session).toBeDefined();
      const input = env.mockRuntime.getCreateInput(session!.id);
      expect(input.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
        .toBe(String(CCR_GPT_EFFECTIVE_CONTEXT_TOKENS));
      expect(input.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
        .toBe(String(CCR_GPT_AUTO_COMPACT_WINDOW_TOKENS));
      expect(input.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
        .toBe(String(CCR_GPT_AUTO_COMPACT_PERCENT));
    }
  });
});
