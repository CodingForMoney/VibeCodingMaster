import type { RoleSessionRecord } from "../../shared/types/session.js";

/**
 * A role's most recent completed (end_turn) user-facing reply, extracted from its
 * Claude transcript. Reusable by both the gateway push path and the await-user
 * web surface so transcript-reply extraction has a single source of truth.
 */
export interface ClaudeTurnReply {
  text: string;
  truncated: boolean;
  transcriptEventId: string | null;
  transcriptTimestamp: string | null;
}

/** Default maximum captured-reply length (characters). */
export const MAX_TURN_REPLY_CHARS = 8_000;

/**
 * Best-effort read of a role's latest user-facing turn reply.
 *
 * Resolves the session's transcript, selects the `end_turn` text emitted within
 * the session's last-turn window (`lastTurnStartedAt`..`lastTurnEndedAt`), and
 * truncates to `options.maxLength` (default `MAX_TURN_REPLY_CHARS`). Returns
 * `undefined` when no transcript or no usable text is available — callers must
 * treat a missing reply as non-fatal.
 */
export async function readLatestRoleTurnReply(
  session: RoleSessionRecord,
  options?: { maxLength?: number }
): Promise<ClaudeTurnReply | undefined> {
  // VCM:CODE SCF-102: relocate the gateway transcript-reply extraction here
  // (resolveExistingClaudeTranscriptPath -> read text events -> select the last
  // end_turn reply in the session's last-turn window -> truncate at
  // options?.maxLength ?? MAX_TURN_REPLY_CHARS). Keep it best-effort: return
  // undefined on a missing transcript or empty turn. The gateway (SCF-103) must
  // consume this helper so its push behavior stays identical.
  void session;
  void options;
  return undefined;
}
