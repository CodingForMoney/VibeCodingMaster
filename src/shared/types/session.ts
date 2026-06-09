import type { RoleName, RoleStatus } from "./role.js";

export type RoleActivityStatus = "idle" | "running";

export type ClaudePermissionMode =
  | "default"
  | "bypassPermissions";

export interface RoleSessionRecord {
  id: string;
  claudeSessionId: string;
  transcriptPath?: string;
  taskSlug: string;
  role: RoleName;
  status: RoleStatus;
  activityStatus?: RoleActivityStatus;
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
  lastPromptSubmittedAt?: string;
  lastStopAt?: string;
  lastHookEventAt?: string;
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
  transcriptPath?: string;
  status: RoleStatus;
  record?: RoleSessionRecord;
}

export interface StartRoleSessionRequest {
  cols?: number;
  rows?: number;
  permissionMode?: ClaudePermissionMode;
}
