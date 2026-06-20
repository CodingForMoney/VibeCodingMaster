import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { TranslationProvider } from "../../../src/backend/adapters/translation-provider.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createAppSettingsService, type AppSettingsFile } from "../../../src/backend/services/app-settings-service.js";
import type {
  ClaudeTranscriptEvent,
  ClaudeTranscriptService,
  ClaudeTranscriptSubscribeOptions
} from "../../../src/backend/services/claude-transcript-service.js";
import type { CodexTranslationService } from "../../../src/backend/services/codex-translation-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import { formatTerminalPaste, normalizeTerminalSubmitText } from "../../../src/backend/runtime/terminal-submit.js";
import { createTranslationService } from "../../../src/backend/services/translation-service.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TranslationSessionEvent, TranslationWsMessage } from "../../../src/shared/types/translation.js";
import { TRANSLATION_ENTRY_RETENTION_LIMIT } from "../../../src/shared/types/translation.js";

describe("translation-service", () => {
  it("uses fixed defaults for language direction, context, and request timeout", async () => {
    const service = createTranslationService({
      appSettings: createAppSettingsService({
        fs: createMemoryFs(),
        settingsPath: "/settings.json",
      }),
      provider: createProviderStub(),
      runtime: {} as TerminalRuntime,
      sessionRegistry: createRegistryStub(),
      transcripts: createTranscriptStub(),
      sessionService: {} as SessionService
    });

    await expect(service.getSettings()).resolves.toMatchObject({
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      contextEnabled: false,
      requestTimeoutMs: 120000
    });

    await expect(service.updateSettings({
      sourceLanguage: "ja",
      targetLanguage: "fr",
      contextEnabled: true,
      requestTimeoutMs: 3000
    })).resolves.toMatchObject({
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      contextEnabled: false,
      requestTimeoutMs: 120000
    });
  });

  it("formats translated input as bracketed paste before a separate enter", () => {
    expect(normalizeTerminalSubmitText("run tests\n")).toBe("run tests");
    expect(normalizeTerminalSubmitText("run tests\r")).toBe("run tests");
    expect(normalizeTerminalSubmitText("line one\r\nline two\n")).toBe("line one\nline two");
    expect(formatTerminalPaste("run tests")).toBe("\x1b[200~run tests\x1b[201~");
  });

  it("saves API keys locally and returns them to the local settings UI", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub(),
      runtime: {} as TerminalRuntime,
      sessionRegistry: createRegistryStub(),
      transcripts: createTranscriptStub(),
      sessionService: {} as SessionService
    });

    const saved = await service.updateSettings({ enabled: true }, { apiKey: "sk-local-test" });
    const reloaded = await service.getSettings();
    const stored = await fs.readJson<AppSettingsFile>("/settings.json");

    expect(saved.apiKey).toBe("sk-local-test");
    expect(reloaded.apiKey).toBe("sk-local-test");
    expect(stored.translation?.secrets.apiKey).toBe("sk-local-test");
    expect(stored.translation?.settings.apiKey).toBeUndefined();
  });

  it("records conversation boundary entries with per-session turns", async () => {
    const fs = createMemoryFs();
    const roleSession = createRoleSessionRecord();
    const service = createTranslationService({
      appSettings: createAppSettingsService({
        fs,
        settingsPath: "/settings.json",
      }),
      provider: createProviderStub(),
      runtime: createRuntimeStub([roleSession]),
      sessionRegistry: createRegistryStub(roleSession),
      transcripts: createTranscriptStub(),
      sessionService: {} as SessionService,
      fs,
      projectService: createProjectServiceStub(),
      now: createClock([
        "2026-05-30T00:00:01.000Z",
        "2026-05-30T00:00:02.000Z",
        "2026-05-30T00:00:03.000Z",
        "2026-05-30T00:00:04.000Z"
      ])
    });

    await service.recordConversationBoundary({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      role: "coder",
      sessionId: roleSession.id,
      boundaryKind: "start",
      occurredAt: "2026-05-30T00:00:01.000Z"
    });
    await service.recordConversationBoundary({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      role: "coder",
      sessionId: roleSession.id,
      boundaryKind: "start",
      occurredAt: "2026-05-30T00:00:01.000Z"
    });
    await service.recordConversationBoundary({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      role: "coder",
      sessionId: roleSession.id,
      boundaryKind: "end",
      occurredAt: "2026-05-30T00:00:03.000Z"
    });
    await service.recordConversationBoundary({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      role: "coder",
      sessionId: roleSession.id,
      boundaryKind: "end",
      occurredAt: "2026-05-30T00:00:03.000Z"
    });
    await service.recordConversationBoundary({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      role: "coder",
      sessionId: roleSession.id,
      boundaryKind: "start",
      occurredAt: "2026-05-30T00:00:05.000Z"
    });

    const result = await service.pollSessionEvents(roleSession.id, 1);
    const entries = result.events
      .filter((event): event is Extract<TranslationSessionEvent, { type: "entry" }> => event.type === "entry")
      .map((event) => event.entry);

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => ({
      id: entry.id,
      sourceKind: entry.sourceKind,
      boundaryKind: entry.boundaryKind,
      conversationTurn: entry.conversationTurn,
      occurredAt: entry.occurredAt
    }))).toEqual([
      {
        id: `boundary:${roleSession.id}:1:start`,
        sourceKind: "conversation-boundary",
        boundaryKind: "start",
        conversationTurn: 1,
        occurredAt: "2026-05-30T00:00:01.000Z"
      },
      {
        id: `boundary:${roleSession.id}:1:end`,
        sourceKind: "conversation-boundary",
        boundaryKind: "end",
        conversationTurn: 1,
        occurredAt: "2026-05-30T00:00:03.000Z"
      },
      {
        id: `boundary:${roleSession.id}:2:start`,
        sourceKind: "conversation-boundary",
        boundaryKind: "start",
        conversationTurn: 2,
        occurredAt: "2026-05-30T00:00:05.000Z"
      }
    ]);
    expect(entries[0]?.sourceText).toContain("开始---第 1 轮");
    expect(entries[1]?.sourceText).toContain("结束---第 1 轮");
  });

  it("shows cleaned Claude output before replacing it with translated text", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const runtime = createRuntimeStub();
    const transcripts = createTranscriptStub();
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub("我找到了失败的测试。"),
      runtime,
      sessionRegistry: createRegistryStub(),
      transcripts,
      sessionService: {} as SessionService,
      now: createClock([
        "2026-05-30T00:00:00.000Z",
        "2026-05-30T00:00:01.000Z",
        "2026-05-30T00:00:02.000Z"
      ])
    });
    await service.updateSettings({ enabled: true, translateOutput: true }, { apiKey: "sk-local-test" });

    const messages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => messages.push(message));
    transcripts.emit({
      kind: "text",
      id: "assistant-message-1",
      timestamp: "2026-05-30T00:00:00.000Z",
      stopReason: "end_turn",
      text: "I found the failing test."
    });

    await waitFor(() => messages.some((message) =>
      message.type === "translation-entry" && message.entry.status === "translated"
    ));

    const entries = messages.filter((message): message is Extract<TranslationWsMessage, { type: "translation-entry" }> =>
      message.type === "translation-entry"
    );
    expect(entries[0]?.entry).toMatchObject({
      status: "translating",
      sourceText: "I found the failing test.",
      translatedText: "",
      translationStartedAt: "2026-05-30T00:00:01.000Z"
    });
    expect(entries.at(-1)?.entry).toMatchObject({
      status: "translated",
      sourceText: "I found the failing test.",
      translatedText: "我找到了失败的测试。"
    });
    expect(entries.at(-1)?.entry.translationStartedAt).toBe("2026-05-30T00:00:01.000Z");
  });

  it("tracks failed output translations in a retry queue and retries by replacing the original entry", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const runtime = createRuntimeStub();
    const transcripts = createTranscriptStub();
    const service = createTranslationService({
      appSettings,
      provider: createFailOnceProvider("重试成功。"),
      runtime,
      sessionRegistry: createRegistryStub(),
      transcripts,
      sessionService: {} as SessionService
    });
    await service.updateSettings({ enabled: true, translateOutput: true }, { apiKey: "sk-local-test" });

    const messages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => messages.push(message));
    transcripts.emit({
      kind: "text",
      id: "assistant-message-retry",
      timestamp: "2026-05-30T00:00:00.000Z",
      stopReason: "end_turn",
      text: "Retry this failed translation."
    });

    await waitFor(() => messages.some((message) =>
      message.type === "translation-failures" && message.failures.length === 1
    ));

    const failure = messages.find((message): message is Extract<TranslationWsMessage, { type: "translation-failures" }> =>
      message.type === "translation-failures" && message.failures.length === 1
    )?.failures[0];
    expect(failure).toMatchObject({
      translationId: "assistant-message-retry",
      sessionId: "session-1",
      sourceText: "Retry this failed translation.",
      retryCount: 0
    });

    const retryResult = await service.retryFailedTranslations("session-1");
    expect(retryResult.failures).toHaveLength(1);
    expect(retryResult.failures[0]).toMatchObject({
      translationId: "assistant-message-retry",
      retryCount: 1
    });

    await waitFor(() => messages.some((message) =>
      message.type === "translation-entry"
      && message.entry.id === "assistant-message-retry"
      && message.entry.status === "translated"
    ));

    const entryMessages = messages.filter((message): message is Extract<TranslationWsMessage, { type: "translation-entry" }> =>
      message.type === "translation-entry" && message.entry.id === "assistant-message-retry"
    );
    const failedIndex = entryMessages.findIndex((message) => message.entry.status === "failed");
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(entryMessages.slice(failedIndex + 1).some((message) => message.entry.status === "translating")).toBe(true);
    expect(entryMessages.at(-1)?.entry).toMatchObject({
      id: "assistant-message-retry",
      status: "translated",
      sourceText: "Retry this failed translation.",
      translatedText: "重试成功。"
    });
    expect(messages.some((message) =>
      message.type === "translation-failures" && message.failures.length === 0
    )).toBe(true);

    const replayed: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => replayed.push(message));
    const replayedEntries = replayed.filter((message): message is Extract<TranslationWsMessage, { type: "translation-entry" }> =>
      message.type === "translation-entry" && message.entry.id === "assistant-message-retry"
    );
    expect(replayedEntries).toHaveLength(1);
    expect(replayedEntries[0]?.entry.status).toBe("translated");
  });

  it("caps retained translation entries and removes failure queue items for pruned failures", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const runtime = createRuntimeStub();
    const transcripts = createTranscriptStub();
    const service = createTranslationService({
      appSettings,
      provider: createAlwaysFailProvider(),
      runtime,
      sessionRegistry: createRegistryStub(),
      transcripts,
      sessionService: {} as SessionService
    });
    await service.updateSettings({ enabled: true, translateOutput: true }, { apiKey: "sk-local-test" });

    const messages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => messages.push(message));
    transcripts.emit({
      kind: "text",
      id: "old-failed-entry",
      timestamp: "2026-05-30T00:00:00.000Z",
      stopReason: "end_turn",
      text: "This old failure should be pruned."
    });

    await waitFor(() => messages.some((message) =>
      message.type === "translation-failures" && message.failures.length === 1
    ));

    for (let index = 0; index < TRANSLATION_ENTRY_RETENTION_LIMIT; index += 1) {
      transcripts.emit({
        kind: "tool_use",
        id: `tool-${index}`,
        timestamp: "2026-05-30T00:00:01.000Z",
        toolUse: {
          name: "Bash",
          input: { command: `echo ${index}` }
        }
      });
    }

    await waitFor(() => messages.some((message) =>
      message.type === "translation-failures" && message.failures.length === 0
    ));

    const replayed: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => replayed.push(message));
    const replayedEntries = replayed.filter((message): message is Extract<TranslationWsMessage, { type: "translation-entry" }> =>
      message.type === "translation-entry"
    );
    const replayedFailures = replayed.filter((message): message is Extract<TranslationWsMessage, { type: "translation-failures" }> =>
      message.type === "translation-failures"
    );
    expect(replayedEntries).toHaveLength(TRANSLATION_ENTRY_RETENTION_LIMIT);
    expect(replayedEntries.some((message) => message.entry.id === "old-failed-entry")).toBe(false);
    expect(replayedFailures.at(-1)?.failures).toEqual([]);
  });

  it("shows user input before replacing it with translated text", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const roleSession = createRoleSessionRecord();
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub("Please inspect the failing test."),
      runtime: createRuntimeStub(),
      sessionRegistry: createRegistryStub(roleSession),
      transcripts: createTranscriptStub(),
      sessionService: {
        async getRoleSession() {
          return roleSession;
        }
      } as SessionService,
      now: createClock([
        "2026-05-30T00:00:00.000Z",
        "2026-05-30T00:00:01.000Z",
        "2026-05-30T00:00:02.000Z"
      ])
    });
    await service.updateSettings({ enabled: true, translateUserInput: true }, { apiKey: "sk-local-test" });

    const messages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => messages.push(message));
    await service.translateUserInput({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      role: "coder",
      text: "请检查失败的测试。",
      send: false
    });

    const entries = messages.filter((message): message is Extract<TranslationWsMessage, { type: "translation-entry" }> =>
      message.type === "translation-entry"
    );
    expect(entries[0]?.entry).toMatchObject({
      status: "translating",
      sourceText: "请检查失败的测试。",
      translatedText: "",
      translationStartedAt: "2026-05-30T00:00:01.000Z"
    });
    expect(entries.at(-1)?.entry).toMatchObject({
      status: "translated",
      sourceText: "请检查失败的测试。",
      translatedText: "Please inspect the failing test."
    });
  });

  it("uses Codex conversation jobs for user input translation when available", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const roleSession = createRoleSessionRecord();
    const codexCalls: unknown[] = [];
    const service = createTranslationService({
      appSettings,
      provider: createAlwaysFailProvider(),
      codexTranslationService: createCodexTranslationServiceStub(codexCalls, "Please inspect the failing test."),
      runtime: createRuntimeStub(),
      sessionRegistry: createRegistryStub(roleSession),
      transcripts: createTranscriptStub(),
      sessionService: {
        async getRoleSession() {
          return roleSession;
        }
      } as SessionService
    });
    await service.updateSettings({ enabled: true, translateUserInput: true }, { apiKey: "sk-local-test" });

    const result = await service.translateUserInput({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      role: "coder",
      text: "请检查失败的测试。",
      send: false
    });

    expect(result.englishPreview).toBe("Please inspect the failing test.");
    expect(codexCalls).toEqual([
      expect.objectContaining({
        repoRoot: "/repo",
        taskSlug: "demo-task",
        role: "coder",
        direction: "user-input-to-english",
        sourceText: "请检查失败的测试。",
        targetLanguage: "en"
      })
    ]);
  });

  it("sends translated input by pasting first and pressing enter separately", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const roleSession = createRoleSessionRecord();
    const writes: string[] = [];
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub("Please inspect the failing test."),
      runtime: createRuntimeStub([roleSession], writes),
      sessionRegistry: createRegistryStub(roleSession),
      transcripts: createTranscriptStub(),
      sessionService: {
        async getRoleSession() {
          return roleSession;
        }
      } as SessionService
    });

    await service.sendTranslatedInput({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      role: "coder",
      englishText: "Run tests.\n"
    });

    expect(writes).toEqual([
      "\x1b[200~Run tests.\x1b[201~",
      "\r"
    ]);
  });

  it("translates assistant text even when the transcript stop reason is tool_use", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const runtime = createRuntimeStub();
    const transcripts = createTranscriptStub();
    const translateCalls: unknown[] = [];
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub("最终译文。", translateCalls),
      runtime,
      sessionRegistry: createRegistryStub(),
      transcripts,
      sessionService: {} as SessionService
    });
    await service.updateSettings({ enabled: true, translateOutput: true }, { apiKey: "sk-local-test" });

    const messages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => messages.push(message));
    transcripts.emit({
      kind: "text",
      id: "assistant-message-tool-use",
      timestamp: "2026-05-30T00:00:00.000Z",
      stopReason: "tool_use",
      text: "I will inspect the test logs first."
    });

    await waitFor(() => messages.some((message) =>
      message.type === "translation-entry" && message.entry.status === "translated"
    ));

    expect(translateCalls).toHaveLength(1);
    expect(messages.some((message) =>
      message.type === "translation-entry" && message.entry.sourceText === "I will inspect the test logs first."
    )).toBe(true);
  });

  it("translates long assistant prose even when it mentions permissions or code-like terms", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const runtime = createRuntimeStub();
    const transcripts = createTranscriptStub();
    const translateCalls: Array<{ userPrompt: string }> = [];
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub("项目理解已翻译。", translateCalls),
      runtime,
      sessionRegistry: createRegistryStub(),
      transcripts,
      sessionService: {} as SessionService
    });
    await service.updateSettings({ enabled: true, translateOutput: true }, { apiKey: "sk-local-test" });

    const text = [
      "I've now read the documentation and explored the codebase.",
      "",
      "## VibeCodingMaster Project Understanding",
      "",
      "- The translation pane shows classified translations.",
      "- The text mentions code, diff, log, tool-output, and permission without being filtered.",
      "- Backend services include `translation-service`, `claude-transcript-service`, and `session-registry`.",
      "",
      "What would you like to work on next?"
    ].join("\n");

    const messages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => messages.push(message));
    transcripts.emit({
      kind: "text",
      id: "assistant-final-message",
      timestamp: "2026-05-30T00:00:00.000Z",
      stopReason: "end_turn",
      text
    });

    await waitFor(() => messages.some((message) =>
      message.type === "translation-entry" && message.entry.status === "translated"
    ));

    expect(translateCalls).toHaveLength(1);
    expect(translateCalls[0]?.userPrompt).toBe(text);
    expect(messages.some((message) =>
      message.type === "translation-entry"
      && message.entry.id === "assistant-final-message"
      && message.entry.sourceKind === "prose"
      && message.entry.translatedText === "项目理解已翻译。"
    )).toBe(true);
  });

  it("preserves raw tool_use and tool_result events in the translation panel", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const runtime = createRuntimeStub();
    const transcripts = createTranscriptStub();
    const translateCalls: unknown[] = [];
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub("不会被调用。", translateCalls),
      runtime,
      sessionRegistry: createRegistryStub(),
      transcripts,
      sessionService: {} as SessionService
    });
    await service.updateSettings({ enabled: true, translateOutput: true }, { apiKey: "sk-local-test" });

    const messages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => messages.push(message));
    transcripts.emit({
      kind: "tool_use",
      id: "toolu_bash",
      timestamp: "2026-05-30T00:00:01.000Z",
      toolUse: {
        name: "Bash",
        input: { command: "npm test" }
      }
    });
    transcripts.emit({
      kind: "tool_result",
      id: "toolu_bash#result",
      timestamp: "2026-05-30T00:00:02.000Z",
      toolResult: {
        tool_use_id: "toolu_bash",
        content: "PASS tests/unit/example.test.ts",
        isError: false
      }
    });

    await waitFor(() => messages.filter((message) => message.type === "translation-entry").length >= 2);

    const entries = messages.filter((message): message is Extract<TranslationWsMessage, { type: "translation-entry" }> =>
      message.type === "translation-entry"
    );
    expect(translateCalls).toHaveLength(0);
    expect(entries[0]?.entry).toMatchObject({
      id: "toolu_bash",
      status: "preserved",
      sourceKind: "tool-output",
      sourceText: "● Bash({\"command\":\"npm test\"})"
    });
    expect(entries[1]?.entry).toMatchObject({
      id: "toolu_bash#result",
      status: "preserved",
      sourceKind: "tool-output",
      sourceText: expect.stringContaining("PASS tests/unit/example.test.ts")
    });
  });

  it("polls cached translation events and treats after as the next expected seq", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const roleSession = createRoleSessionRecord();
    const transcripts = createTranscriptStub();
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub("不会被调用。"),
      runtime: createRuntimeStub([roleSession]),
      sessionRegistry: createRegistryStub(roleSession),
      transcripts,
      sessionService: {
        async getRoleSession() {
          return roleSession;
        }
      } as SessionService,
      fs,
      projectService: createProjectServiceStub()
    });
    await service.updateSettings({ enabled: true, translateOutput: true }, { apiKey: "sk-local-test" });

    await service.startSession({
      repoRoot: "/repo",
      taskRepoRoot: "/repo/.claude/worktrees/demo-task",
      taskSlug: "demo-task",
      role: "coder"
    });
    transcripts.emit({
      kind: "tool_use",
      id: "toolu_poll",
      timestamp: "2026-05-30T00:00:01.000Z",
      toolUse: {
        name: "Bash",
        input: { command: "npm test" }
      }
    });

    const firstPoll = await waitForPoll(service, "session-1", 1, (result) => result.events.length === 1);
    expect(firstPoll.events[0]).toMatchObject({
      seq: 1,
      type: "entry",
      entry: {
        id: "toolu_poll",
        sourceText: "● Bash({\"command\":\"npm test\"})"
      }
    });
    expect(firstPoll.nextCursor).toBe(2);

    const secondPoll = await service.pollSessionEvents("session-1", firstPoll.nextCursor);
    expect(secondPoll.events).toEqual([]);
    expect(await fs.readText("/repo/.claude/worktrees/demo-task/.ai/vcm/translation/demo-task/coder/session-1.jsonl")).toBe("");
    await expect(fs.pathExists("/repo/.ai/vcm/translation/demo-task/coder/session-1.jsonl")).resolves.toBe(false);
  });

  it("shows tool events immediately while a prose translation is still running", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const runtime = createRuntimeStub();
    const transcripts = createTranscriptStub();
    const provider = createDeferredProvider("慢速译文。");
    const service = createTranslationService({
      appSettings,
      provider,
      runtime,
      sessionRegistry: createRegistryStub(),
      transcripts,
      sessionService: {} as SessionService
    });
    await service.updateSettings({ enabled: true, translateOutput: true }, { apiKey: "sk-local-test" });

    const messages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => messages.push(message));
    transcripts.emit({
      kind: "text",
      id: "slow-prose",
      timestamp: "2026-05-30T00:00:00.000Z",
      stopReason: "end_turn",
      text: "This translation is slow."
    });
    await waitFor(() => messages.some((message) =>
      message.type === "translation-entry"
      && message.entry.id === "slow-prose"
      && message.entry.status === "translating"
    ));

    transcripts.emit({
      kind: "tool_use",
      id: "toolu_fast",
      timestamp: "2026-05-30T00:00:01.000Z",
      toolUse: {
        name: "Bash",
        input: { command: "npm test" }
      }
    });

    await waitFor(() => messages.some((message) =>
      message.type === "translation-entry"
      && message.entry.id === "toolu_fast"
      && message.entry.status === "preserved"
    ));
    expect(messages.some((message) =>
      message.type === "translation-entry"
      && message.entry.id === "slow-prose"
      && message.entry.status === "translated"
    )).toBe(false);

    provider.resolve();
    await waitFor(() => messages.some((message) =>
      message.type === "translation-entry"
      && message.entry.id === "slow-prose"
      && message.entry.status === "translated"
    ));
  });

  it("keeps translation queues isolated for multiple role sessions", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const coderSession = createRoleSessionRecord({
      id: "session-coder",
      role: "coder",
      claudeSessionId: "claude-coder"
    });
    const reviewerSession = createRoleSessionRecord({
      id: "session-reviewer",
      role: "reviewer",
      claudeSessionId: "claude-reviewer"
    });
    const transcripts = createSessionTranscriptStub();
    const provider = createSelectiveDeferredProvider("Coder output is slow.");
    const service = createTranslationService({
      appSettings,
      provider,
      runtime: createRuntimeStub([coderSession, reviewerSession]),
      sessionRegistry: createRegistryStub([coderSession, reviewerSession]),
      transcripts,
      sessionService: {} as SessionService
    });
    await service.updateSettings({ enabled: true, translateOutput: true }, { apiKey: "sk-local-test" });

    const coderMessages: TranslationWsMessage[] = [];
    const reviewerMessages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-coder", (message) => coderMessages.push(message));
    service.subscribeToSession("session-reviewer", (message) => reviewerMessages.push(message));

    transcripts.emit("session-coder", {
      kind: "text",
      id: "coder-slow",
      timestamp: "2026-05-30T00:00:00.000Z",
      stopReason: "end_turn",
      text: "Coder output is slow."
    });
    await waitFor(() => coderMessages.some((message) =>
      message.type === "translation-entry"
      && message.entry.id === "coder-slow"
      && message.entry.status === "translating"
    ));

    transcripts.emit("session-reviewer", {
      kind: "text",
      id: "reviewer-fast",
      timestamp: "2026-05-30T00:00:01.000Z",
      stopReason: "end_turn",
      text: "Reviewer output should not wait."
    });

    await waitFor(() => reviewerMessages.some((message) =>
      message.type === "translation-entry"
      && message.entry.id === "reviewer-fast"
      && message.entry.status === "translated"
    ));
    expect(coderMessages.some((message) =>
      message.type === "translation-entry"
      && message.entry.id === "coder-slow"
      && message.entry.status === "translated"
    )).toBe(false);

    provider.resolve();
    await waitFor(() => coderMessages.some((message) =>
      message.type === "translation-entry"
      && message.entry.id === "coder-slow"
      && message.entry.status === "translated"
    ));
  });

  it("translates structured question, todo, and agent transcript events", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const runtime = createRuntimeStub();
    const transcripts = createTranscriptStub();
    const translateCalls: Array<{ userPrompt: string }> = [];
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub("结构化译文。", translateCalls),
      runtime,
      sessionRegistry: createRegistryStub(),
      transcripts,
      sessionService: {} as SessionService
    });
    await service.updateSettings({ enabled: true, translateOutput: true }, { apiKey: "sk-local-test" });

    const messages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => messages.push(message));
    transcripts.emit({
      kind: "question",
      id: "toolu_question",
      timestamp: "2026-05-30T00:00:01.000Z",
      question: {
        questions: [{
          question: "Should I run all tests?",
          header: "Tests",
          multiSelect: false,
          options: [{ label: "Run", description: "Run all tests." }]
        }]
      }
    });
    transcripts.emit({
      kind: "todo",
      id: "toolu_todo",
      timestamp: "2026-05-30T00:00:02.000Z",
      todo: {
        todos: [{ content: "Fix parser", activeForm: "Fixing parser", status: "in_progress" }]
      }
    });
    transcripts.emit({
      kind: "agent",
      id: "toolu_agent",
      timestamp: "2026-05-30T00:00:03.000Z",
      agent: {
        description: "Review changes",
        prompt: "Check the patch carefully.",
        subagent_type: "reviewer"
      }
    });

    await waitFor(() => messages.filter((message) =>
      message.type === "translation-entry" && message.entry.status === "translated"
    ).length >= 3);

    expect(translateCalls.map((call) => call.userPrompt)).toEqual([
      expect.stringContaining("AskUserQuestion"),
      expect.stringContaining("TodoWrite plan"),
      expect.stringContaining("Agent dispatch")
    ]);
  });

  it("subscribes to transcript output from the current embedded terminal run", () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const subscribeCalls: Array<{
      session: RoleSessionRecord;
      options?: ClaudeTranscriptSubscribeOptions;
    }> = [];
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub(),
      runtime: createRuntimeStub(),
      sessionRegistry: createRegistryStub(createRoleSessionRecord({
        startedAt: "2026-05-30T00:00:00.000Z"
      })),
      transcripts: createTranscriptStub(subscribeCalls),
      sessionService: {} as SessionService
    });

    const messages: TranslationWsMessage[] = [];
    const unsubscribe = service.subscribeToSession("session-1", (message) => messages.push(message));
    unsubscribe();

    expect(subscribeCalls[0]?.session.claudeSessionId).toBe("claude-session-1");
    expect(subscribeCalls[0]?.options?.replaySince).toBe("2026-05-29T23:59:55.000Z");
  });

  it("does not mark transcript ids as seen when no entry is displayed", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
    });
    const runtime = createRuntimeStub();
    const transcripts = createTranscriptStub();
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub("已翻译。"),
      runtime,
      sessionRegistry: createRegistryStub(),
      transcripts,
      sessionService: {} as SessionService
    });

    const blankEvent: ClaudeTranscriptEvent = {
      kind: "text",
      id: "replayed-message",
      timestamp: "2026-05-30T00:00:01.000Z",
      stopReason: "end_turn",
      text: "   "
    };
    const messages: TranslationWsMessage[] = [];
    service.subscribeToSession("session-1", (message) => messages.push(message));
    transcripts.emit(blankEvent);
    await delay(20);
    transcripts.emit({
      ...blankEvent,
      text: "This event should still be translated."
    });
    await waitFor(() => messages.some((message) =>
      message.type === "translation-entry" && message.entry.status === "translated"
    ));

    expect(messages.some((message) =>
      message.type === "translation-entry" && message.entry.id === "replayed-message"
    )).toBe(true);
  });
});

