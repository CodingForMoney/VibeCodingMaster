import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TURN_REPLY_CHARS,
  limitTranscriptReply,
  readLatestRoleTurnReply,
  selectLatestTurnReply,
  type TranscriptTextEvent
} from "../../../src/backend/services/claude-transcript-reply.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeTranscript(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-transcript-reply-"));
  dirs.push(dir);
  const path = join(dir, "pm.jsonl");
  await writeFile(path, lines.join("\n"), "utf8");
  return path;
}

function assistantLine(uuid: string, timestamp: string, text: string, stopReason = "end_turn"): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp,
    message: {
      stop_reason: stopReason,
      content: [{ type: "text", text }]
    }
  });
}

function pmSession(transcriptPath?: string): RoleSessionRecord {
  return {
    id: "pm-session",
    claudeSessionId: "claude-pm-session",
    transcriptPath,
    taskSlug: "demo-task",
    role: "project-manager",
    status: "running",
    activityStatus: "idle",
    command: "claude",
    permissionMode: "default",
    cwd: "/repo",
    terminalBackend: "node-pty",
    startedAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:02.000Z",
    lastTurnStartedAt: "2026-06-11T00:00:00.000Z",
    lastTurnEndedAt: "2026-06-11T00:00:02.000Z"
  };
}

describe("readLatestRoleTurnReply", () => {
  it("returns the last end_turn reply within the session's last-turn window", async () => {
    const transcriptPath = await writeTranscript([
      assistantLine("e1", "2026-06-10T23:00:00.000Z", "earlier turn"),
      assistantLine("e2", "2026-06-11T00:00:01.000Z", "Latest decision for you.")
    ]);

    const reply = await readLatestRoleTurnReply(pmSession(transcriptPath));

    expect(reply).toEqual({
      text: "Latest decision for you.",
      truncated: false,
      transcriptEventId: "e2",
      transcriptTimestamp: "2026-06-11T00:00:01.000Z"
    });
  });

  it("truncates an oversized reply and reports messageTruncated", async () => {
    const longText = "x".repeat(MAX_TURN_REPLY_CHARS + 50);
    const transcriptPath = await writeTranscript([
      assistantLine("e1", "2026-06-11T00:00:01.000Z", longText)
    ]);

    const reply = await readLatestRoleTurnReply(pmSession(transcriptPath));

    expect(reply?.truncated).toBe(true);
    expect(reply?.text.length).toBe(MAX_TURN_REPLY_CHARS);
  });

  it("returns undefined when no transcript can be resolved", async () => {
    const reply = await readLatestRoleTurnReply(pmSession(undefined));
    expect(reply).toBeUndefined();
  });

  it("returns undefined when the turn produced no end_turn text", async () => {
    const transcriptPath = await writeTranscript([
      assistantLine("e1", "2026-06-11T00:00:01.000Z", "partial", "tool_use")
    ]);

    const reply = await readLatestRoleTurnReply(pmSession(transcriptPath));

    expect(reply).toBeUndefined();
  });
});

describe("selectLatestTurnReply", () => {
  it("honors a custom maxLength", () => {
    const events: TranscriptTextEvent[] = [
      { id: "e1", timestamp: "2026-06-11T00:00:01.000Z", text: "abcdefgh", stopReason: "end_turn" }
    ];
    const reply = selectLatestTurnReply(events, pmSession("ignored"), 4);
    expect(reply).toEqual({
      text: "abcd",
      truncated: true,
      transcriptEventId: "e1",
      transcriptTimestamp: "2026-06-11T00:00:01.000Z"
    });
  });
});

describe("limitTranscriptReply", () => {
  it("does not truncate text within the limit", () => {
    expect(limitTranscriptReply("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("truncates and trims trailing whitespace beyond the limit", () => {
    expect(limitTranscriptReply("hello world", 6)).toEqual({ text: "hello", truncated: true });
  });
});
