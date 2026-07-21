import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createClaudeSettingsAdapter,
  restoreNativeClaudeSettings
} from "../../../src/backend/adapters/claude-settings-adapter.js";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Claude settings CCR takeover restoration", () => {
  it("removes only CCR-owned user settings and preserves unrelated configuration", () => {
    expect(restoreNativeClaudeSettings({
      theme: "dark",
      apiKeyHelper: "/home/user/.claude-code-router/bin/helper",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
        CLAUDE_AGENT_API_BASE_URL: "http://127.0.0.1:3456",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_MODEL: "Codex API/gpt-5.6-sol",
        KEEP_ME: "yes"
      }
    })).toEqual({
      changed: true,
      settings: {
        theme: "dark",
        env: { KEEP_ME: "yes" }
      }
    });
  });

  it("does not change unrelated custom gateway settings", () => {
    const settings = {
      apiKeyHelper: "/opt/company/api-key-helper",
      env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" }
    };
    expect(restoreNativeClaudeSettings(settings)).toEqual({
      changed: false,
      settings
    });
  });

  it("writes the restored user settings atomically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-claude-settings-"));
    tempDirs.push(dir);
    const settingsPath = path.join(dir, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({
      apiKeyHelper: "/home/user/.claude-code-router/bin/helper",
      env: { ANTHROPIC_BASE_URL: "http://host.docker.internal:3456" },
      permissions: { defaultMode: "plan" }
    }), "utf8");
    const adapter = createClaudeSettingsAdapter({
      fs: createNodeFileSystemAdapter(),
      settingsPath
    });

    await expect(adapter.restoreNativeSettings()).resolves.toBe(true);
    await expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual({
      permissions: { defaultMode: "plan" }
    });
    await expect(adapter.restoreNativeSettings()).resolves.toBe(false);
  });
});
