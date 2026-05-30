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
        toolUse: {
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

  it("normalizes AskUserQuestion, TodoWrite, Agent, and tool_result events", () => {
    const assistantEvents = parseAssistantContent(JSON.stringify({
      type: "assistant",
      uuid: "msg-3",
      timestamp: "2026-05-30T00:00:00.000Z",
      message: {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_question",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Should I run the full test suite?",
                header: "Tests",
                multiSelect: false,
                options: [{ label: "Run", description: "Run all tests." }]
              }]
            }
          },
          {
            type: "tool_use",
            id: "toolu_todo",
            name: "TodoWrite",
            input: {
              todos: [{ content: "Fix parser", activeForm: "Fixing parser", status: "in_progress" }]
            }
          },
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Task",
            input: {
              description: "Review changes",
              prompt: "Check the patch carefully.",
              subagent_type: "reviewer"
            }
          }
        ]
      }
    }));
    const resultEvents = parseAssistantContent(JSON.stringify({
      type: "user",
      timestamp: "2026-05-30T00:00:01.000Z",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "PASS", is_error: false }]
      }
    }));

    expect(assistantEvents.map((event) => event.kind)).toEqual(["question", "todo", "agent"]);
    expect(assistantEvents[0]).toMatchObject({
      kind: "question",
      question: { questions: [{ question: "Should I run the full test suite?" }] }
    });
    expect(assistantEvents[1]).toMatchObject({
      kind: "todo",
      todo: { todos: [{ activeForm: "Fixing parser", status: "in_progress" }] }
    });
    expect(assistantEvents[2]).toMatchObject({
      kind: "agent",
      agent: { description: "Review changes", subagent_type: "reviewer" }
    });
    expect(resultEvents).toEqual([{
      kind: "tool_result",
      id: "toolu_1#result",
      timestamp: "2026-05-30T00:00:01.000Z",
      toolResult: {
        tool_use_id: "toolu_1",
        content: "PASS",
        isError: false
      }
    }]);
  });
});
