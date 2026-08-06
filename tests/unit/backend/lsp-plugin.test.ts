import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RoleName } from "../../../src/shared/types/role.js";
import {
  CODE_INTELLIGENCE_MCP_TOOLS,
  roleUsesCodeIntelligence,
  VCM_CODE_INTELLIGENCE_MCP_MANIFEST,
  VCM_CODE_INTELLIGENCE_PLUGIN_MANIFEST,
  VCM_CODE_INTELLIGENCE_PLUGIN_NAME
} from "../../../src/backend/services/lsp-plugin.js";

describe("VCM code intelligence plugin", () => {
  it("loads only for code-reading workflow roles", () => {
    const roles: RoleName[] = [
      "project-manager",
      "architect",
      "coder",
      "tester",
      "reviewer",
      "translator",
      "harness-engineer"
    ];

    expect(roles.filter(roleUsesCodeIntelligence)).toEqual(["architect", "coder", "reviewer"]);
  });

  it("provides a stateless MCP bridge without per-session language servers", async () => {
    const manifest = JSON.parse(await readFile(VCM_CODE_INTELLIGENCE_PLUGIN_MANIFEST, "utf8")) as {
      name?: string;
      lspServers?: unknown;
    };
    const mcp = JSON.parse(await readFile(VCM_CODE_INTELLIGENCE_MCP_MANIFEST, "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };

    expect(manifest.name).toBe(VCM_CODE_INTELLIGENCE_PLUGIN_NAME);
    expect(manifest.lspServers).toBeUndefined();
    expect(mcp.mcpServers?.vcm_code_intelligence).toEqual({
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"]
    });
    expect(CODE_INTELLIGENCE_MCP_TOOLS).toContain("mcp__vcm_code_intelligence__references");
  });
});
