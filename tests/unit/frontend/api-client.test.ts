import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../../src/frontend/state/api-client.js";

describe("apiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send a json content-type for bodyless POST requests", async () => {
    const fetchMock = mockFetch({
      commandPath: ".ai/handoffs/demo-task/role-commands/coder.md",
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
});

function mockFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
