import type { RoleName } from "./role.js";

export type ClaudeTurnHookEventName = "UserPromptSubmit" | "Stop" | "StopFailure";
export type ClaudeHookEventName = ClaudeTurnHookEventName | "PostCompact" | "CwdChanged";

export interface ClaudeHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  [key: string]: unknown;
}

export interface ClaudeHookRequest {
  taskSlug: string;
  role: RoleName;
  event: ClaudeHookPayload;
}

export interface ClaudeHookResult {
  ok: true;
  eventName: ClaudeHookEventName;
  taskSlug: string;
  role: RoleName;
  sessionUpdated: boolean;
  dispatchedCount: number;
  acceptedMessageId?: string;
  stopDecision?: ClaudeStopHookDecision;
}

export interface ClaudeStopHookDecision {
  behavior: "block";
  reason: string;
}

/**
 * Claude Code Stop hook stdout contract: `{}` allows the stop; a block
 * decision keeps the role turn alive and feeds the reason back to the model.
 */
export type ClaudeStopHookResponse =
  | Record<string, never>
  | { decision: "block"; reason: string };

export interface ClaudePermissionRequestHookResult {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision: {
      behavior: "allow";
    };
  };
}
