import { describe, expect, it } from "vitest";
import {
  createClaudeVersionCheck,
  MIN_CLAUDE_CODE_VERSION,
  parseClaudeCodeVersion
} from "../../../src/backend/services/claude-version-check.js";

describe("claude-version-check", () => {
  it("warns only when Claude Code is older than the minimum verified version", async () => {
    const versions = new Map([
      ["claude-old", "2.1.309 (Claude Code)"],
      ["claude-min", `${MIN_CLAUDE_CODE_VERSION} (Claude Code)`],
      ["claude-new", "2.2.0 (Claude Code)"],
      ["claude-major", "10.0.0 (Claude Code)"]
    ]);
    const check = createClaudeVersionCheck({
      async getVersion(command = "claude") {
        return versions.get(command)!;
      }
    });

    await expect(check.getWarning("claude-old")).resolves.toBe(
      `Claude Code 2.1.309 is older than the minimum verified version ${MIN_CLAUDE_CODE_VERSION}. Upgrade Claude Code; older releases may lack hooks or flags VCM relies on.`
    );
    await expect(check.getWarning("claude-min")).resolves.toBeUndefined();
    await expect(check.getWarning("claude-new")).resolves.toBeUndefined();
    await expect(check.getWarning("claude-major")).resolves.toBeUndefined();
  });

  it("warns when the version cannot be probed or parsed", async () => {
    const check = createClaudeVersionCheck({
      async getVersion(command = "claude") {
        if (command === "missing") {
          throw new Error("Claude Code command is not available: missing");
        }
        return "unknown build";
      }
    });

    await expect(check.getWarning("missing")).resolves.toContain("could not be checked");
    await expect(check.getWarning("claude")).resolves.toContain("could not be parsed");
  });

  it("caches the probe until it expires or a refresh is requested", async () => {
    let probes = 0;
    let clock = 0;
    const check = createClaudeVersionCheck({
      async getVersion() {
        probes += 1;
        return "2.1.400 (Claude Code)";
      }
    }, () => clock);

    await check.getWarning("claude");
    await check.getWarning("claude");
    expect(probes).toBe(1);
    await check.getWarning("claude", { refresh: true });
    expect(probes).toBe(2);
    clock += 10 * 60 * 1000;
    await check.getWarning("claude");
    expect(probes).toBe(3);
  });

  it("parses the semantic version from Claude Code output", () => {
    expect(parseClaudeCodeVersion("2.1.310 (Claude Code)")).toEqual([2, 1, 310]);
    expect(parseClaudeCodeVersion("Claude Code")).toBeUndefined();
  });
});
