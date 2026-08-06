import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  pollTranslationFeed,
  startRole,
  updatePreferences,
  waitFor
} from "./helpers/e2e-actions.js";
import type { MockClaudePromptContext } from "./helpers/mock-claude-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E translation feed with mock Claude Code", () => {
  it("translates PM final output without assigning it to another role feed", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-translation");
    await updatePreferences(env.app, {
      translationEnabled: true,
      translationOutputMode: "pm-final-only",
      translationTargetLanguage: "zh-CN"
    });

    env.mockRuntime.onPrompt("translator", "Translate each <VCM_TEXT>", writeConversationTranslations, { once: false });
    env.mockRuntime.onPrompt("project-manager", "Produce PM final text", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("PM final reply for translation.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("architect", "Produce Architect final text", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Architect final reply should not be translated in PM-only mode.");
      await ctx.stop();
    });

    const translator = await env.app.inject({
      method: "POST",
      url: "/api/translation/session/ensure",
      payload: {
        taskSlug: task.taskSlug,
        permissionMode: "bypassPermissions",
        model: "default",
        effort: "medium"
      }
    });
    expect(translator.statusCode).toBe(200);

    await startRole(env.app, task.taskSlug, "project-manager");
    await startRole(env.app, task.taskSlug, "architect");
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    const architectSession = env.mockRuntime.getSessionByRole(task.taskSlug, "architect");
    expect(pmSession).toBeDefined();
    expect(architectSession).toBeDefined();

    env.mockRuntime.write(pmSession!.id, "Produce PM final text");
    env.mockRuntime.write(architectSession!.id, "Produce Architect final text");
    await env.mockRuntime.waitForIdle();

    await waitFor(async () => {
      const feed = await pollTranslationFeed(env.app, task.taskSlug);
      const entries = feed.events
        .filter((event) => event.event.type === "entry")
        .map((event) => ({
          role: event.role,
          entry: event.event.type === "entry" ? event.event.entry : undefined
        }));
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "project-manager",
          entry: expect.objectContaining({
            status: "translated",
            sourceText: "PM final reply for translation.",
            translatedText: "ZH: PM final reply for translation."
          })
        })
      ]));
      expect(entries.some((item) =>
        item.role === "architect" &&
        item.entry?.sourceText === "PM final reply for translation."
      )).toBe(false);
      expect(entries.some((item) =>
        item.role === "architect" &&
        item.entry?.status === "translated"
      )).toBe(false);
    }, 3_000);
  });
});

async function writeConversationTranslations(ctx: MockClaudePromptContext): Promise<void> {
  await ctx.userPromptSubmit();
  const items = parseConversationBatchPrompt(ctx.prompt);
  for (const item of items) {
    await ctx.writeAbsoluteFile(item.resultPath, `ZH: ${item.sourceText}`);
  }
  await ctx.stop();
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
    throw new Error(`No conversation translation items found in prompt:\n${prompt}`);
  }
  return items;
}
