import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { HarnessCodeIntelligenceStatus } from "../../../src/shared/types/harness.js";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import {
  prepareTaskLspPlugin,
  roleUsesLsp,
  VCM_LSP_PLUGIN_MANIFEST,
  VCM_LSP_PLUGIN_NAME
} from "../../../src/backend/services/lsp-plugin.js";

let tmpRepo: string | undefined;

afterEach(async () => {
  if (tmpRepo) await rm(tmpRepo, { recursive: true, force: true });
  tmpRepo = undefined;
});

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

    expect(roles.filter(roleUsesLsp)).toEqual(["architect"]);
  });

  it("declares every supported language server in the packaged plugin", async () => {
    const manifest = JSON.parse(await readFile(VCM_LSP_PLUGIN_MANIFEST, "utf8")) as {
      name?: string;
      lspServers?: Record<
        string,
        {
          command?: string;
          initializationOptions?: Record<string, unknown>;
          startupTimeout?: number;
          restartOnCrash?: boolean;
          maxRestarts?: number;
        }
      >;
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
    expect(manifest.lspServers?.["rust-analyzer"]?.startupTimeout).toBe(180_000);
    expect(manifest.lspServers?.["rust-analyzer"]?.initializationOptions).toEqual({
      checkOnSave: false
    });
    for (const server of Object.values(manifest.lspServers ?? {})) {
      expect(server.restartOnCrash).toBe(true);
      expect(server.maxRestarts).toBe(3);
    }
  });

  it("registers only runnable servers detected in the task worktree", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-lsp-plugin-"));
    const status: HarnessCodeIntelligenceStatus = {
      state: "available",
      languages: [{
        language: "rust", label: "Rust", serverCommand: "rust-analyzer", pluginName: VCM_LSP_PLUGIN_NAME,
        detected: true, pluginReady: true, serverFound: true, serverRunnable: true,
        state: "server_runnable", detectedBy: ["Cargo.toml"]
      }]
    };
    const [pluginDir] = await prepareTaskLspPlugin(createNodeFileSystemAdapter(), tmpRepo, status);
    const manifest = JSON.parse(await readFile(path.join(pluginDir!, ".claude-plugin/plugin.json"), "utf8"));
    expect(Object.keys(manifest.lspServers)).toEqual(["rust-analyzer"]);
  });

  it("omits a missing project language server without blocking other languages", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-lsp-plugin-"));
    const status: HarnessCodeIntelligenceStatus = {
      state: "partial",
      languages: [{
        language: "rust", label: "Rust", serverCommand: "rust-analyzer", pluginName: VCM_LSP_PLUGIN_NAME,
        detected: true, pluginReady: true, serverFound: true, serverRunnable: true,
        state: "server_runnable", detectedBy: ["Cargo.toml"]
      }, {
        language: "python", label: "Python", serverCommand: "pyright-langserver", pluginName: VCM_LSP_PLUGIN_NAME,
        detected: true, pluginReady: true, serverFound: false, serverRunnable: false,
        state: "server_missing", error: "pyright-langserver was not found in the VCM backend PATH.",
        detectedBy: ["pyproject.toml"]
      }]
    };
    const [pluginDir] = await prepareTaskLspPlugin(createNodeFileSystemAdapter(), tmpRepo, status);
    const manifest = JSON.parse(await readFile(path.join(pluginDir!, ".claude-plugin/plugin.json"), "utf8"));
    expect(Object.keys(manifest.lspServers)).toEqual(["rust-analyzer"]);
    expect(await prepareTaskLspPlugin(createNodeFileSystemAdapter(), tmpRepo, { ...status, languages: status.languages.slice(1) })).toEqual([]);
  });
});
