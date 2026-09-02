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
    description: "Account default",
    source: "claude",
    available: true
  },
  {
    value: "claude-fable-5-1",
    label: "Fable 5.1",
    description: "Pinned Claude Fable 5.1",
    source: "claude",
    available: true
  },
  {
    value: "fable",
    label: "Fable Alias",
    description: "Claude Code provider-selected Fable",
    source: "claude",
    available: true
  },
  {
    value: "opus",
    label: "Opus",
    description: "Latest Opus",
    source: "claude",
    available: true
  },
  {
    value: "claude-opus-4-8",
    label: "Opus 4.8",
    description: "Pinned Claude Opus 4.8",
    source: "claude",
    available: true
  },
  {
    value: "sonnet",
    label: "Sonnet",
    description: "Latest Sonnet",
    source: "claude",
    available: true
  }
] as const;

export type ClaudeModel = typeof CLAUDE_MODEL_OPTIONS[number]["value"];

export const CODEX_BRIDGE_LOCAL_BASE_URL = "http://127.0.0.1:3456" as const;
export const CODEX_BRIDGE_CONTAINER_BASE_URL = "http://host.docker.internal:3456" as const;
export const CODEX_BRIDGE_BASE_URL = CODEX_BRIDGE_CONTAINER_BASE_URL;
export const CODEX_BRIDGE_BASE_URLS = [
  CODEX_BRIDGE_LOCAL_BASE_URL,
  CODEX_BRIDGE_CONTAINER_BASE_URL
] as const;
export const CODEX_BRIDGE_EFFECTIVE_CONTEXT_TOKENS = 258_400;
export const CODEX_BRIDGE_AUTO_COMPACT_WINDOW_TOKENS = CODEX_BRIDGE_EFFECTIVE_CONTEXT_TOKENS;
export const CODEX_BRIDGE_AUTO_COMPACT_PERCENT = 90;
export type CodexBridgeSessionModel = `codex-bridge:${string}`;

export type SessionModel = ClaudeModel | CodexBridgeSessionModel;

export interface CodexBridgeModelDescriptor {
  id: string;
  displayName?: string;
}

export interface SessionModelOption {
  value: SessionModel;
  label: string;
  description: string;
  source: "claude" | "codex-bridge";
  available: boolean;
  unavailableReason?: string;
}

export function isCodexBridgeSessionModel(model: unknown): model is CodexBridgeSessionModel {
  return typeof model === "string"
    && model.startsWith("codex-bridge:")
    && model.length > "codex-bridge:".length;
}

export function toCodexBridgeSessionModel(modelId: string): CodexBridgeSessionModel {
  return `codex-bridge:${modelId}`;
}

export function getCodexBridgeModelId(model: CodexBridgeSessionModel): string {
  return model.slice("codex-bridge:".length);
}

export function createSessionModelOptions(
  codexBridgeModels: readonly CodexBridgeModelDescriptor[] = [],
  unavailableReason?: string
): SessionModelOption[] {
  return [
    ...CLAUDE_MODEL_OPTIONS,
    ...codexBridgeModels.map((model) => ({
      value: toCodexBridgeSessionModel(model.id),
      label: `${model.displayName ?? model.id} (Codex Bridge)`,
      description: `${model.id} through the host Codex Bridge`,
      source: "codex-bridge" as const,
      available: unavailableReason === undefined,
      ...(unavailableReason === undefined ? {} : { unavailableReason })
    }))
  ];
}

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
  runtimeSessionToken?: string;
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
  claudeConfigDir?: string;
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
  expectedRuntimeExitReason?: "role-stall-recovery";
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
  appendSystemPrompt?: string;
}
