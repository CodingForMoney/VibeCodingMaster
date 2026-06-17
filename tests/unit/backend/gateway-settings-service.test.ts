import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewaySettingsService } from "../../../src/backend/gateway/gateway-settings-service.js";

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
});
