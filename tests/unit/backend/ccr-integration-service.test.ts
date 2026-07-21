import { describe, expect, it } from "vitest";
import { createCcrIntegrationService, mergeNoProxy } from "../../../src/backend/services/ccr-integration-service.js";
import type { AppCcrIntegrationSettingsState } from "../../../src/backend/services/app-settings-service.js";
import { CCR_GPT_MODEL_ID, CCR_GPT_SESSION_MODEL } from "../../../src/shared/types/session.js";

describe("createCcrIntegrationService", () => {
  it("requires a saved API key before enabling CCR", async () => {
    const service = createService();

    await expect(service.updateSettings({ enabled: true })).rejects.toMatchObject({
      code: "CCR_API_KEY_MISSING"
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      enabled: false,
      apiKeyConfigured: false,
      connectionState: "disabled"
    });
  });

  it("builds the complete child-only CCR environment without exposing the key in status", async () => {
    const service = createService({ baseEnv: { NO_PROXY: "localhost" } });
    const saved = await service.updateSettings({ apiKey: "local-secret" });
    expect(saved).toMatchObject({ enabled: false, apiKeyConfigured: true });
    expect(JSON.stringify(saved)).not.toContain("local-secret");

    const enabled = await service.updateSettings({ enabled: true });
    expect(enabled).toMatchObject({
      enabled: true,
      connectionState: "available",
      modelAvailable: true
    });
    const environment = await service.getLaunchEnvironment(CCR_GPT_SESSION_MODEL);
    expect(environment).toMatchObject({
      ANTHROPIC_BASE_URL: "http://host.docker.internal:3456",
      ANTHROPIC_API_BASE_URL: "http://host.docker.internal:3456",
      CLAUDE_AGENT_API_BASE_URL: "http://host.docker.internal:3456",
      ANTHROPIC_AUTH_TOKEN: "local-secret",
      ANTHROPIC_MODEL: CCR_GPT_MODEL_ID,
      CCR_CLAUDE_CODE_MODEL: CCR_GPT_MODEL_ID,
      CODEXL_CLAUDE_CODE_MODEL: CCR_GPT_MODEL_ID,
      ANTHROPIC_SMALL_FAST_MODEL: CCR_GPT_MODEL_ID,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      NO_PROXY: "localhost,host.docker.internal",
      no_proxy: "localhost,host.docker.internal"
    });
  });

  it("does not inject CCR environment for native Claude models", async () => {
    const service = createService();
    await expect(service.getLaunchEnvironment("opus")).resolves.toEqual({});
  });

  it("blocks CCR-backed launches while disabled or unavailable", async () => {
    const disabled = createService();
    await expect(disabled.getLaunchEnvironment(CCR_GPT_SESSION_MODEL)).rejects.toMatchObject({
      code: "CCR_DISABLED"
    });

    const unavailable = createService({
      initial: { version: 1, enabled: true, apiKey: "saved" },
      probeResult: {
        connectionState: "unreachable",
        modelAvailable: false,
        error: "CCR is offline."
      }
    });
    await expect(unavailable.getLaunchEnvironment(CCR_GPT_SESSION_MODEL)).rejects.toMatchObject({
      code: "CCR_MODEL_UNAVAILABLE",
      message: "CCR is offline."
    });
  });

  it("shares a fresh connection check across launches", async () => {
    let probes = 0;
    const service = createService({
      initial: { version: 1, enabled: true, apiKey: "saved" },
      onProbe() {
        probes += 1;
      }
    });

    await Promise.all([
      service.getLaunchEnvironment(CCR_GPT_SESSION_MODEL),
      service.getLaunchEnvironment(CCR_GPT_SESSION_MODEL),
      service.getLaunchEnvironment(CCR_GPT_SESSION_MODEL)
    ]);
    expect(probes).toBe(1);
  });
});

describe("mergeNoProxy", () => {
  it("adds the host once and preserves existing entries", () => {
    expect(mergeNoProxy("localhost, host.docker.internal", "host.docker.internal"))
      .toBe("localhost,host.docker.internal");
  });
});

function createService(options: {
  initial?: AppCcrIntegrationSettingsState;
  probeResult?: {
    connectionState: "available" | "unreachable";
    modelAvailable: boolean;
    error?: string;
  };
  onProbe?(): void;
  baseEnv?: NodeJS.ProcessEnv;
} = {}) {
  let settings = options.initial ?? { version: 1, enabled: false, apiKey: "" };
  return createCcrIntegrationService({
    settings: {
      async getCcrIntegrationSettings() {
        return settings;
      },
      async updateCcrIntegrationSettings(input) {
        settings = { ...settings, ...input };
        return settings;
      }
    },
    gateway: {
      async probe() {
        options.onProbe?.();
        return options.probeResult ?? { connectionState: "available", modelAvailable: true };
      }
    },
    baseEnv: options.baseEnv
  });
}
