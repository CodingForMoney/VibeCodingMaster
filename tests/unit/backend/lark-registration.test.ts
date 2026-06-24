import { describe, expect, it } from "vitest";
import { createLarkRegistrationClient } from "../../../src/backend/gateway/channels/lark-registration.js";

describe("lark-registration", () => {
  it("uses VCM QR parameters and parses data-wrapped registration responses", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlText = String(url);
      requests.push({
        url: urlText,
        body: init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "")
      });
      if (urlText.includes("/oauth/v1/app/registration") && requests.length === 1) {
        return jsonResponse({
          data: {
            supported_auth_methods: ["client_secret"]
          }
        });
      }
      if (urlText.includes("/oauth/v1/app/registration") && requests.length === 2) {
        return jsonResponse({
          data: {
            device_code: "device-1",
            verification_uri_complete: "https://accounts.larksuite.com/qr?existing=1",
            user_code: "ABCD",
            interval: 3,
            expire_in: 600
          }
        });
      }
      if (urlText.includes("/oauth/v1/app/registration") && requests.length === 3) {
        return jsonResponse({
          data: {
            client_id: "cli_test",
            client_secret: "secret_test",
            user_info: {
              tenant_brand: "lark",
              open_id: "ou_user"
            }
          }
        });
      }
      if (urlText.includes("/open-apis/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({
          tenant_access_token: "tenant-token"
        });
      }
      if (urlText.includes("/open-apis/bot/v3/info")) {
        return jsonResponse({
          code: 0,
          bot: {
            app_name: "VCM Bot",
            open_id: "ou_bot"
          }
        });
      }
      throw new Error(`Unexpected request: ${urlText}`);
    };
    const client = createLarkRegistrationClient({ fetch: fetchMock as typeof fetch });

    await client.init("lark");
    const begin = await client.begin("lark");
    const result = await client.poll({ domain: "lark", deviceCode: begin.deviceCode });

    expect(begin).toEqual({
      domain: "lark",
      deviceCode: "device-1",
      qrUrl: "https://accounts.larksuite.com/qr?existing=1&from=vcm&tp=vcm",
      userCode: "ABCD",
      intervalSeconds: 3,
      expiresInSeconds: 600
    });
    expect(requests[2]?.body).toBe("action=poll&device_code=device-1&tp=ob_app");
    expect(result).toEqual({
      status: "confirmed",
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      openId: "ou_user",
      botName: "VCM Bot",
      botOpenId: "ou_bot"
    });
  });
});

function jsonResponse(input: unknown, status = 200): Response {
  return new Response(JSON.stringify(input), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
