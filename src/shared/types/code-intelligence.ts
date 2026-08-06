import type { RoleName } from "./role.js";

export const CODE_INTELLIGENCE_ROLES = ["architect", "coder", "reviewer"] as const satisfies readonly RoleName[];
export const CODE_INTELLIGENCE_MCP_SERVER = "vcm_code_intelligence";
export const CODE_INTELLIGENCE_ALLOWED_TOOL = `mcp__${CODE_INTELLIGENCE_MCP_SERVER}__*`;

export const CODE_INTELLIGENCE_OPERATIONS = [
  "status",
  "document_symbols",
  "workspace_symbols",
  "definition",
  "implementations",
  "references",
  "incoming_calls",
  "outgoing_calls",
  "hover"
] as const;

export type CodeIntelligenceOperation = typeof CODE_INTELLIGENCE_OPERATIONS[number];
export type CodeIntelligenceQueryStatus = "resolved" | "not_found" | "unresolved";

export interface CodeIntelligenceQueryRequest {
  taskSlug: string;
  role: RoleName;
  runtimeSessionToken: string;
  operation: CodeIntelligenceOperation;
  path?: string;
  line?: number;
  character?: number;
  query?: string;
  language?: string;
}

export interface CodeIntelligenceQueryResult {
  status: CodeIntelligenceQueryStatus;
  operation: CodeIntelligenceOperation;
  workspaceRoot: string;
  language?: string;
  result?: unknown;
  reason?: string;
  errorCode?: string;
}
