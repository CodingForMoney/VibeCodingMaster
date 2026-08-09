import { describe, expect, it } from "vitest";
import {
  createCodexBridgeIntegrationService,
  mergeNoProxy
} from "../../../src/backend/services/codex-bridge-integration-service.js";
import type { AppCodexBridgeIntegrationSettingsState } from "../../../src/backend/services/app-settings-service.js";
import {
  CODEX_BRIDGE_AUTO_COMPACT_PERCENT,
  CODEX_BRIDGE_AUTO_COMPACT_WINDOW_TOKENS,
  CODEX_BRIDGE_EFFECTIVE_CONTEXT_TOKENS,
  toCodexBridgeSessionModel
} from "../../../src/shared/types/session.js";

const MODEL_ID = "gpt-5.5";
const SESSION_MODEL = toCodexBridgeSessionModel(MODEL_ID);

describe("createCodexBridgeIntegrationService", () => {
  it("requires a saved API key before enabling Codex Bridge", async () => {
    const service = createService();

    await expect(service.updateSettings({ enabled: true })).rejects.toMatchObject({
      code: "CODEX_BRIDGE_API_KEY_MISSING"
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      enabled: false,
      apiKeyConfigured: false,
      connectionState: "disabled"
    });
  });

  it("discovers model options and builds an isolated Bridge launch environment", async () => {
    const service = createService({ baseEnv: { NO_PROXY: "localhost" } });
    const saved = await service.updateSettings({ apiKey: "local-secret" });
    expect(saved).toMatchObject({ enabled: false, apiKeyConfigured: true });
    expect(JSON.stringify(saved)).not.toContain("local-secret");

    const enabled = await service.updateSettings({ enabled: true });
    expect(enabled).toMatchObject({
      enabled: true,
      connectionState: "available",
      modelAvailable: true,
      modelOptions: expect.arrayContaining([
        expect.objectContaining({ value: SESSION_MODEL, source: "codex-bridge", available: true })
      ])
    });
    const environment = await service.getLaunchEnvironment(SESSION_MODEL);
    expect(environment).toMatchObject({
      ANTHROPIC_BASE_URL: "http://host.docker.internal:3456",
      ANTHROPIC_API_BASE_URL: "http://host.docker.internal:3456",
      CLAUDE_AGENT_API_BASE_URL: "http://host.docker.internal:3456",
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: MODEL_ID,
      CODEX_BRIDGE_CLAUDE_MODEL: MODEL_ID,
      ANTHROPIC_SMALL_FAST_MODEL: MODEL_ID,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_SUBAGENT_MODEL: MODEL_ID,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(CODEX_BRIDGE_EFFECTIVE_CONTEXT_TOKENS),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CODEX_BRIDGE_AUTO_COMPACT_WINDOW_TOKENS),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(CODEX_BRIDGE_AUTO_COMPACT_PERCENT),
      CLAUDE_CONFIG_DIR: "/mock/.vcm/claude/codex-bridge",
      NO_PROXY: "localhost,host.docker.internal",
      no_proxy: "localhost,host.docker.internal"
    });
    expect(JSON.stringify(environment)).not.toContain("local-secret");
  });

  it("does not inject Bridge environment for native Claude models", async () => {
    const service = createService({
      baseEnv: {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "123456",
        CLAUDE_CODE_SUBAGENT_MODEL: "sonnet"
      }
    });
    await expect(service.getLaunchEnvironment("opus")).resolves.toEqual({});
    await expect(service.getLaunchSettingsOverride("opus")).resolves.toBeUndefined();
  });

  it("removes inherited Bridge takeover variables from native Claude launches", async () => {
    const service = createService({
      baseEnv: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
        ANTHROPIC_AUTH_TOKEN: "bridge-token",
        ANTHROPIC_API_KEY: "bridge-key",
        ANTHROPIC_MODEL: MODEL_ID,
        CODEX_BRIDGE_CLAUDE_MODEL: MODEL_ID,
        CLAUDE_CODE_SUBAGENT_MODEL: MODEL_ID,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        CLAUDE_CONFIG_DIR: "/custom/native-claude"
      }
    });

    await expect(service.getLaunchEnvironment("sonnet")).resolves.toEqual({
      ANTHROPIC_BASE_URL: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: undefined,
      CODEX_BRIDGE_CLAUDE_MODEL: undefined,
      CLAUDE_CODE_SUBAGENT_MODEL: undefined,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: undefined,
      CLAUDE_CONFIG_DIR: "/custom/native-claude"
    });
  });

  it("applies apiKeyHelper only to Bridge sessions", async () => {
    const service = createService({
      initial: { version: 1, enabled: false, apiKey: "saved" },
      apiKeyHelperPath: "/mock/codex-bridge-api-key-helper.mjs"
    });

    await expect(service.getLaunchSettingsOverride("sonnet")).resolves.toBeUndefined();
    await expect(service.getLaunchSettingsOverride(SESSION_MODEL)).resolves.toMatchObject({
      apiKeyHelper: expect.stringContaining("/mock/codex-bridge-api-key-helper.mjs")
    });
  });

  it("launches through the endpoint identified by the probe", async () => {
    const service = createService({
      initial: { version: 1, enabled: true, apiKey: "saved" },
      baseEnv: { NO_PROXY: "localhost" },
      probeResult: {
        connectionState: "available",
        modelAvailable: true,
        models: [{ id: MODEL_ID }],
        baseUrl: "http://127.0.0.1:3456"
      }
    });

    await expect(service.getLaunchEnvironment(SESSION_MODEL)).resolves.toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
      NO_PROXY: "localhost,127.0.0.1"
    });
  });

  it("blocks Bridge launches while disabled, unavailable, or missing the selected model", async () => {
    const disabled = createService();
    await expect(disabled.getLaunchEnvironment(SESSION_MODEL)).rejects.toMatchObject({
      code: "CODEX_BRIDGE_DISABLED"
    });

    const unavailable = createService({
      initial: { version: 1, enabled: true, apiKey: "saved" },
      probeResult: {
        connectionState: "unreachable",
        modelAvailable: false,
        models: [],
        error: "Codex Bridge is offline."
      }
    });
    await expect(unavailable.getLaunchEnvironment(SESSION_MODEL)).rejects.toMatchObject({
      code: "CODEX_BRIDGE_MODEL_UNAVAILABLE",
      message: "Codex Bridge is offline."
    });

    const missingModel = createService({
      initial: { version: 1, enabled: true, apiKey: "saved" },
      probeResult: {
        connectionState: "available",
        modelAvailable: true,
        models: [{ id: "gpt-other" }]
      }
    });
    await expect(missingModel.getLaunchEnvironment(SESSION_MODEL)).rejects.toMatchObject({
      code: "CODEX_BRIDGE_MODEL_UNAVAILABLE",
      message: expect.stringContaining(MODEL_ID)
    });
  });

  it("shares a fresh connection check across concurrent launches", async () => {
    let probes = 0;
    const service = createService({
      initial: { version: 1, enabled: true, apiKey: "saved" },
      onProbe() {
        probes += 1;
      }
    });

    await Promise.all([
      service.getLaunchEnvironment(SESSION_MODEL),
      service.getLaunchEnvironment(SESSION_MODEL),
      service.getLaunchEnvironment(SESSION_MODEL)
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
  initial?: AppCodexBridgeIntegrationSettingsState;
  probeResult?: {
    connectionState: "available" | "unreachable";
    modelAvailable: boolean;
    models: Array<{ id: string; displayName?: string }>;
    baseUrl?: string;
    error?: string;
  };
  onProbe?(): void;
  apiKeyHelperPath?: string;
  baseEnv?: NodeJS.ProcessEnv;
  configDir?: string;
} = {}) {
  let settings = options.initial ?? { version: 1, enabled: false, apiKey: "" };
  return createCodexBridgeIntegrationService({
    settings: {
      async getCodexBridgeIntegrationSettings() {
        return settings;
      },
      async updateCodexBridgeIntegrationSettings(input) {
        settings = { ...settings, ...input };
        return settings;
      }
    },
    bridge: {
      async probe() {
        options.onProbe?.();
        return options.probeResult ?? {
          connectionState: "available",
          modelAvailable: true,
          models: [{ id: MODEL_ID, displayName: "GPT-5.5" }]
        };
      }
    },
    baseEnv: options.baseEnv ?? {},
    configDir: options.configDir ?? "/mock/.vcm/claude/codex-bridge",
    apiKeyHelperPath: options.apiKeyHelperPath
  });
}
