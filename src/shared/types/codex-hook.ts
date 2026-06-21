import type { CodexRoleName } from "./role.js";
import type { ClaudeTurnHookEventName } from "./claude-hook.js";

export interface CodexHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  turn_id?: string;
  model?: string;
  permission_mode?: string;
  prompt?: string;
  last_assistant_message?: string | null;
  [key: string]: unknown;
}

export interface CodexHookRequest {
  taskSlug: string;
  role: CodexRoleName;
  event: CodexHookPayload;
}

export interface CodexHookResult {
  ok: true;
  eventName: ClaudeTurnHookEventName;
  taskSlug: string;
  role: CodexRoleName;
  sessionUpdated: boolean;
}

export type CodexStopHookResponse = Record<string, never>;
