import type { RoleName } from "./role.js";

export type ClaudeHookEventName = "UserPromptSubmit" | "Stop";

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
}