function createProviderStub(text = "translated", calls: unknown[] = []): TranslationProvider {
  return {
    async testConnection(settings) {
      return { ok: true, model: settings.model, elapsedMs: 1 };
    },
    async translate(input) {
      calls.push(input);
      return { text, elapsedMs: 1 };
    }
  };
}

function createFailOnceProvider(text = "translated"): TranslationProvider {
  let calls = 0;
  return {
    async testConnection(settings) {
      return { ok: true, model: settings.model, elapsedMs: 1 };
    },
    async translate() {
      calls += 1;
      if (calls === 1) {
        throw new Error("Provider temporarily failed.");
      }
      return { text, elapsedMs: 1 };
    }
  };
}

function createAlwaysFailProvider(): TranslationProvider {
  return {
    async testConnection(settings) {
      return { ok: true, model: settings.model, elapsedMs: 1 };
    },
    async translate() {
      throw new Error("Provider failed.");
    }
  };
}

function createCodexTranslationServiceStub(calls: unknown[], translatedText: string): Pick<CodexTranslationService, "createConversationJob" | "validateConversationResult" | "getState"> {
  const timestamp = "2026-05-30T00:00:00.000Z";
  return {
    async createConversationJob(repoRoot, input) {
      calls.push({ repoRoot, ...input });
      return {
        id: "conversation-1",
        taskSlug: input.taskSlug,
        role: input.role,
        direction: input.direction,
        sourceHash: "sha256:conversation-source",
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        requestPath: ".ai/vcm/translations/runtime/conversations/demo-task/coder/jobs/conversation-1/request.json",
        resultPath: ".ai/vcm/translations/runtime/conversations/demo-task/coder/jobs/conversation-1/result.json",
        reportPath: ".ai/vcm/translations/runtime/conversations/demo-task/coder/jobs/conversation-1/report.md",
        queueItemId: "queue-conversation-1",
        createdAt: timestamp,
        updatedAt: timestamp
      };
    },
    async validateConversationResult(_repoRoot, input) {
      return {
        version: 1,
        id: "conversation-1",
        status: "completed",
        sourceHash: input.sourceHash,
        sourceLanguage: "auto",
        targetLanguage: input.targetLanguage,
        translatedText,
        notes: []
      };
    },
    async getState() {
      return {
        queue: {
          version: 1,
          activeItemId: undefined,
          updatedAt: timestamp,
          items: [{
            id: "queue-conversation-1",
            type: "conversation",
            status: "completed",
            targetLanguage: "en",
            requestPath: ".ai/vcm/translations/runtime/conversations/demo-task/coder/jobs/conversation-1/request.json",
            expectedResultPath: ".ai/vcm/translations/runtime/conversations/demo-task/coder/jobs/conversation-1/result.json",
            reportPath: ".ai/vcm/translations/runtime/conversations/demo-task/coder/jobs/conversation-1/report.md",
            createdAt: timestamp,
            updatedAt: timestamp
          }]
        },
        fileIndex: {
          version: 1,
          updatedAt: timestamp,
          jobs: []
        },
        bootstrapIndex: {
          version: 1,
          updatedAt: timestamp,
          runs: []
        },
        memoryInitialized: true
      };
    }
  };
}

