import type { RoleName, RoleStatus } from "./role.js";

export type ClaudePermissionMode =
  | "default"
  | "bypassPermissions"
  | "dangerously-skip-permissions";

export interface RoleSessionRecord {
  id: string;
  claudeSessionId: string;
  taskSlug: string;
  role: RoleName;
  status: RoleStatus;
  command: string;
  permissionMode: ClaudePermissionMode;
  cwd: string;
  terminalBackend: "node-pty";
  pid?: number;
  logPath: string;
  roleCommandPath?: string;
  handoffArtifactPath?: string;
  startedAt?: string;
  updatedAt: string;
  lastOutputAt?: string;
  exitCode?: number | null;
}

export interface TaskSessionRecord {
  version: 1;
  taskSlug: string;
  updatedAt: string;
  roles: Record<RoleName, RoleSessionPointer>;
}

export interface RoleSessionPointer {
  id: string | null;
  claudeSessionId?: string;
  status: RoleStatus;
  record?: RoleSessionRecord;
}

export interface StartRoleSessionRequest {
  cols?: number;
  rows?: number;
  permissionMode?: ClaudePermissionMode;
}
