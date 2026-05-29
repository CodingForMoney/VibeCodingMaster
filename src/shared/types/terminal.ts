import type { RoleName, RoleStatus } from "./role.js";

export type ClientTerminalMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type ServerTerminalMessage =
  | { type: "output"; data: string }
  | { type: "status"; status: RoleStatus }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };

export interface TerminalEvent {
  id: string;
  sessionId: string;
  taskSlug: string;
  role: RoleName;
  type: "input" | "output" | "status" | "exit" | "error" | "dispatch";
  timestamp: string;
  data?: string;
  status?: RoleStatus;
  exitCode?: number | null;
}
