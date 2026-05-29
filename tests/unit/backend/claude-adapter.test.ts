import { describe, expect, it } from "vitest";
import { createClaudeAdapter } from "../../../src/backend/adapters/claude-adapter.js";

describe("createClaudeAdapter", () => {
  const adapter = createClaudeAdapter({
    async run() {
      return { stdout: "2.1.156", stderr: "", exitCode: 0 };
    }
  });

  it("builds the default role command without extra permission flags", () => {
    expect(adapter.buildRoleStartCommand("coder", "claude", "default", "00000000-0000-4000-8000-000000000001")).toEqual({
      command: "claude",
      args: ["--agent", "coder", "--session-id", "00000000-0000-4000-8000-000000000001"],
      display: "claude --agent coder --session-id 00000000-0000-4000-8000-000000000001"
    });
  });

  it("builds bypassPermissions as a permission mode", () => {
    expect(adapter.buildRoleStartCommand("coder", "claude", "bypassPermissions")).toEqual({
      command: "claude",
      args: ["--agent", "coder", "--permission-mode", "bypassPermissions"],
      display: "claude --agent coder --permission-mode bypassPermissions"
    });
  });

  it("builds dangerously skip permissions as a dedicated flag", () => {
    expect(adapter.buildRoleStartCommand("coder", "claude", "dangerously-skip-permissions")).toEqual({
      command: "claude",
      args: ["--agent", "coder", "--dangerously-skip-permissions"],
      display: "claude --agent coder --dangerously-skip-permissions"
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
      args: ["--agent", "architect", "--resume", "00000000-0000-4000-8000-000000000002"],
      display: "claude --agent architect --resume 00000000-0000-4000-8000-000000000002"
    });
  });

  it("keeps dangerously skip permissions on resume commands", () => {
    expect(adapter.buildRoleStartCommand(
      "coder",
      "claude",
      "dangerously-skip-permissions",
      "00000000-0000-4000-8000-000000000003",
      true
    )).toEqual({
      command: "claude",
      args: [
        "--agent",
        "coder",
        "--resume",
        "00000000-0000-4000-8000-000000000003",
        "--dangerously-skip-permissions"
      ],
      display: "claude --agent coder --resume 00000000-0000-4000-8000-000000000003 --dangerously-skip-permissions"
    });
  });
});
