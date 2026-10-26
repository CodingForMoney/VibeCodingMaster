import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessCodeIntelligenceLanguageStatus, HarnessCodeIntelligenceStatus } from "../../shared/types/harness.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { RoleName } from "../../shared/types/role.js";
export { roleUsesLsp } from "../role-tool-policy.js";

export const VCM_LSP_PLUGIN_NAME = "vcm-lsp-bridge";
export const VCM_LSP_PLUGIN_DIR = fileURLToPath(
  new URL("../../../scripts/claude-plugins/vcm-lsp-bridge", import.meta.url)
);
export const VCM_LSP_PLUGIN_MANIFEST = path.join(
  VCM_LSP_PLUGIN_DIR,
  ".claude-plugin",
  "plugin.json"
);
export const VCM_LSP_PROXY_PATH = path.join(VCM_LSP_PLUGIN_DIR, "vcm-lsp-proxy.mjs");

interface LspServerEntry {
  command: string;
  args?: string[];
  [key: string]: unknown;
}

interface LspPluginManifest {
  name: string;
  lspServers: Record<string, LspServerEntry>;
  [key: string]: unknown;
}

export async function prepareTaskLspPlugin(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  status: HarnessCodeIntelligenceStatus
): Promise<string[]> {
  const runnable = status.languages.filter((language) => language.state === "server_runnable");
  if (runnable.length === 0) return [];

  const manifest = await fs.readJson<LspPluginManifest>(VCM_LSP_PLUGIN_MANIFEST);
  const commands = new Set(runnable.map((language) => language.serverCommand));
  const lspServers = Object.fromEntries(
    Object.entries(manifest.lspServers)
      .filter(([, server]) => commands.has(server.command))
      .map(([name, server]) => [name, withReadinessProxy(server)])
  );
  const pluginDir = path.join(taskRepoRoot, ".ai/vcm/lsp-plugin");
  const pluginManifestPath = path.join(pluginDir, ".claude-plugin/plugin.json");
  await fs.ensureDir(path.dirname(pluginManifestPath));
  await fs.writeJsonAtomic(pluginManifestPath, { ...manifest, lspServers });
  return [pluginDir];
}

// Runs the server behind vcm-lsp-proxy so navigation queries wait for indexing
// to finish, or fail explicitly, instead of returning partial or empty results.
function withReadinessProxy(server: LspServerEntry): LspServerEntry {
  return {
    ...server,
    command: process.execPath,
    args: [VCM_LSP_PROXY_PATH, "--", server.command, ...(server.args ?? [])]
  };
}

export function lspUnavailableWarning(language: HarnessCodeIntelligenceLanguageStatus): string {
  const installCommands: Record<string, string> = {
    "rust-analyzer": "rustup component add rust-analyzer",
    "typescript-language-server": "npm install -g typescript typescript-language-server",
    "pyright-langserver": "npm install -g pyright",
    "gopls": "go install golang.org/x/tools/gopls@latest"
  };
  const recovery = language.state === "plugin_missing"
    ? "Refresh the VCM Harness to restore the LSP plugin."
    : `Install or repair ${language.serverCommand} in the environment running the VCM backend${installCommands[language.serverCommand] ? ` (${installCommands[language.serverCommand]})` : ""} and ensure it is executable on PATH.`;
  return `LSP for ${language.label} is unavailable: ${language.error ?? `${language.serverCommand} is not runnable.`} ${recovery} Restart the LSP roles (Architect, Reviewer) after fixing the environment so VCM can detect and register the server again.`;
}

// Architect stops semantic work in an unavailable language; Reviewer completes
// the review and records those relationships as not LSP-verified.
export function renderLspNotice(status: HarnessCodeIntelligenceStatus, role: RoleName = "architect"): string | undefined {
  if (status.languages.length === 0) return undefined;
  const available = status.languages.filter((language) => language.state === "server_runnable");
  const unavailable = status.languages.filter((language) => language.state !== "server_runnable");
  return [
    "[VCM LSP Availability]",
    `Registered language servers: ${available.map((language) => `${language.label} (${language.serverCommand})`).join(", ") || "none"}.`,
    ...(available.length > 0 ? [
      "While a server is still indexing, VCM holds LSP queries until it is ready. A query that fails with \"Language server is still indexing\" did not return a result: retry it later or record the relationship as unresolved; never read the failure as an empty result."
    ] : []),
    ...unavailable.map(lspUnavailableWarning),
    ...(unavailable.length > 0 ? [
      role === "reviewer"
        ? "For relationships in an unavailable language, complete the review by reading the complete candidate code, record each such relationship as not LSP-verified in the report, and name the missing server. Do not stop the review or treat text matches as verified relationships."
        : "If your assignment requires a semantic query in an unavailable language, stop that work and report the environment prerequisite through the current communication channel. Do not substitute source text search or claim the relationship is verified. Continue only after the server is available."
    ] : [])
  ].join("\n");
}
