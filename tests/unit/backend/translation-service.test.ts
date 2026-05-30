import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { TranslationProvider } from "../../../src/backend/adapters/translation-provider.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createAppSettingsService, type AppSettingsFile } from "../../../src/backend/services/app-settings-service.js";
import type { ClaudeTranscriptEvent, ClaudeTranscriptService } from "../../../src/backend/services/claude-transcript-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import { createTranslationService } from "../../../src/backend/services/translation-service.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TranslationWsMessage } from "../../../src/shared/types/translation.js";

describe("translation-service", () => {
  it("saves API keys locally and returns them to the local settings UI", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
      legacySettingsPath: "/old-settings.json",
      legacyTranslationPath: "/translation.json"
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

  it("migrates API keys from the legacy translation config file", async () => {
    const fs = createMemoryFs();
    await fs.writeJsonAtomic("/translation.json", {
      settings: {
        apiKey: "sk-old-local-test"
      },
      secrets: {}
    });
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
      legacySettingsPath: "/old-settings.json",
      legacyTranslationPath: "/translation.json"
    });
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub(),
      runtime: {} as TerminalRuntime,
      sessionRegistry: createRegistryStub(),
      transcripts: createTranscriptStub(),
      sessionService: {} as SessionService
    });

    const settings = await service.getSettings();
    const stored = await fs.readJson<AppSettingsFile>("/settings.json");

    expect(settings.apiKey).toBe("sk-old-local-test");
    expect(stored.translation?.settings.apiKey).toBeUndefined();
    expect(stored.translation?.secrets.apiKey).toBe("sk-old-local-test");
  });

  it("shows cleaned Claude output before replacing it with translated text", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
      legacySettingsPath: "/old-settings.json",
      legacyTranslationPath: "/translation.json"
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
      status: "queued",
      sourceText: "I found the failing test.",
      translatedText: ""
    });
    expect(entries.at(-1)?.entry).toMatchObject({
      status: "translated",
      sourceText: "I found the failing test.",
      translatedText: "我找到了失败的测试。"
    });
    expect(entries.at(-1)?.entry.translationStartedAt).toBe("2026-05-30T00:00:01.000Z");
  });

  it("translates assistant text even when the transcript stop reason is tool_use", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
      legacySettingsPath: "/old-settings.json",
      legacyTranslationPath: "/translation.json"
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

  it("preserves raw tool_use and tool_result events in the translation panel", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
      legacySettingsPath: "/old-settings.json",
      legacyTranslationPath: "/translation.json"
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
      sourceText: expect.stringContaining("● Bash")
    });
    expect(entries[1]?.entry).toMatchObject({
      id: "toolu_bash#result",
      status: "preserved",
      sourceKind: "tool-output",
      sourceText: expect.stringContaining("PASS tests/unit/example.test.ts")
    });
  });

  it("translates structured question, todo, and agent transcript events", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
      legacySettingsPath: "/old-settings.json",
      legacyTranslationPath: "/translation.json"
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

function createRuntimeStub(): TerminalRuntime {
  const session = {
    id: "session-1",
    taskSlug: "demo-task",
    role: "coder" as const,
    status: "running" as const,
    startedAt: "2026-05-30T00:00:00.000Z",
    exitCode: null
  };
  return {
    async createSession() {
      return session;
    },
    getSession(sessionId) {
      return sessionId === session.id ? session : undefined;
    },
    getSessionByRole() {
      return session;
    },
    listSessions() {
      return [session];
    },
    write() {},
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

function createRegistryStub(record = createRoleSessionRecord()): { get(sessionId: string): RoleSessionRecord | undefined } {
  return {
    get(sessionId) {
      return sessionId === record.id ? record : undefined;
    }
  };
}

function createTranscriptStub(): ClaudeTranscriptService & { emit(event: ClaudeTranscriptEvent): void } {
  const listeners = new Set<(event: ClaudeTranscriptEvent) => void>();
  return {
    subscribeToRoleSession(_session, listener) {
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

function createRoleSessionRecord(): RoleSessionRecord {
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
    logPath: ".ai/handoffs/demo-task/logs/coder.log",
    startedAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    exitCode: null
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
    }
  };
}
