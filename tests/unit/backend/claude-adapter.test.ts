import { describe, expect, it } from "vitest";
import { createClaudeAdapter } from "../../../src/backend/adapters/claude-adapter.js";

describe("createClaudeAdapter", () => {
  const adapter = createClaudeAdapter({
    async run() {
      return { stdout: "2.1.156", stderr: "", exitCode: 0 };
    }
  });

  it("builds the default role command with the default model", () => {
    expect(adapter.buildRoleStartCommand("coder", "claude", "default", "00000000-0000-4000-8000-000000000001")).toEqual({
      command: "claude",
      args: ["--agent", "coder", "--session-id", "00000000-0000-4000-8000-000000000001", "--model", "default"],
      display: "claude --agent coder --session-id 00000000-0000-4000-8000-000000000001 --model default"
    });
  });

  it("builds bypassPermissions as a permission mode", () => {
    expect(adapter.buildRoleStartCommand("coder", "claude", "bypassPermissions")).toEqual({
      command: "claude",
      args: ["--agent", "coder", "--model", "default", "--permission-mode", "bypassPermissions"],
      display: "claude --agent coder --model default --permission-mode bypassPermissions"
    });
  });

  it("builds plan as a permission mode", () => {
    expect(adapter.buildRoleStartCommand("architect", "claude", "plan")).toEqual({
      command: "claude",
      args: ["--agent", "architect", "--model", "default", "--permission-mode", "plan"],
      display: "claude --agent architect --model default --permission-mode plan"
    });
  });

  it("builds role commands with a selected model", () => {
    expect(adapter.buildRoleStartCommand(
      "coder",
      "claude",
      "default",
      "00000000-0000-4000-8000-000000000001",
      false,
      "claude-opus-4-8[1m]"
    )).toEqual({
      command: "claude",
      args: [
        "--agent",
        "coder",
        "--session-id",
        "00000000-0000-4000-8000-000000000001",
        "--model",
        "claude-opus-4-8[1m]"
      ],
      display: "claude --agent coder --session-id 00000000-0000-4000-8000-000000000001 --model 'claude-opus-4-8[1m]'"
    });
  });

  it("adds effort when one is selected", () => {
    expect(adapter.buildRoleStartCommand(
      "architect",
      "claude",
      "default",
      "00000000-0000-4000-8000-000000000001",
      false,
      "opus",
      "xhigh"
    )).toEqual({
      command: "claude",
      args: [
        "--agent",
        "architect",
        "--session-id",
        "00000000-0000-4000-8000-000000000001",
        "--model",
        "opus",
        "--effort",
        "xhigh"
      ],
      display: "claude --agent architect --session-id 00000000-0000-4000-8000-000000000001 --model opus --effort xhigh"
    });
  });

  it("sets ultracode through session settings instead of --effort", () => {
    expect(adapter.buildRoleStartCommand(
      "architect",
      "claude",
      "default",
      "00000000-0000-4000-8000-000000000001",
      false,
      "fable",
      "ultracode"
    )).toEqual({
      command: "claude",
      args: [
        "--agent",
        "architect",
        "--session-id",
        "00000000-0000-4000-8000-000000000001",
        "--model",
        "fable",
        "--settings",
        "{\"ultracode\":true}"
      ],
      display: "claude --agent architect --session-id 00000000-0000-4000-8000-000000000001 --model fable --settings '{\"ultracode\":true}'"
    });
  });

  it("builds resume commands with the persisted Claude session id", () => {
    expect(adapter.buildRoleStartCommand(
      "architect",
      "claude",
      "default",
      "00000000-0000-4000-8000-000000000002",
      true
    )).toEqual({
      command: "claude",
      args: ["--agent", "architect", "--resume", "00000000-0000-4000-8000-000000000002", "--model", "default"],
      display: "claude --agent architect --resume 00000000-0000-4000-8000-000000000002 --model default"
    });
  });

  it("keeps bypassPermissions on resume commands", () => {
    expect(adapter.buildRoleStartCommand(
      "coder",
      "claude",
      "bypassPermissions",
      "00000000-0000-4000-8000-000000000003",
      true
    )).toEqual({
      command: "claude",
      args: [
        "--agent",
        "coder",
        "--resume",
        "00000000-0000-4000-8000-000000000003",
        "--model",
        "default",
        "--permission-mode",
        "bypassPermissions"
      ],
      display: "claude --agent coder --resume 00000000-0000-4000-8000-000000000003 --model default --permission-mode bypassPermissions"
    });
  });
});
