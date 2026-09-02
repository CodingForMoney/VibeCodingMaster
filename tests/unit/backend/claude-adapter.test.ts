import { describe, expect, it } from "vitest";
import { createClaudeAdapter } from "../../../src/backend/adapters/claude-adapter.js";
import { CODE_ROLE_RUNTIME_DISALLOWED_TOOLS } from "../../../src/backend/role-tool-policy.js";

describe("createClaudeAdapter", () => {
  const adapter = createClaudeAdapter({
    async run() {
      return { stdout: "2.1.156", stderr: "", exitCode: 0 };
    }
  });

  it("builds the default role command with the default model", () => {
    expect(adapter.buildRoleStartCommand("coder", "claude", "default", "00000000-0000-4000-8000-000000000001")).toEqual({
      command: "claude",
      args: ["--allowedTools", "Glob,Grep", "--agent", "coder", "--session-id", "00000000-0000-4000-8000-000000000001", "--model", "default"],
      display: "claude --allowedTools 'Glob,Grep' --agent coder --session-id 00000000-0000-4000-8000-000000000001 --model default"
    });
  });

  it("builds bypassPermissions as a permission mode", () => {
    expect(adapter.buildRoleStartCommand("coder", "claude", "bypassPermissions")).toEqual({
      command: "claude",
      args: ["--allowedTools", "Glob,Grep", "--agent", "coder", "--model", "default", "--permission-mode", "bypassPermissions"],
      display: "claude --allowedTools 'Glob,Grep' --agent coder --model default --permission-mode bypassPermissions"
    });
  });

  it("builds plan as a permission mode", () => {
    expect(adapter.buildRoleStartCommand("architect", "claude", "plan")).toEqual({
      command: "claude",
      args: ["--allowedTools", "Glob,Grep", "--agent", "architect", "--model", "default", "--permission-mode", "plan"],
      display: "claude --allowedTools 'Glob,Grep' --agent architect --model default --permission-mode plan"
    });
  });

  it("keeps non-LSP roles on the built-in search tools", () => {
    expect(adapter.buildRoleStartCommand("project-manager").args.slice(0, 4)).toEqual([
      "--allowedTools",
      "Glob,Grep",
      "--agent",
      "project-manager"
    ]);
  });

  it("builds role commands with a selected model", () => {
    expect(adapter.buildRoleStartCommand(
      "coder",
      "claude",
      "default",
      "00000000-0000-4000-8000-000000000001",
      false,
      "opus"
    )).toEqual({
      command: "claude",
      args: [
        "--allowedTools",
        "Glob,Grep",
        "--agent",
        "coder",
        "--session-id",
        "00000000-0000-4000-8000-000000000001",
        "--model",
        "opus"
      ],
      display: "claude --allowedTools 'Glob,Grep' --agent coder --session-id 00000000-0000-4000-8000-000000000001 --model opus"
    });
  });

  it("builds role commands with the pinned Opus 4.8 model", () => {
    expect(adapter.buildRoleStartCommand(
      "architect",
      "claude",
      "default",
      undefined,
      false,
      "claude-opus-4-8"
    )).toEqual({
      command: "claude",
      args: [
        "--allowedTools",
        "Glob,Grep",
        "--agent",
        "architect",
        "--model",
        "claude-opus-4-8"
      ],
      display: "claude --allowedTools 'Glob,Grep' --agent architect --model claude-opus-4-8"
    });
  });

  it("builds role commands with the pinned Fable 5.1 model", () => {
    expect(adapter.buildRoleStartCommand(
      "architect",
      "claude",
      "default",
      undefined,
      false,
      "claude-fable-5-1"
    )).toEqual({
      command: "claude",
      args: [
        "--allowedTools",
        "Glob,Grep",
        "--agent",
        "architect",
        "--model",
        "claude-fable-5-1"
      ],
      display: "claude --allowedTools 'Glob,Grep' --agent architect --model claude-fable-5-1"
    });
  });

  it("uses the child environment instead of --model for Codex Bridge models", () => {
    expect(adapter.buildRoleStartCommand(
      "coder",
      "claude",
      "default",
      undefined,
      false,
      "codex-bridge:gpt-5.5",
      "medium"
    )).toEqual({
      command: "claude",
      args: ["--allowedTools", "Glob,Grep", "--agent", "coder", "--effort", "medium"],
      display: "claude --allowedTools 'Glob,Grep' --agent coder --effort medium"
    });
  });

  it("applies a session-only settings override to native Claude models", () => {
    const settingsOverride = {
      apiKeyHelper: "",
      env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }
    };
    expect(adapter.buildRoleStartCommand(
      "coder",
      "claude",
      "default",
      undefined,
      false,
      "sonnet",
      "medium",
      settingsOverride
    )).toEqual({
      command: "claude",
      args: [
        "--allowedTools",
        "Glob,Grep",
        "--agent",
        "coder",
        "--model",
        "sonnet",
        "--effort",
        "medium",
        "--settings",
        JSON.stringify(settingsOverride)
      ],
      display: `claude --allowedTools 'Glob,Grep' --agent coder --model sonnet --effort medium --settings '${JSON.stringify(settingsOverride)}'`
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
        "--allowedTools",
        "Glob,Grep",
        "--agent",
        "architect",
        "--session-id",
        "00000000-0000-4000-8000-000000000001",
        "--model",
        "opus",
        "--effort",
        "xhigh"
      ],
      display: "claude --allowedTools 'Glob,Grep' --agent architect --session-id 00000000-0000-4000-8000-000000000001 --model opus --effort xhigh"
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
        "--allowedTools",
        "Glob,Grep",
        "--agent",
        "architect",
        "--session-id",
        "00000000-0000-4000-8000-000000000001",
        "--model",
        "fable",
        "--settings",
        "{\"ultracode\":true}"
      ],
      display: "claude --allowedTools 'Glob,Grep' --agent architect --session-id 00000000-0000-4000-8000-000000000001 --model fable --settings '{\"ultracode\":true}'"
    });
  });

  it("appends a restoration system prompt for a fresh role session", () => {
    expect(adapter.buildRoleStartCommand(
      "architect",
      "claude",
      "bypassPermissions",
      undefined,
      false,
      "fable",
      "high",
      undefined,
      "Read the completed architecture artifacts."
    )).toEqual({
      command: "claude",
      args: [
        "--allowedTools",
        "Glob,Grep",
        "--agent",
        "architect",
        "--model",
        "fable",
        "--effort",
        "high",
        "--permission-mode",
        "bypassPermissions",
        "--append-system-prompt",
        "Read the completed architecture artifacts."
      ],
      display: "claude --allowedTools 'Glob,Grep' --agent architect --model fable --effort high --permission-mode bypassPermissions --append-system-prompt 'Read the completed architecture artifacts.'"
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
      args: ["--allowedTools", "Glob,Grep", "--agent", "architect", "--resume", "00000000-0000-4000-8000-000000000002", "--model", "default"],
      display: "claude --allowedTools 'Glob,Grep' --agent architect --resume 00000000-0000-4000-8000-000000000002 --model default"
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
        "--allowedTools",
        "Glob,Grep",
        "--agent",
        "coder",
        "--resume",
        "00000000-0000-4000-8000-000000000003",
        "--model",
        "default",
        "--permission-mode",
        "bypassPermissions"
      ],
      display: "claude --allowedTools 'Glob,Grep' --agent coder --resume 00000000-0000-4000-8000-000000000003 --model default --permission-mode bypassPermissions"
    });
  });

  it("loads VCM-managed plugins before the selected role", () => {
    expect(CODE_ROLE_RUNTIME_DISALLOWED_TOOLS).not.toContain("Skill");
    expect(adapter.buildRoleStartCommand(
      "architect",
      "claude",
      "default",
      undefined,
      false,
      "opus",
      "medium",
      undefined,
      undefined,
      ["/opt/vcm/plugins/vcm-lsp-bridge"]
    )).toEqual({
      command: "claude",
      args: [
        "--plugin-dir",
        "/opt/vcm/plugins/vcm-lsp-bridge",
        "--disallowedTools",
        CODE_ROLE_RUNTIME_DISALLOWED_TOOLS.join(","),
        "--agent",
        "architect",
        "--model",
        "opus",
        "--effort",
        "medium"
      ],
      display: `claude --plugin-dir /opt/vcm/plugins/vcm-lsp-bridge --disallowedTools '${CODE_ROLE_RUNTIME_DISALLOWED_TOOLS.join(",")}' --agent architect --model opus --effort medium`
    });
  });

  it("does not expose LSP runtime tools to Reviewer", () => {
    const command = adapter.buildRoleStartCommand(
      "reviewer",
      "claude",
      "default",
      undefined,
      false,
      "default",
      "default",
      undefined,
      undefined,
      ["/opt/vcm/plugins/vcm-lsp-bridge"]
    );

    expect(command.args).toEqual(expect.arrayContaining(["--allowedTools", "Glob,Grep"]));
    expect(command.args).not.toContain("--disallowedTools");
  });
});
