import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleName } from "../../shared/types/role.js";

export const VCM_LSP_PLUGIN_NAME = "vcm-lsp-bridge";
export const VCM_LSP_PLUGIN_DIR = fileURLToPath(
  new URL("../../../scripts/claude-plugins/vcm-lsp-bridge", import.meta.url)
);
export const VCM_LSP_PLUGIN_MANIFEST = path.join(
  VCM_LSP_PLUGIN_DIR,
  ".claude-plugin",
  "plugin.json"
);

const LSP_ROLES = new Set<RoleName>(["architect", "coder", "reviewer"]);

export function roleUsesLsp(role: RoleName): boolean {
  return LSP_ROLES.has(role);
}
