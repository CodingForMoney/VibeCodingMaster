import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { TranslationProvider } from "../../../src/backend/adapters/translation-provider.js";
import type { TerminalEvent } from "../../../src/shared/types/terminal.js";
import type { TerminalEventListener, TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createAppSettingsService, type AppSettingsFile } from "../../../src/backend/services/app-settings-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import { createTranslationService } from "../../../src/backend/services/translation-service.js";
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
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub("我找到了失败的测试。"),
      runtime,
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
    runtime.emitOutput([
      "\u001b[36m● Bash(npm test)\u001b[0m",
      "  ⎿  PASS tests/unit/example.test.ts",
      "",
      "I found the failing test.",
      ""
    ].join("\n"));

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
});

function createProviderStub(text = "translated"): TranslationProvider {
  return {
    async testConnection(settings) {
      return { ok: true, model: settings.model, elapsedMs: 1 };
    },
    async translate() {
      return { text, elapsedMs: 1 };
    }
  };
}

function createRuntimeStub(): TerminalRuntime & { emitOutput(data: string): void } {
  const listeners = new Set<TerminalEventListener>();
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
    subscribe(_sessionId, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitOutput(data) {
      const event: TerminalEvent = {
        id: "evt-1",
        sessionId: session.id,
        taskSlug: session.taskSlug,
        role: session.role,
        type: "output",
        timestamp: "2026-05-30T00:00:00.000Z",
        data
      };
      for (const listener of listeners) {
        listener(event);
      }
    }
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
