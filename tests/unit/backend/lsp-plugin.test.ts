import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RoleName } from "../../../src/shared/types/role.js";
import {
  roleUsesLsp,
  VCM_LSP_PLUGIN_MANIFEST,
  VCM_LSP_PLUGIN_NAME
} from "../../../src/backend/services/lsp-plugin.js";

describe("VCM LSP plugin", () => {
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

    expect(roles.filter(roleUsesLsp)).toEqual(["architect", "coder", "reviewer"]);
  });

  it("declares every supported language server in the packaged plugin", async () => {
    const manifest = JSON.parse(await readFile(VCM_LSP_PLUGIN_MANIFEST, "utf8")) as {
      name?: string;
      lspServers?: Record<string, { command?: string }>;
    };

    expect(manifest.name).toBe(VCM_LSP_PLUGIN_NAME);
    expect(Object.values(manifest.lspServers ?? {}).map((server) => server.command)).toEqual([
      "rust-analyzer",
      "typescript-language-server",
      "pyright-langserver",
      "gopls",
      "clangd",
      "jdtls"
    ]);
  });
});
