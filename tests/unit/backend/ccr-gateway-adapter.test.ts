import { describe, expect, it, vi } from "vitest";
import { createCcrGatewayAdapter } from "../../../src/backend/adapters/ccr-gateway-adapter.js";
import { CCR_GPT_MODEL_ID } from "../../../src/shared/types/session.js";

describe("createCcrGatewayAdapter", () => {
  it("verifies CCR identity and discovers GPT-5.6 Sol with the saved API key", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ name: "claude-code-router" }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: CCR_GPT_MODEL_ID }] }));
    const adapter = createCcrGatewayAdapter({
      baseUrl: "http://127.0.0.1:3456/",
      fetch: fetchMock
    });

    await expect(adapter.probe("local-secret")).resolves.toEqual({
      connectionState: "available",
      modelAvailable: true
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://127.0.0.1:3456/v1/models", expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer local-secret",
        "user-agent": "Claude Code"
      })
    }));
  });

  it("recognizes the encoded model id returned by CCR", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ name: "claude-code-router" }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          id: "anthropic/claude-ccr-h436f646578204150492f6770742d352e362d736f6c",
          display_name: "Codex API/GPT-5.6 Sol"
        }]
      }));
    const adapter = createCcrGatewayAdapter({ fetch: fetchMock });

    await expect(adapter.probe("secret")).resolves.toEqual({
      connectionState: "available",
      modelAvailable: true
    });
  });

  it("decodes a CCR model id when display_name is absent", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ core: "next-ai-gateway" }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: "anthropic/claude-ccr-h436f646578204150492f6770742d352e362d736f6c" }]
      }));
    const adapter = createCcrGatewayAdapter({ fetch: fetchMock });

    await expect(adapter.probe("secret")).resolves.toMatchObject({
      connectionState: "available",
      modelAvailable: true
    });
  });

  it("rejects an endpoint that does not identify as CCR", async () => {
    const adapter = createCcrGatewayAdapter({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ name: "another-gateway" }))
    });

    await expect(adapter.probe("secret")).resolves.toMatchObject({
      connectionState: "not-ccr",
      modelAvailable: false
    });
  });

  it("reports a rejected API key without including it in the error", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ core: "next-ai-gateway" }))
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const adapter = createCcrGatewayAdapter({ fetch: fetchMock });

    const result = await adapter.probe("private-key-value");
    expect(result).toMatchObject({ connectionState: "unauthorized", modelAvailable: false });
    expect(result.error).not.toContain("private-key-value");
  });

  it("reports a missing required model", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ plugin: "claude-code-router" }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "another-model" }] }));
    const adapter = createCcrGatewayAdapter({ fetch: fetchMock });

    await expect(adapter.probe("secret")).resolves.toMatchObject({
      connectionState: "available",
      modelAvailable: false,
      error: expect.stringContaining(CCR_GPT_MODEL_ID)
    });
  });

  it("reports invalid model discovery payloads", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ name: "claude-code-router" }))
      .mockResolvedValueOnce(jsonResponse({ models: [] }));
    const adapter = createCcrGatewayAdapter({ fetch: fetchMock });

    await expect(adapter.probe("secret")).resolves.toMatchObject({
      connectionState: "invalid-response",
      modelAvailable: false
    });
  });

  it("reports an unreachable fixed endpoint", async () => {
    const adapter = createCcrGatewayAdapter({
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("connect refused"))
    });

    await expect(adapter.probe("secret")).resolves.toMatchObject({
      connectionState: "unreachable",
      error: expect.stringContaining("host.docker.internal:3456")
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
