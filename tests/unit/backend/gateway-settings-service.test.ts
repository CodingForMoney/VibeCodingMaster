import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewaySettingsService,
  type GatewaySettingsFile
} from "../../../src/backend/gateway/gateway-settings-service.js";

describe("gateway-settings-service", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses VCM_DATA_DIR for default gateway settings and audit paths", () => {
    vi.stubEnv("VCM_DATA_DIR", "/workspace/.ai/vcm");
    const service = createGatewaySettingsService({
      fs: {} as never
    });

    expect(service.getSettingsPath()).toBe("/workspace/.ai/vcm/gateway/settings.json");
    expect(service.getAuditPath()).toBe("/workspace/.ai/vcm/gateway/audit.jsonl");
  });

  it("uses injected gateway defaults for new settings files", async () => {
    let written: GatewaySettingsFile | null = null;
    const service = createGatewaySettingsService({
      fs: {
        async pathExists() {
          return false;
        },
        async writeJsonAtomic(_path: string, value: GatewaySettingsFile) {
          written = value;
        }
      } as never,
      defaultChannel: "weixin-ilink",
      defaultBaseUrl: "https://gateway.example"
    });

    const settings = await service.loadSettings();

    expect(settings.channel).toBe("weixin-ilink");
    expect(settings.binding.baseUrl).toBe("https://gateway.example");
    expect(written?.binding.baseUrl).toBe("https://gateway.example");
  });

  it("preserves non-http gateway base URL schemes", async () => {
    const service = createGatewaySettingsService({
      fs: {
        async pathExists() {
          return false;
        },
        async writeJsonAtomic() {
          return undefined;
        }
      } as never,
      defaultChannel: "lark",
      defaultBaseUrl: "lark://open-platform"
    });

    const settings = await service.loadSettings();
    const updated = await service.updateSettings({ baseUrl: "lark://open-platform" });
    const repaired = await service.updateSettings({ baseUrl: "https://lark://open-platform" });

    expect(settings.binding.baseUrl).toBe("lark://open-platform");
    expect(updated.binding.baseUrl).toBe("lark://open-platform");
    expect(repaired.binding.baseUrl).toBe("lark://open-platform");
  });
});
