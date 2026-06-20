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

export const CODEX_MODEL_OPTIONS = [
  {
    value: "gpt-5.5",
    label: "GPT-5.5",
    description: "Strong Codex reviewer default"
  },
  {
    value: "default",
    label: "Default",
    description: "Codex account default"
  }
] as const;

export type CodexModel = typeof CODEX_MODEL_OPTIONS[number]["value"];
export type SessionModel = ClaudeModel | CodexModel;

export const CODEX_EFFORT_OPTIONS = [
  {
    value: "default",
    label: "Default",
    description: "CLI or project default"
  },
  {
    value: "low",
    label: "Low",
    description: "Fastest reasoning"
  },
  {
    value: "medium",
    label: "Medium",
    description: "Balanced reasoning"
  },
  {
    value: "high",
    label: "High",
    description: "Deeper reasoning"
  },
  {
    value: "xhigh",
    label: "XHigh",
    description: "Extra high reasoning"
  }
] as const;

export const CLAUDE_EFFORT_OPTIONS = [
  ...CODEX_EFFORT_OPTIONS,
  {
    value: "max",
    label: "Max",
    description: "Maximum reasoning"
  },
  {
    value: "ultracode",
    label: "Ultracode",
    description: "Claude Code dynamic workflows with xhigh reasoning"
  }
] as const;

export const SESSION_EFFORT_OPTIONS = CLAUDE_EFFORT_OPTIONS;

export type SessionEffort = typeof SESSION_EFFORT_OPTIONS[number]["value"];

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
  model?: SessionModel;
  effort?: SessionEffort;
  cwd: string;
  terminalBackend: "node-pty";
  pid?: number;
  logPath?: string;
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
  roles: Partial<Record<RoleName, RoleSessionPointer>>;
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
  model?: SessionModel;
  effort?: SessionEffort;
}
