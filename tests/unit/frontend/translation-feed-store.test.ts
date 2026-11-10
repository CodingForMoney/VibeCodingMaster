import { describe, expect, it } from "vitest";
import {
  applyTranslationTaskFeed,
  createTranslationPanelFeedStore
} from "../../../src/frontend/state/translation-feed-store.js";
import type { PollTranslationTaskFeedResult, TranslationEntry } from "../../../src/shared/types/translation.js";

function entry(id: string, translatedText: string): TranslationEntry {
  return {
    id,
    taskSlug: "demo",
    role: "project-manager",
    direction: "cc-output-to-user",
    sourceKind: "prose",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    sourceText: "Source",
    translatedText,
    status: "translated",
    contextUsed: false,
    createdAt: "2026-11-10T00:00:00.000Z",
    provider: "claude-code"
  } as TranslationEntry;
}

function poll(nextCursor: number, events: PollTranslationTaskFeedResult["events"] = [], status: "ready" | "translating" = "ready"): PollTranslationTaskFeedResult {
  return {
    taskSlug: "demo",
    nextCursor,
    sessions: [
      { sessionId: "pm", role: "project-manager", status },
      { sessionId: "coder", role: "coder", status: "ready" }
    ],
    events
  };
}

describe("applyTranslationTaskFeed", () => {
  it("keeps the store when a poll brings nothing new", () => {
    const first = applyTranslationTaskFeed(createTranslationPanelFeedStore("demo"), poll(3, [
      { seq: 1, sessionId: "pm", role: "project-manager", event: { type: "entry", entry: entry("a", "第一条") } },
      { seq: 2, sessionId: "coder", role: "coder", event: { type: "entry", entry: entry("b", "第二条") } }
    ]));

    // Every role's translation panel re-renders from this store each second.
    expect(applyTranslationTaskFeed(first, poll(3))).toBe(first);
  });

  it("replaces only the sessions that changed and keeps unchanged entries", () => {
    const first = applyTranslationTaskFeed(createTranslationPanelFeedStore("demo"), poll(3, [
      { seq: 1, sessionId: "pm", role: "project-manager", event: { type: "entry", entry: entry("a", "第一条") } },
      { seq: 2, sessionId: "coder", role: "coder", event: { type: "entry", entry: entry("b", "第二条") } }
    ]));

    const statusChange = applyTranslationTaskFeed(first, poll(3, [], "translating"));
    expect(statusChange).not.toBe(first);
    expect(statusChange.sessions.pm.status).toBe("translating");
    expect(statusChange.sessions.pm.entries).toBe(first.sessions.pm.entries);
    expect(statusChange.sessions.coder).toBe(first.sessions.coder);

    const newEntry = applyTranslationTaskFeed(statusChange, poll(4, [
      { seq: 3, sessionId: "pm", role: "project-manager", event: { type: "entry", entry: entry("c", "第三条") } }
    ], "translating"));
    expect(newEntry.cursor).toBe(4);
    expect(newEntry.sessions.pm.entries.map((item) => item.id)).toEqual(["a", "c"]);
    expect(newEntry.sessions.pm.entries[0]).toBe(first.sessions.pm.entries[0]);
    expect(newEntry.sessions.coder).toBe(first.sessions.coder);
  });

  it("starts a new store for another task", () => {
    const first = applyTranslationTaskFeed(createTranslationPanelFeedStore("demo"), poll(2, [
      { seq: 1, sessionId: "pm", role: "project-manager", event: { type: "entry", entry: entry("a", "第一条") } }
    ]));

    const other = applyTranslationTaskFeed(first, { ...poll(1), taskSlug: "other" });
    expect(other.taskSlug).toBe("other");
    expect(other.sessions.pm.entries).toEqual([]);
  });
});
