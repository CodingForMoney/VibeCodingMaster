import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODE_INTELLIGENCE_MCP_SERVER,
  CODE_INTELLIGENCE_ROLES
} from "../../shared/types/code-intelligence.js";
import type { RoleName } from "../../shared/types/role.js";

export const VCM_CODE_INTELLIGENCE_PLUGIN_NAME = "vcm-code-intelligence-bridge";
export const VCM_CODE_INTELLIGENCE_MCP_NAME = CODE_INTELLIGENCE_MCP_SERVER;
export const VCM_CODE_INTELLIGENCE_PLUGIN_DIR = fileURLToPath(
  new URL("../../../scripts/claude-plugins/vcm-lsp-bridge", import.meta.url)
);
export const VCM_CODE_INTELLIGENCE_PLUGIN_MANIFEST = path.join(
  VCM_CODE_INTELLIGENCE_PLUGIN_DIR,
  ".claude-plugin",
  "plugin.json"
);
export const VCM_CODE_INTELLIGENCE_MCP_MANIFEST = path.join(
  VCM_CODE_INTELLIGENCE_PLUGIN_DIR,
  ".mcp.json"
);

const CODE_INTELLIGENCE_ROLE_SET = new Set<RoleName>(CODE_INTELLIGENCE_ROLES);

export function roleUsesCodeIntelligence(role: RoleName): boolean {
  return CODE_INTELLIGENCE_ROLE_SET.has(role);
}

export const CODE_INTELLIGENCE_MCP_TOOLS = [
  "mcp__vcm_code_intelligence__status",
  "mcp__vcm_code_intelligence__document_symbols",
  "mcp__vcm_code_intelligence__workspace_symbols",
  "mcp__vcm_code_intelligence__definition",
  "mcp__vcm_code_intelligence__implementations",
  "mcp__vcm_code_intelligence__references",
  "mcp__vcm_code_intelligence__incoming_calls",
  "mcp__vcm_code_intelligence__outgoing_calls",
  "mcp__vcm_code_intelligence__hover"
] as const;

export const CODE_INTELLIGENCE_AGENT_TOOLS = CODE_INTELLIGENCE_MCP_TOOLS.join(", ");
