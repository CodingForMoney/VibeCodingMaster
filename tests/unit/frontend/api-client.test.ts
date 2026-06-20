import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../../src/frontend/state/api-client.js";

describe("apiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send a json content-type for bodyless POST requests", async () => {
    const fetchMock = mockFetch({
      commandPath: ".ai/vcm/handoffs/role-commands/coder.md",
      dispatchedAt: "2026-05-29T00:00:00.000Z",
      instruction: "Read the command file.",
      role: "coder",
      taskSlug: "demo-task"
    });

    await apiClient.dispatchRoleCommand("demo-task", "coder");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("sends a json content-type when a request has a body", async () => {
    const fetchMock = mockFetch({
      branch: "feature/vcm",
      isDirty: false,
      repoRoot: "/repo",
      warnings: []
    });

    await apiClient.connectProject({ repoPath: "/repo" });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ repoPath: "/repo" }));
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("loads recent repository paths", async () => {
    const fetchMock = mockFetch(["/workspace", "/repo"]);

    const paths = await apiClient.getRecentRepositoryPaths();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/recent");
    expect(paths).toEqual(["/workspace", "/repo"]);
  });

  it("loads runtime diagnostics", async () => {
    const fetchMock = mockFetch({
      version: "0.3.6",
      pid: 123,
      cwd: "/workspace",
      execPath: "/usr/bin/node",
      nodeVersion: "v20.20.2",
      platform: "linux",
      arch: "x64",
      uptimeSeconds: 12,
      fdCount: 42,
      openFilesLimit: { soft: "1024", hard: "1048576" },
      runtimeSessions: { total: 0, running: 0 },
      gateway: { polling: false },
      translation: { sessions: 0, transcriptWatchers: 0, listeners: 0 }
    });

    const diagnostics = await apiClient.getRuntimeDiagnostics();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/diagnostics/runtime");
    expect(diagnostics.pid).toBe(123);
  });

  it("adds backend runtime info to API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: "boom",
        runtime: {
          version: "0.3.6",
          pid: 123,
          cwd: "/workspace"
        }
      }
    }), {
      headers: { "content-type": "application/json" },
      status: 500
    })));

    await expect(apiClient.getCurrentProject()).rejects.toThrow(
      "boom [backend 0.3.6 pid=123 cwd=/workspace]"
    );
  });

  it("pulls the connected repository with a bodyless POST", async () => {
    const fetchMock = mockFetch({
      branch: "main",
      isDirty: false,
      repoRoot: "/repo",
      warnings: []
    });

    await apiClient.pullCurrentProject();

    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/current/pull");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("marks all messages done with a bodyless POST", async () => {
    const fetchMock = mockFetch({
      taskSlug: "demo-task",
      updatedCount: 2,
      messages: []
    });

    await apiClient.markAllMessagesDone("demo-task");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tasks/demo-task/messages/mark-all-done");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("deletes message history with a bodyless DELETE", async () => {
    const fetchMock = mockFetch({
      taskSlug: "demo-task",
      deletedCount: 3,
      messages: []
    });

    await apiClient.deleteMessageHistory("demo-task");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tasks/demo-task/messages/history");
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("updates app preferences", async () => {
    const fetchMock = mockFetch({
      themeMode: "dark",
      flowPauseAlerts: false
    });

    const preferences = await apiClient.updateAppPreferences({
      themeMode: "dark",
      flowPauseAlerts: false
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/settings/preferences");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      themeMode: "dark",
      flowPauseAlerts: false
    });
    expect(preferences.themeMode).toBe("dark");
    expect(preferences.flowPauseAlerts).toBe(false);
  });

  it("sends translation API keys in the settings request body", async () => {
    const fetchMock = mockFetch({
      version: 1,
      enabled: true,
      providerType: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-local-test",
      model: "cheap-translator",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      workingLanguage: "en",
      inputMode: "review-before-send",
      translateOutput: true,
      translateUserInput: true,
      contextEnabled: false,
      preserveTechnicalTokens: true,
      skipCjkText: true,
      redactSecrets: true,
      requestTimeoutMs: 120000,
      temperature: 0.1
    });

    await apiClient.updateTranslationSettings({
      enabled: true,
      model: "cheap-translator",
      apiKey: "sk-local-test"
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      enabled: true,
      model: "cheap-translator",
      apiKey: "sk-local-test"
    });
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("loads translation prompt previews", async () => {
    const fetchMock = mockFetch([{
      key: "zh-to-en",
      label: "zh-to-en",
      defaultPrompt: "DEFAULT",
      userPrompt: "USER",
      customized: true
    }]);

    const prompts = await apiClient.getTranslationPrompts();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/translation/prompts");
    expect(prompts[0]?.userPrompt).toBe("USER");
  });

  it("starts and polls translation sessions through HTTP APIs", async () => {
    const fetchMock = mockFetch({
      sessionId: "session-1",
      status: "ready",
      nextCursor: 1,
      events: []
    });

    await apiClient.startTranslationSession("demo-task", "coder");
    await apiClient.pollTranslationSession("session-1", 18, 100);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tasks/demo-task/sessions/coder/translation/start");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/translation/sessions/session-1/events?after=18&limit=100");
  });

  it("calls translation failure queue APIs with bodyless POST requests", async () => {
    const fetchMock = mockFetch({ failures: [] });

    await apiClient.ignoreTranslationFailures("session-1");
    await apiClient.retryTranslationFailures("session-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/translation/sessions/session-1/failures/ignore");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/translation/sessions/session-1/failures/retry");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it("browses Codex translation source files with encoded query params", async () => {
    const fetchMock = mockFetch({
      currentPath: "docs/specs",
      query: "white paper",
      entries: [],
      truncated: false
    });

    await apiClient.browseCodexTranslationSourceFiles({
      path: "docs/specs",
      query: "white paper",
      limit: 25
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/translation/codex/source-files?path=docs%2Fspecs&query=white+paper&limit=25");
  });

  it("calls gateway status and settings APIs", async () => {
    const fetchMock = mockFetch({
      version: 1,
      enabled: true,
      running: true,
      channel: "weixin-ilink",
      translationEnabled: true,
      currentProjectId: "/repo",
      currentTaskSlug: "gateway-demo",
      binding: {
        accountId: "bot",
        baseUrl: "https://ilinkai.weixin.qq.com",
        boundUserId: "user",
        loginUserId: "user",
        tokenConfigured: true
      },
      pendingConfirmations: {},
      lastPollStatus: { state: "running" },
      lastMessageStatus: null,
      updatedAt: "2026-06-10T00:00:00.000Z"
    });

    await apiClient.getGatewayStatus();
    await apiClient.updateGatewaySettings({ enabled: false, translationEnabled: false });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/gateway/status");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/gateway/settings");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      enabled: false,
      translationEnabled: false
    });
  });

  it("calls gateway QR and binding APIs", async () => {
    const fetchMock = mockFetch({
      status: "wait",
      qrcode: "qr",
      qrcodeUrl: "data:image/png;base64,abc",
      expiresAt: "2026-06-10T00:08:00.000Z"
    });

    await apiClient.startGatewayQrLogin();
    await apiClient.checkGatewayQrLogin();
    await apiClient.resetGatewayBinding();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/gateway/qr/start");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/gateway/qr/check");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({}));
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/gateway/binding/reset");
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBeUndefined();
  });
});

function mockFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
