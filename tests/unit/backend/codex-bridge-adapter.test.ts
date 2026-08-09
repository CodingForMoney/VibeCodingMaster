import { describe, expect, it, vi } from "vitest";
import { createCodexBridgeAdapter } from "../../../src/backend/adapters/codex-bridge-adapter.js";

describe("createCodexBridgeAdapter", () => {
  it("verifies Bridge health, Codex auth, and the dynamic model catalog", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "codex-bridge" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ready" }))
      .mockResolvedValueOnce(jsonResponse({
        object: "list",
        data: [
          { id: "gpt-5.5", display_name: "GPT-5.5" },
          { id: "gpt-5.4" }
        ]
      }));
    const adapter = createCodexBridgeAdapter({
      baseUrl: "http://127.0.0.1:3456/",
      fetch: fetchMock
    });

    await expect(adapter.probe("local-secret")).resolves.toEqual({
      connectionState: "available",
      modelAvailable: true,
      models: [
        { id: "gpt-5.5", displayName: "GPT-5.5" },
        { id: "gpt-5.4" }
      ],
      baseUrl: "http://127.0.0.1:3456"
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "http://127.0.0.1:3456/v1/models", expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer local-secret",
        "user-agent": "VibeCodingMaster"
      })
    }));
  });

  it("falls back to the container host endpoint when localhost is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connect refused"))
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "codex-bridge" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ready" }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-5.5" }] }));
    const adapter = createCodexBridgeAdapter({ fetch: fetchMock });

    await expect(adapter.probe("secret")).resolves.toMatchObject({
      connectionState: "available",
      modelAvailable: true,
      models: [{ id: "gpt-5.5" }],
      baseUrl: "http://host.docker.internal:3456"
    });
  });

  it("rejects an endpoint that does not identify as Codex Bridge", async () => {
    const adapter = createCodexBridgeAdapter({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "ok", service: "another-gateway" }))
    });

    await expect(adapter.probe("secret")).resolves.toMatchObject({
      connectionState: "not-codex-bridge",
      modelAvailable: false,
      models: []
    });
  });

  it("reports a rejected Bridge API key without including it in the error", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "codex-bridge" }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "BRIDGE_UNAUTHORIZED" } }, 401));
    const adapter = createCodexBridgeAdapter({ fetch: fetchMock });

    const result = await adapter.probe("private-key-value");
    expect(result).toMatchObject({ connectionState: "unauthorized", modelAvailable: false });
    expect(result.error).not.toContain("private-key-value");
  });

  it("reports unavailable Codex credentials separately from a bad Bridge key", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "codex-bridge" }))
      .mockResolvedValueOnce(jsonResponse({
        state: "expired",
        message: "Codex credentials have expired."
      }));
    const adapter = createCodexBridgeAdapter({ fetch: fetchMock });

    await expect(adapter.probe("secret")).resolves.toMatchObject({
      connectionState: "codex-auth-unavailable",
      modelAvailable: false,
      error: "Codex credentials have expired."
    });
  });

  it("reports an empty model catalog", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "codex-bridge" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ready" }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const adapter = createCodexBridgeAdapter({ fetch: fetchMock });

    await expect(adapter.probe("secret")).resolves.toMatchObject({
      connectionState: "available",
      modelAvailable: false,
      models: [],
      error: "Codex Bridge did not expose any models."
    });
  });

  it("reports invalid model discovery payloads", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "codex-bridge" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ready" }))
      .mockResolvedValueOnce(jsonResponse({ models: [] }));
    const adapter = createCodexBridgeAdapter({ fetch: fetchMock });

    await expect(adapter.probe("secret")).resolves.toMatchObject({
      connectionState: "invalid-response",
      modelAvailable: false,
      models: []
    });
  });

  it("reports all unreachable automatic endpoints", async () => {
    const adapter = createCodexBridgeAdapter({
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("connect refused"))
    });

    const result = await adapter.probe("secret");
    expect(result).toMatchObject({
      connectionState: "unreachable",
      modelAvailable: false,
      models: []
    });
    expect(result.error).toContain("127.0.0.1:3456");
    expect(result.error).toContain("host.docker.internal:3456");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
