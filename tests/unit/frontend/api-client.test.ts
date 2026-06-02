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
      roundCompletionAlerts: false
    });

    const preferences = await apiClient.updateAppPreferences({
      themeMode: "dark",
      roundCompletionAlerts: false
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/settings/preferences");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      themeMode: "dark",
      roundCompletionAlerts: false
    });
    expect(preferences.themeMode).toBe("dark");
    expect(preferences.roundCompletionAlerts).toBe(false);
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
      contextEnabled: true,
      preserveTechnicalTokens: true,
      skipCjkText: true,
      redactSecrets: true,
      requestTimeoutMs: 15000,
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
});

function mockFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
