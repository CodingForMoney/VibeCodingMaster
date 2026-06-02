import type { FastifyInstance } from "fastify";
import type { UpdateAppPreferencesRequest } from "../../shared/types/app-settings.js";
import type { AppSettingsService } from "../services/app-settings-service.js";

export interface AppSettingsRouteDeps {
  appSettings: Pick<AppSettingsService, "getPreferences" | "updatePreferences">;
}

export function registerAppSettingsRoutes(app: FastifyInstance, deps: AppSettingsRouteDeps): void {
  app.get("/api/settings/preferences", async () => {
    return deps.appSettings.getPreferences();
  });

  app.put<{ Body: UpdateAppPreferencesRequest }>("/api/settings/preferences", async (request) => {
    return deps.appSettings.updatePreferences(request.body ?? {});
  });
}
