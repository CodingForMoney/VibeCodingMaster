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

  it("caches the probe and refreshes a stale result in the background", async () => {
    let probes = 0;
    let clock = 0;
    let version = "2.1.400 (Claude Code)";
    const check = createClaudeVersionCheck({
      async getVersion() {
        probes += 1;
        return version;
      }
    }, () => clock);

    await check.getWarning("claude");
    await check.getWarning("claude");
    expect(probes).toBe(1);
    await check.getWarning("claude", { refresh: true });
    expect(probes).toBe(2);

    clock += 10 * 60 * 1000;
    version = "2.1.1 (Claude Code)";
    // A stale entry answers immediately with the cached result while a new probe runs.
    await expect(check.getWarning("claude")).resolves.toBeUndefined();
    expect(probes).toBe(3);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(check.getWarning("claude")).resolves.toContain("Claude Code 2.1.1 is older");
    expect(probes).toBe(3);
  });

  it("shares one probe between concurrent callers", async () => {
    let probes = 0;
    let release: (value: string) => void = () => undefined;
    const check = createClaudeVersionCheck({
      getVersion() {
        probes += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    });

    const pending = [check.getWarning("claude"), check.getWarning("claude"), check.getWarning("claude")];
    release("2.1.400 (Claude Code)");

    await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined, undefined]);
    expect(probes).toBe(1);
  });

  it("reports a probe that does not answer in time and retries failures sooner", async () => {
    let clock = 0;
    let respond = false;
    const check = createClaudeVersionCheck({
      getVersion() {
        return respond ? Promise.resolve("2.1.400 (Claude Code)") : new Promise(() => undefined);
      }
    }, () => clock, 20);

    await expect(check.getWarning("claude")).resolves.toContain("did not respond within 20ms");

    respond = true;
    clock += 30 * 1000;
    await expect(check.getWarning("claude")).resolves.toContain("did not respond");
    await new Promise((resolve) => setImmediate(resolve));
    await expect(check.getWarning("claude")).resolves.toBeUndefined();
  });

  it("parses the semantic version from Claude Code output", () => {
    expect(parseClaudeCodeVersion("2.1.310 (Claude Code)")).toEqual([2, 1, 310]);
    expect(parseClaudeCodeVersion("Claude Code")).toBeUndefined();
  });
});