function createDeferredProvider(text = "translated"): TranslationProvider & { resolve(): void } {
  let resolveTranslation: (() => void) | undefined;
  let resolved = false;
  return {
    async testConnection(settings) {
      return { ok: true, model: settings.model, elapsedMs: 1 };
    },
    async translate() {
      if (!resolved) {
        await new Promise<void>((resolve) => {
          resolveTranslation = resolve;
        });
      }
      return { text, elapsedMs: 1 };
    },
    resolve() {
      resolved = true;
      resolveTranslation?.();
    }
  };
}

function createSelectiveDeferredProvider(blockedText: string): TranslationProvider & { resolve(): void } {
  let resolveTranslation: (() => void) | undefined;
  let resolved = false;
  return {
    async testConnection(settings) {
      return { ok: true, model: settings.model, elapsedMs: 1 };
    },
    async translate(input) {
      if (input.userPrompt === blockedText && !resolved) {
        await new Promise<void>((resolve) => {
          resolveTranslation = resolve;
        });
      }
      return { text: `translated: ${input.userPrompt}`, elapsedMs: 1 };
    },
    resolve() {
      resolved = true;
      resolveTranslation?.();
    }
  };
}

function createRuntimeSessionStub(record = createRoleSessionRecord()): {
  id: string;
  taskSlug: string;
  role: RoleSessionRecord["role"];
  status: "running";
  startedAt: string;
  exitCode: null;
} {
  return {
    id: record.id,
    taskSlug: record.taskSlug,
    role: record.role,
    status: "running" as const,
    startedAt: record.startedAt ?? "2026-05-30T00:00:00.000Z",
    exitCode: null
  };
}

