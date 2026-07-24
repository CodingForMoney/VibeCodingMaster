import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";
import type { GatewayStatus } from "../../../src/shared/types/gateway.js";
import {
  bindGatewayLarkApp,
  connectAndCreateTask,
  getPreferences,
  setGatewayConnection,
  startRole,
  updateGatewaySettings,
  waitFor
} from "./helpers/e2e-actions.js";
import type { MockClaudePromptContext } from "./helpers/mock-claude-runtime.js";

const cleanups: Array<() => Promise<void>> = [];
const GATEWAY_WAIT_TIMEOUT_MS = 20_000;

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E Gateway with mock channel and mock Claude Code", () => {
  it("receives a gateway message, sends translated input to PM, and retries PM output translation", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-gateway");

    env.mockRuntime.onPrompt("translator", "Translate each <VCM_TEXT>", writeGatewayTranslations, { once: false });
    env.mockRuntime.onPrompt("project-manager", "Please inspect the gateway task.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("PM final reply from gateway E2E.");
      await ctx.stop();
    });

    await startRole(env.app, task.taskSlug, "project-manager");
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    expect(pmSession).toBeDefined();

    const bind = await bindGatewayLarkApp(env.app, {
      appId: "mock-app",
      appSecret: "mock-secret",
      larkDomain: "lark"
    });
    expect(bind.status).toBe("confirmed");

    await setGatewayConnection(env.app, true);
    const status = await updateGatewaySettings(env.app, {
      enabled: true,
      channel: "lark",
      translationEnabled: true
    });
    expect(status.enabled).toBe(true);
    expect(status.running).toBe(true);
    expect(status.pauseAlertSoundEnabled).toBe(false);
    expect((await getPreferences(env.app)).flowPauseAlerts).toBe(false);

    env.mockGateway.enqueueText("请检查 gateway 任务", {
      fromUserId: "mock-user",
      chatId: "mock-chat"
    });

    await waitFor(() => {
      const sent = sentTexts(env);
      expect(sent).toEqual(expect.arrayContaining([
        "已收到，正在翻译..."
      ]));
      expect(sent.some((text) => text.includes("翻译完成，已发送给 PM：") && text.includes("Please inspect the gateway task."))).toBe(true);
    }, GATEWAY_WAIT_TIMEOUT_MS);

    await waitFor(() => {
      expect(env.mockRuntime.getWrites(pmSession!.id).join("\n")).toContain("Please inspect the gateway task.");
    }, GATEWAY_WAIT_TIMEOUT_MS);

    await waitFor(async () => {
      const response = await env.app.inject({ method: "GET", url: "/api/gateway/status" });
      expect(response.statusCode).toBe(200);
      expect(response.json<GatewayStatus>().lastPmInputMessageId).toBeTruthy();
    }, GATEWAY_WAIT_TIMEOUT_MS);

    await waitFor(() => {
      const sent = sentTexts(env);
      expect(sent.some((text) => text.includes("PM final reply 原文：") && text.includes("PM final reply from gateway E2E."))).toBe(true);
      expect(sent.some((text) => text.includes("PM 回复已收到，但翻译失败。"))).toBe(true);
    }, GATEWAY_WAIT_TIMEOUT_MS);

    env.mockGateway.enqueueText("/retry", {
      fromUserId: "mock-user",
      chatId: "mock-chat"
    });

    await waitFor(() => {
      expect(sentTexts(env).some((text) =>
        text.includes("重新翻译成功：") &&
        text.includes("PM final reply translated.")
      )).toBe(true);
    }, GATEWAY_WAIT_TIMEOUT_MS);
  }, 60_000);
});

async function writeGatewayTranslations(ctx: MockClaudePromptContext): Promise<void> {
  await ctx.userPromptSubmit();
  const items = parseConversationBatchPrompt(ctx.prompt);
  for (const item of items) {
    await ctx.writeAbsoluteFile(item.resultPath, translateForGatewayE2e(item.sourceText));
  }
  await ctx.stop();
}

function translateForGatewayE2e(sourceText: string): string {
  if (sourceText.includes("请检查 gateway 任务")) {
    return "Please inspect the gateway task.";
  }
  if (sourceText.includes("PM final reply from gateway E2E.")) {
    return "PM final reply translated.";
  }
  return `Translated: ${sourceText}`;
}

function parseConversationBatchPrompt(prompt: string): Array<{ resultPath: string; sourceText: string }> {
  const items: Array<{ resultPath: string; sourceText: string }> = [];
  const regex = /Result Path \d+:\s*(.+?)\n<VCM_TEXT\d+>\n([\s\S]*?)\n<\/VCM_TEXT\d+>/g;
  for (const match of prompt.matchAll(regex)) {
    const resultPath = match[1]?.trim();
    const sourceText = match[2]?.trim();
    if (resultPath && sourceText) {
      items.push({ resultPath, sourceText });
    }
  }
  if (items.length === 0) {
    throw new Error(`No gateway translation items found in prompt:\n${prompt}`);
  }
  return items;
}

function sentTexts(env: { mockGateway: { sentTexts: readonly { text: string }[] } }): string[] {
  return env.mockGateway.sentTexts.map((item) => item.text);
}
