import { describe, expect, it } from "vitest";
import {
  claudeTranscriptPath,
  parseAssistantContent,
  projectHash
} from "../../../src/backend/services/claude-transcript-service.js";

describe("claude-transcript-service", () => {
  it("parses assistant text from Claude Code JSONL without losing spaces", () => {
    const events = parseAssistantContent(JSON.stringify({
      type: "assistant",
      uuid: "msg-1",
      timestamp: "2026-05-30T00:00:00.000Z",
      message: {
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "I found the failing test and fixed the spacing bug." }
        ]
      }
    }));

    expect(events).toEqual([
      {
        kind: "text",
        id: "msg-1",
        timestamp: "2026-05-30T00:00:00.000Z",
        stopReason: "end_turn",
        text: "I found the failing test and fixed the spacing bug."
      }
    ]);
  });

  it("keeps Bash tool calls as structural events instead of assistant text", () => {
    const events = parseAssistantContent(JSON.stringify({
      type: "assistant",
      uuid: "msg-2",
      timestamp: "2026-05-30T00:00:00.000Z",
      message: {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "npm test" }
          }
        ]
      }
    }));

    expect(events).toEqual([
      {
        kind: "tool_use",
        id: "toolu_1",
        timestamp: "2026-05-30T00:00:00.000Z",
        payload: {
          name: "Bash",
          input: { command: "npm test" }
        }
      }
    ]);
  });

  it("resolves Claude Code transcript paths from the project cwd and session id", () => {
    expect(projectHash("/workspace")).toBe("-workspace");
    expect(claudeTranscriptPath("/workspace", "session-1")).toMatch(/\.claude\/projects\/-workspace\/session-1\.jsonl$/);
  });
});
