import { open, readFile } from "node:fs/promises";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import { parseAssistantContent, resolveExistingClaudeTranscriptPath } from "./claude-transcript-service.js";

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

/** A single assistant text event read from a Claude transcript. */
export interface TranscriptTextEvent {
  id: string;
  timestamp: string;
  text: string;
  stopReason?: string;
  isSidechain?: boolean;
}

export interface TranscriptTurnEvidence {
  completion?: {
    id: string | null;
    timestamp: string;
  };
}

/** Default maximum captured-reply length (characters). */
export const MAX_TURN_REPLY_CHARS = 8_000;

/** Tolerance applied when matching transcript events to the role's last-turn window. */
const TURN_WINDOW_TOLERANCE_MS = 1_000;
const TRANSCRIPT_EVIDENCE_TAIL_BYTES = 2 * 1024 * 1024;

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
  const transcriptPath = resolveExistingClaudeTranscriptPath(session);
  if (!transcriptPath) {
    return undefined;
  }
  let events: TranscriptTextEvent[];
  try {
    events = await readTranscriptTextEvents(transcriptPath);
  } catch {
    return undefined;
  }
  return selectLatestTurnReply(events, session, options?.maxLength ?? MAX_TURN_REPLY_CHARS);
}

/** Read all assistant text events from a transcript file (throws on read failure). */
export async function readTranscriptTextEvents(transcriptPath: string): Promise<TranscriptTextEvent[]> {
  const raw = await readFile(transcriptPath, "utf8");
  const events: TranscriptTextEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    for (const event of parseAssistantContent(line)) {
      if (event.kind === "text") {
        events.push({
          id: event.id,
          timestamp: event.timestamp,
          text: event.text,
          stopReason: event.stopReason,
          ...(event.isSidechain ? { isSidechain: true } : {})
        });
      }
    }
  }
  return events;
}

/** Read transcript activity and a completed assistant turn after this turn began. */
export async function readTranscriptTurnEvidence(session: RoleSessionRecord): Promise<TranscriptTurnEvidence> {
  const transcriptPath = resolveExistingClaudeTranscriptPath(session);
  if (!transcriptPath) {
    return {};
  }

  let raw: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(transcriptPath, "r");
    const metadata = await handle.stat();
    const readLength = Math.min(metadata.size, TRANSCRIPT_EVIDENCE_TAIL_BYTES);
    const readOffset = Math.max(0, metadata.size - readLength);
    const buffer = Buffer.alloc(readLength);
    await handle.read(buffer, 0, readLength, readOffset);
    raw = buffer.toString("utf8");
    if (readOffset > 0) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
    }
  } catch {
    return {};
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const turnStartedAtMs = timestampMs(session.lastTurnStartedAt);
  let completion: TranscriptTurnEvidence["completion"];

  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    if (record.type !== "assistant" || record.isSidechain === true || !timestamp) {
      continue;
    }

    const message = record.message as Record<string, unknown> | undefined;
    if (message?.model === "<synthetic>" || message?.stop_reason !== "end_turn") {
      continue;
    }
    const completionAtMs = timestampMs(timestamp);
    if (
      completionAtMs === undefined
      || (turnStartedAtMs !== undefined && completionAtMs < turnStartedAtMs - TURN_WINDOW_TOLERANCE_MS)
    ) {
      continue;
    }
    if (!completion || isLaterTimestamp(timestamp, completion.timestamp)) {
      completion = {
        id: typeof record.uuid === "string" ? record.uuid : null,
        timestamp
      };
    }
  }

  return completion ? { completion } : {};
}

/** True for a text event that completed a turn (assistant stopped of its own accord). */
export function isFinalTurnTextEvent(event: TranscriptTextEvent): boolean {
  return event.stopReason === "end_turn";
}

/**
 * Select the role's last completed user-facing reply from its transcript events,
 * scoped to the session's last-turn window, joined and truncated. Returns
 * `undefined` when no end_turn text falls in the window or the text is empty.
 */
export function selectLatestTurnReply(
  events: TranscriptTextEvent[],
  session: RoleSessionRecord,
  maxLength: number = MAX_TURN_REPLY_CHARS
): ClaudeTurnReply | undefined {
  if (events.length === 0) {
    return undefined;
  }

  const startMs = timestampMs(session.lastTurnStartedAt);
  const endMs = timestampMs(session.lastTurnEndedAt);
  const finalEvents = events.filter((event) => !event.isSidechain && isFinalTurnTextEvent(event));
  const selected = startMs === undefined
    ? finalEvents.slice(-1)
    : finalEvents.filter((event) => {
        const eventMs = timestampMs(event.timestamp);
        return eventMs !== undefined
          && eventMs >= startMs - TURN_WINDOW_TOLERANCE_MS
          && (endMs === undefined || eventMs <= endMs + TURN_WINDOW_TOLERANCE_MS);
      });
  if (selected.length === 0) {
    return undefined;
  }

  const text = selected.map((event) => event.text).join("\n\n").trim();
  if (!text) {
    return undefined;
  }

  const limited = limitTranscriptReply(text, maxLength);
  const lastEvent = selected.at(-1);
  return {
    transcriptEventId: lastEvent?.id ?? null,
    transcriptTimestamp: lastEvent?.timestamp ?? null,
    text: limited.text,
    truncated: limited.truncated
  };
}

/** Truncate reply text to `maxLength`, reporting whether truncation occurred. */
export function limitTranscriptReply(text: string, maxLength: number = MAX_TURN_REPLY_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, maxLength).trimEnd(),
    truncated: true
  };
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isLaterTimestamp(candidate: string, current: string | undefined): boolean {
  const candidateMs = timestampMs(candidate);
  const currentMs = timestampMs(current);
  return candidateMs !== undefined && (currentMs === undefined || candidateMs > currentMs);
}