function createRuntimeStub(records: RoleSessionRecord[] = [createRoleSessionRecord()], writes: string[] = []): TerminalRuntime {
  const sessions = records.map(createRuntimeSessionStub);
  return {
    async createSession() {
      return sessions[0]!;
    },
    getSession(sessionId) {
      return sessions.find((session) => session.id === sessionId);
    },
    getSessionByRole() {
      return sessions[0];
    },
    listSessions() {
      return sessions;
    },
    write(_sessionId, data) {
      writes.push(data);
    },
    resize() {},
    async stop() {},
    async restart() {
      return session;
    },
    subscribe() {
      return () => {};
    }
  };
}

function createRegistryStub(
  records: RoleSessionRecord | RoleSessionRecord[] = createRoleSessionRecord()
): { get(sessionId: string): RoleSessionRecord | undefined } {
  const sessions = Array.isArray(records) ? records : [records];
  return {
    get(sessionId) {
      return sessions.find((session) => session.id === sessionId);
    }
  };
}

function createTranscriptStub(subscribeCalls: Array<{
  session: RoleSessionRecord;
  options?: ClaudeTranscriptSubscribeOptions;
}> = []): ClaudeTranscriptService & { emit(event: ClaudeTranscriptEvent): void } {
  const listeners = new Set<(event: ClaudeTranscriptEvent) => void>();
  return {
    subscribeToRoleSession(session, listener, options) {
      subscribeCalls.push({ session, options });
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  };
}

function createSessionTranscriptStub(): ClaudeTranscriptService & {
  emit(sessionId: string, event: ClaudeTranscriptEvent): void;
} {
  const listeners = new Map<string, Set<(event: ClaudeTranscriptEvent) => void>>();
  return {
    subscribeToRoleSession(session, listener) {
      const current = listeners.get(session.id) ?? new Set();
      current.add(listener);
      listeners.set(session.id, current);
      return () => current.delete(listener);
    },
    emit(sessionId, event) {
      for (const listener of listeners.get(sessionId) ?? []) {
        listener(event);
      }
    }
  };
}

function createRoleSessionRecord(overrides: Partial<RoleSessionRecord> = {}): RoleSessionRecord {
  return {
    id: "session-1",
    claudeSessionId: "claude-session-1",
    taskSlug: "demo-task",
    role: "coder",
    status: "running",
    command: "claude --agent coder",
    permissionMode: "default",
    cwd: "/repo",
    terminalBackend: "node-pty",
    logPath: ".ai/vcm/handoffs/logs/coder.log",
    startedAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    exitCode: null,
    ...overrides
  };
}

function createClock(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? values[values.length - 1] ?? "2026-05-30T00:00:00.000Z";
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for translation event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPoll(
  service: { pollSessionEvents(sessionId: string, after: number): Promise<{ events: unknown[]; nextCursor: number }> },
  sessionId: string,
  after: number,
  assertion: (result: { events: unknown[]; nextCursor: number }) => boolean
): Promise<{ events: unknown[]; nextCursor: number }> {
  const startedAt = Date.now();
  while (true) {
    const result = await service.pollSessionEvents(sessionId, after);
    if (assertion(result)) {
      return result;
    }
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for translation poll event.");
    }
    await delay(10);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createProjectServiceStub() {
  return {
    async loadConfig(repoRoot: string) {
      return {
        version: 1,
        repoRoot,
        defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
        handoffRoot: ".ai/vcm/handoffs",
        stateRoot: ".ai/vcm",
        terminalBackend: "node-pty",
        claudeCommand: "claude"
      } as const;
    }
  };
}

function createMemoryFs(): FileSystemAdapter {
  const files = new Map<string, string>();
  return {
    async pathExists(targetPath) {
      return files.has(targetPath);
    },
    async ensureDir() {},
    async readDir() {
      return [];
    },
    async readText(targetPath) {
      const value = files.get(targetPath);
      if (value === undefined) {
        throw new Error(`missing ${targetPath}`);
      }
      return value;
    },
    async writeText(targetPath, content) {
      files.set(targetPath, content);
    },
    async appendText(targetPath, content) {
      files.set(targetPath, `${files.get(targetPath) ?? ""}${content}`);
    },
    async readJson(targetPath) {
      return JSON.parse(await this.readText(targetPath));
    },
    async writeJson(targetPath, value) {
      await this.writeText(targetPath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeJsonAtomic(targetPath, value) {
      await this.writeJson(targetPath, value);
    },
    async ensureFile(targetPath, content) {
      if (files.has(targetPath)) {
        return false;
      }
      files.set(targetPath, content);
      return true;
    },
    async removePath(targetPath) {
      files.delete(targetPath);
    }
  };
}
