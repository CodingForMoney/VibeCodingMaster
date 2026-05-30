import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeTranscriptPath,
  createClaudeTranscriptService,
  parseAssistantContent,
  projectHash,
  TranscriptTail
} from "../../../src/backend/services/claude-transcript-service.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

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
    expect(projectHash("/Users/sheldon/Documents/New project 3/VibeCodingMaster"))
      .toBe("-Users-sheldon-Documents-New-project-3-VibeCodingMaster");
    expect(claudeTranscriptPath("/workspace", "session-1")).toMatch(/\.claude\/projects\/-workspace\/session-1\.jsonl$/);
    expect(claudeTranscriptPath(
      "/Users/sheldon/Documents/New project 3/VibeCodingMaster",
      "session-1"
    )).toMatch(/\.claude\/projects\/-Users-sheldon-Documents-New-project-3-VibeCodingMaster\/session-1\.jsonl$/);
  });

  it("replays current-run transcript events by timestamp before tailing new output", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcm-transcript-"));
    const path = join(dir, "session.jsonl");
    try {
      writeFileSync(path, [
        JSON.stringify({
          type: "assistant",
          uuid: "old-message",
          timestamp: "2026-05-29T23:59:00.000Z",
          message: { content: [{ type: "text", text: "Old output." }] }
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "current-message",
          timestamp: "2026-05-30T00:00:01.000Z",
          message: { content: [{ type: "text", text: "Current output." }] }
        }),
        ""
      ].join("\n"));

      const events: ReturnType<typeof parseAssistantContent> = [];
      const tail = new TranscriptTail(path, {
        onContent(event) {
          events.push(event);
        }
      });
      tail.start({ replaySince: "2026-05-30T00:00:00.000Z" });
      tail.stop();

      expect(events).toEqual([
        {
          kind: "text",
          id: "current-message",
          timestamp: "2026-05-30T00:00:01.000Z",
          text: "Current output."
        }
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("polls for appends that happen before fs.watch delivers an event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vcm-transcript-"));
    const path = join(dir, "session.jsonl");
    try {
      writeFileSync(path, "");
      const events: ReturnType<typeof parseAssistantContent> = [];
      const tail = new TranscriptTail(path, {
        onContent(event) {
          events.push(event);
        }
      });

      tail.start({ pollIntervalMs: 20 });
      appendFileSync(path, `${JSON.stringify({
        type: "assistant",
        uuid: "immediate-message",
        timestamp: "2026-05-30T00:00:02.000Z",
        message: { content: [{ type: "text", text: "Immediate output." }] }
      })}\n`);

      await waitFor(() => events.length === 1);
      tail.stop();

      expect(events).toEqual([
        {
          kind: "text",
          id: "immediate-message",
          timestamp: "2026-05-30T00:00:02.000Z",
          text: "Immediate output."
        }
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("subscribes to the persisted transcript path instead of only deriving from cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vcm-transcript-"));
    const path = join(dir, "explicit-session.jsonl");
    try {
      writeFileSync(path, "");
      const service = createClaudeTranscriptService();
      const events: ReturnType<typeof parseAssistantContent> = [];
      const resolvedPaths: string[] = [];
      const unsubscribe = service.subscribeToRoleSession(createRoleSessionRecord({
        claudeSessionId: "different-session-id",
        transcriptPath: path
      }), (event) => {
        events.push(event);
      }, {
        onTranscriptPathResolved(resolvedPath) {
          resolvedPaths.push(resolvedPath);
        }
      });

      appendFileSync(path, `${JSON.stringify({
        type: "assistant",
        uuid: "persisted-path-message",
        timestamp: "2026-05-30T00:00:03.000Z",
        message: { content: [{ type: "text", text: "Read through explicit transcript path." }] }
      })}\n`);

      await waitFor(() => events.length === 1);
      unsubscribe();

      expect(resolvedPaths).toEqual([path]);
      expect(events).toEqual([
        {
          kind: "text",
          id: "persisted-path-message",
          timestamp: "2026-05-30T00:00:03.000Z",
          text: "Read through explicit transcript path."
        }
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

function createRoleSessionRecord(overrides: Partial<RoleSessionRecord> = {}): RoleSessionRecord {
  return {
    id: "runtime-session-1",
    claudeSessionId: "claude-session-1",
    taskSlug: "demo-task",
    role: "project-manager",
    status: "running",
    command: "claude --agent project-manager",
    permissionMode: "default",
    cwd: "/repo",
    terminalBackend: "node-pty",
    logPath: ".ai/handoffs/demo-task/logs/project-manager.log",
    updatedAt: "2026-05-30T00:00:00.000Z",
    ...overrides
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for transcript event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
