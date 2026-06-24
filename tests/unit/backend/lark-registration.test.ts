import { describe, expect, it } from "vitest";
import {
  createLarkRegistrationClient,
  type LarkRegistrationClientDeps,
  type LarkRegistrationPollResult
} from "../../../src/backend/gateway/channels/lark-registration.js";

describe("lark-registration", () => {
  it("uses the Lark SDK registration flow and parses returned app credentials", async () => {
    let resolveRegistration: (value: Awaited<ReturnType<NonNullable<LarkRegistrationClientDeps["registerApp"]>>>) => void = () => undefined;
    const registrationDone = new Promise<Awaited<ReturnType<NonNullable<LarkRegistrationClientDeps["registerApp"]>>>>((resolve) => {
      resolveRegistration = resolve;
    });
    let capturedOptions: Parameters<NonNullable<LarkRegistrationClientDeps["registerApp"]>>[0] | null = null;
    const registerApp: NonNullable<LarkRegistrationClientDeps["registerApp"]> = async (options) => {
      capturedOptions = options;
      options.onQRCodeReady({
        url: "https://open.larksuite.com/page/launcher?user_code=ABCD&from=sdk&tp=sdk&source=node-sdk%2Fvcm",
        expireIn: 600
      });
      return registrationDone;
    };
    const fetchMock = async (url: string | URL | Request): Promise<Response> => {
      const urlText = String(url);
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
    const client = createLarkRegistrationClient({
      fetch: fetchMock as typeof fetch,
      registerApp
    });

    await client.init("lark");
    const begin = await client.begin("lark");
    const waiting = await client.poll({ domain: "lark", deviceCode: begin.deviceCode });

    expect(capturedOptions).toMatchObject({
      domain: "accounts.larksuite.com",
      larkDomain: "accounts.larksuite.com",
      source: "vcm"
    });
    expect(begin).toEqual({
      domain: "lark",
      deviceCode: expect.stringMatching(/^lark-registration-/),
      qrUrl: "https://open.larksuite.com/page/launcher?user_code=ABCD&from=sdk&tp=sdk&source=node-sdk%2Fvcm",
      userCode: "ABCD",
      intervalSeconds: 5,
      expiresInSeconds: 600
    });
    expect(waiting).toEqual({ status: "wait", message: undefined });

    resolveRegistration({
      client_id: "cli_test",
      client_secret: "secret_test",
      user_info: {
        tenant_brand: "lark",
        open_id: "ou_user"
      }
    });

    const result = await waitForConfirmedResult(() => client.poll({ domain: "lark", deviceCode: begin.deviceCode }));
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

async function waitForConfirmedResult(
  poll: () => Promise<LarkRegistrationPollResult>
): Promise<LarkRegistrationPollResult> {
  for (let index = 0; index < 20; index += 1) {
    const result = await poll();
    if (result.status !== "wait") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for Lark registration result.");
}

function jsonResponse(input: unknown, status = 200): Response {
  return new Response(JSON.stringify(input), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
