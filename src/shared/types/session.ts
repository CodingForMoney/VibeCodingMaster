import type { RoleName, RoleStatus } from "./role.js";

export type RoleActivityStatus = "idle" | "running";

export type ClaudePermissionMode =
  | "default"
  | "bypassPermissions";

export const CLAUDE_MODEL_OPTIONS = [
  {
    value: "default",
    label: "Default",
    description: "Account default"
  },
  {
    value: "best",
    label: "Best",
    description: "Fable 5 or latest Opus"
  },
  {
    value: "fable",
    label: "Fable 5",
    description: "1M context, v2.1.170+"
  },
  {
    value: "opus",
    label: "Opus",
    description: "latest Opus"
  },
  {
    value: "opus[1m]",
    label: "Opus 1M",
    description: "Force 1M context"
  },
  {
    value: "claude-opus-4-8",
    label: "Opus 4.8",
    description: "Current Opus"
  },
  {
    value: "claude-opus-4-8[1m]",
    label: "Opus 4.8 1M",
    description: "Opus 4.8 + 1M context"
  }
] as const;

export type ClaudeModel = typeof CLAUDE_MODEL_OPTIONS[number]["value"];

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
  model?: ClaudeModel;
  cwd: string;
  terminalBackend: "node-pty";
  pid?: number;
  logPath: string;
  roleCommandPath?: string;
  handoffArtifactPath?: string;
  startedAt?: string;
  updatedAt: string;
  lastOutputAt?: string;
  lastTurnStartedAt?: string;
  lastTurnEndedAt?: string;
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
  model?: ClaudeModel;
}
