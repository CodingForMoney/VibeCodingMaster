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

  it("applies harness changes for the active task", async () => {
    const fetchMock = mockFetch({
      version: 1,
      changedFiles: [],
      harnessCommit: "abc1234",
      message: "done"
    });

    await apiClient.applyHarness({ taskSlug: "demo-task" });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/harness/apply");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      taskSlug: "demo-task"
    });
  });

  it("loads repository diff with the selected commit", async () => {
    const fetchMock = mockFetch({
      version: 1,
      repoRoot: "/repo",
      sourceBranch: "feature/demo-task",
      targetBranch: "release/v0.4",
      generatedAt: "2026-06-23T00:00:00.000Z",
      commits: [],
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
    });

    await apiClient.getRepositoryDiff("demo-task", "abc1234567890");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/harness/repository-diff?taskSlug=demo-task&commit=abc1234567890");
  });

  it("merges repository diff to the connected repository current branch", async () => {
    const fetchMock = mockFetch({
      version: 1,
      baseRepoRoot: "/repo",
      taskRepoRoot: "/repo/.claude/worktrees/demo-task",
      sourceBranch: "feature/demo-task",
      targetBranch: "release/v0.4",
      beforeSha: "base123",
      afterSha: "abc123",
      changed: true,
      stdout: "Fast-forward",
      stderr: "",
      mergedAt: "2026-06-23T00:00:00.000Z"
    });

    await apiClient.mergeRepositoryDiffToCurrentBranch("demo-task");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/harness/repository-diff/merge-to-current-branch");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ taskSlug: "demo-task" });
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
      flowPauseAlerts: false,
      roleRetryEnabled: false,
      autoTaskHarnessReviewEnabled: true
    });

    const preferences = await apiClient.updateAppPreferences({
      themeMode: "dark",
      flowPauseAlerts: false,
      roleRetryEnabled: false,
      autoTaskHarnessReviewEnabled: true
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/settings/preferences");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      themeMode: "dark",
      flowPauseAlerts: false,
      roleRetryEnabled: false,
      autoTaskHarnessReviewEnabled: true
    });
    expect(preferences.themeMode).toBe("dark");
    expect(preferences.flowPauseAlerts).toBe(false);
    expect(preferences.roleRetryEnabled).toBe(false);
    expect(preferences.autoTaskHarnessReviewEnabled).toBe(true);
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

  it("browses translation source files with encoded query params", async () => {
    const fetchMock = mockFetch({
      currentPath: "docs/specs",
      query: "white paper",
      entries: [],
      truncated: false
    });

    await apiClient.browseTranslationSourceFiles({
      path: "docs/specs",
      query: "white paper",
      limit: 25
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/translation/source-files?path=docs%2Fspecs&query=white+paper&limit=25");
  });

  it("queues translation memory updates", async () => {
    const fetchMock = mockFetch({
      id: "queue-memory-update",
      type: "memory-update",
      status: "queued",
      targetLanguage: "zh-CN",
      jobId: "memory-update-1",
      requestPath: ".ai/vcm/translations/runtime/memory-updates/memory-update-1/request.json"
    });

    await apiClient.createTranslationMemoryUpdate({
      taskSlug: "demo-task",
      targetLanguage: "zh-CN"
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/translation/memory-update");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      taskSlug: "demo-task",
      targetLanguage: "zh-CN"
    });
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
