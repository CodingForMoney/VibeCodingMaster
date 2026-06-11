import type { FastifyInstance } from "fastify";
import type {
  CheckGatewayQrLoginRequest,
  UpdateGatewaySettingsRequest
} from "../../shared/types/gateway.js";
import type { GatewayService } from "../gateway/gateway-service.js";

export interface GatewayRouteDeps {
  gatewayService: GatewayService;
}

export function registerGatewayRoutes(app: FastifyInstance, deps: GatewayRouteDeps): void {
  app.get("/api/gateway/status", async () => {
    return deps.gatewayService.getStatus();
  });

  app.put<{ Body: UpdateGatewaySettingsRequest }>("/api/gateway/settings", async (request) => {
    return deps.gatewayService.updateSettings(request.body);
  });

  app.post("/api/gateway/qr/start", async () => {
    return deps.gatewayService.startQrLogin();
  });

  app.post<{ Body: CheckGatewayQrLoginRequest }>("/api/gateway/qr/check", async (request) => {
    return deps.gatewayService.checkQrLogin(request.body);
  });

  app.post("/api/gateway/binding/reset", async () => {
    return deps.gatewayService.resetBinding();
  });
}
