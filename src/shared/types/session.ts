import type { RoleName, RoleStatus } from "./role.js";

export type RoleActivityStatus = "idle" | "running";

export type ClaudePermissionMode =
  | "default"
  | "plan"
  | "bypassPermissions";

export const CLAUDE_PERMISSION_MODE_OPTIONS = [
  {
    value: "bypassPermissions",
    label: "bypassPermissions",
    description: "Bypass prompts; recommended in DevContainer worktrees"
  },
  {
    value: "plan",
    label: "plan",
    description: "Plan-only permission mode"
  },
  {
    value: "default",
    label: "default",
    description: "Claude Code default permission behavior"
  }
] as const satisfies ReadonlyArray<{
  value: ClaudePermissionMode;
  label: string;
  description: string;
}>;

export const CLAUDE_MODEL_OPTIONS = [
  {
    value: "default",
    label: "Default",
    description: "Account default"
  },
  {
    value: "opus[1m]",
    label: "Opus 1M",
    description: "Force 1M context"
  },
  {
    value: "sonnet[1m]",
    label: "Sonnet 1M",
    description: "Force 1M context"
  },
  {
    value: "fable",
    label: "Fable",
    description: "Claude Fable"
  },
  {
    value: "opus",
    label: "Opus",
    description: "Latest Opus"
  },
  {
    value: "sonnet",
    label: "Sonnet",
    description: "Latest Sonnet"
  }
] as const;

export type ClaudeModel = typeof CLAUDE_MODEL_OPTIONS[number]["value"];

export type SessionModel = ClaudeModel;

const BASE_EFFORT_OPTIONS = [
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
  ...BASE_EFFORT_OPTIONS,
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
  previousCwd?: string;
  terminalBackend: "node-pty";
  pid?: number;
  roleCommandPath?: string;
  handoffArtifactPath?: string;
  startedAt?: string;
  updatedAt: string;
  lastOutputAt?: string;
  lastTurnStartedAt?: string;
  lastTurnEndedAt?: string;
  lastHookEventAt?: string;
  lastCompactAt?: string;
  harnessRevision?: number;
  harnessCurrentRevision?: number;
  harnessOutdated?: boolean;
  lastHarnessNotifyAt?: string;
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
  taskSlug?: string;
  cols?: number;
  rows?: number;
  permissionMode?: ClaudePermissionMode;
  model?: SessionModel;
  effort?: SessionEffort;
}
