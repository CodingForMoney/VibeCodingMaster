import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessCodeIntelligenceLanguageStatus, HarnessCodeIntelligenceStatus } from "../../shared/types/harness.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
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

interface LspPluginManifest {
  name: string;
  lspServers: Record<string, { command: string; [key: string]: unknown }>;
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
    Object.entries(manifest.lspServers).filter(([, server]) => commands.has(server.command))
  );
  const pluginDir = path.join(taskRepoRoot, ".ai/vcm/lsp-plugin");
  const pluginManifestPath = path.join(pluginDir, ".claude-plugin/plugin.json");
  await fs.ensureDir(path.dirname(pluginManifestPath));
  await fs.writeJsonAtomic(pluginManifestPath, { ...manifest, lspServers });
  return [pluginDir];
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
  return `Architect LSP for ${language.label} is unavailable: ${language.error ?? `${language.serverCommand} is not runnable.`} ${recovery} Restart Architect after fixing the environment so VCM can detect and register the server again.`;
}

export function renderArchitectLspNotice(status: HarnessCodeIntelligenceStatus): string | undefined {
  if (status.languages.length === 0) return undefined;
  const available = status.languages.filter((language) => language.state === "server_runnable");
  const unavailable = status.languages.filter((language) => language.state !== "server_runnable");
  return [
    "[VCM Architect LSP Availability]",
    `Registered language servers: ${available.map((language) => `${language.label} (${language.serverCommand})`).join(", ") || "none"}.`,
    ...unavailable.map(lspUnavailableWarning),
    ...(unavailable.length > 0 ? [
      "If your assignment requires a semantic query in an unavailable language, stop that work and report the environment prerequisite through the current communication channel. Do not substitute source text search or claim the relationship is verified. Continue only after the server is available."
    ] : [])
  ].join("\n");
}
