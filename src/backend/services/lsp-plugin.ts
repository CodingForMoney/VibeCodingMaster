import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessCodeIntelligenceStatus } from "../../shared/types/harness.js";
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
