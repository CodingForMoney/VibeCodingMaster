import type { FastifyInstance } from "fastify";
import type {
  UpdateAppPreferencesRequest,
  UpdateCodexBridgeIntegrationRequest
} from "../../shared/types/app-settings.js";
import type { AppSettingsService } from "../services/app-settings-service.js";
import type { CodexBridgeIntegrationService } from "../services/codex-bridge-integration-service.js";

export interface AppSettingsRouteDeps {
  appSettings: Pick<AppSettingsService, "getPreferences" | "updatePreferences">;
  codexBridgeIntegration: Pick<
    CodexBridgeIntegrationService,
    "getStatus" | "updateSettings" | "checkConnection"
  >;
}

export function registerAppSettingsRoutes(app: FastifyInstance, deps: AppSettingsRouteDeps): void {
  app.get("/api/settings/preferences", async () => {
    return deps.appSettings.getPreferences();
  });

  app.put<{ Body: UpdateAppPreferencesRequest }>("/api/settings/preferences", async (request) => {
    return deps.appSettings.updatePreferences(request.body ?? {});
  });

  app.get("/api/settings/codex-bridge", async () => {
    return deps.codexBridgeIntegration.getStatus();
  });

  app.put<{ Body: UpdateCodexBridgeIntegrationRequest }>("/api/settings/codex-bridge", async (request) => {
    return deps.codexBridgeIntegration.updateSettings(request.body ?? {});
  });

  app.post("/api/settings/codex-bridge/check", async () => {
    return deps.codexBridgeIntegration.checkConnection();
  });
}
