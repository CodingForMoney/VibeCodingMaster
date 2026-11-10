// Claude Code reports a plan usage limit (the session or weekly limit) as an
// ordinary `rate_limit` API error, the same type as short-term throttling.
// Only the rendered message tells them apart, and it carries the reset time:
//   "You've hit your session limit · resets 5:50pm (Asia/Singapore)"
// Retrying before that time cannot succeed, so a usage limit waits for the
// reset instead of following the short-term retry schedule.

export interface UsageLimitFailure {
  error: string;
  errorDetails?: string;
  lastAssistantMessage?: string;
}

export interface UsageLimit {
  // The Claude Code message that reported the limit.
  message: string;
  // When the limit resets, if the message states it.
  resetAt?: string;
}

// A reset further away than this is treated as unparsed; weekly limits reset
// within seven days.
export const MAX_USAGE_LIMIT_RESET_MS = 8 * 24 * 60 * 60 * 1000;

const USAGE_LIMIT_ERRORS = new Set(["rate_limit", "unknown"]);
const USAGE_LIMIT_PATTERNS = [
  /\bhit your\b[^\n]*?\blimit\b/i,
  /\busage limit\b/i,
  /\b(?:session|weekly|daily|monthly)\s+limit\b/i
];
const RESET_PATTERN = /\bresets?\s+(?:at\s+|on\s+)?([^()\n]+?)\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\)/i;
const TIME_PATTERN = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i;
const DATE_PATTERN = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MS = 24 * 60 * 60 * 1000;

export function detectUsageLimit(failure: UsageLimitFailure, now: Date): UsageLimit | undefined {
  if (!USAGE_LIMIT_ERRORS.has(failure.error)) {
    return undefined;
  }
  const message = [failure.lastAssistantMessage, failure.errorDetails]
    .find((text): text is string => Boolean(text) && USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(text!)));
  if (!message) {
    return undefined;
  }
  return { message, resetAt: parseUsageLimitReset(message, now) };
}

// Parses "resets 5:50pm (Asia/Singapore)" or "resets Nov 12, 9am
// (America/Los_Angeles)" into the next matching instant after `now`.
export function parseUsageLimitReset(message: string, now: Date): string | undefined {
  const match = RESET_PATTERN.exec(message);
  if (!match) {
    return undefined;
  }
  const when = match[1]!.trim();
  const timeZone = match[2]!;
  if (!isTimeZone(timeZone)) {
    return undefined;
  }
  const time = TIME_PATTERN.exec(when);
  if (!time) {
    return undefined;
  }
  let hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  const meridiem = time[3]?.toLowerCase();
  if (minute > 59) {
    return undefined;
  }
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return undefined;
    }
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return undefined;
  }

  const today = zonedDate(now, timeZone);
  const date = DATE_PATTERN.exec(when);
  let resetMs: number;
  if (date) {
    const month = MONTHS.indexOf(date[1]!.toLowerCase().slice(0, 3)) + 1;
    const day = Number(date[2]);
    const explicitYear = /\b(20\d{2})\b/.exec(when)?.[1];
    const year = explicitYear ? Number(explicitYear) : today.year;
    resetMs = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
    if (!explicitYear && resetMs < now.getTime() - DAY_MS) {
      resetMs = zonedTimeToUtc(year + 1, month, day, hour, minute, timeZone);
    }
  } else {
    resetMs = zonedTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
    if (resetMs <= now.getTime()) {
      resetMs = zonedTimeToUtc(today.year, today.month, today.day + 1, hour, minute, timeZone);
    }
  }

  if (!Number.isFinite(resetMs) || resetMs - now.getTime() > MAX_USAGE_LIMIT_RESET_MS) {
    return undefined;
  }
  return new Date(resetMs).toISOString();
}

function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function zonedParts(instantMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second")
  };
}

function zonedDate(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = zonedParts(now.getTime(), timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

// The time zone's offset from UTC at an instant, in milliseconds.
function offsetMs(instantMs: number, timeZone: string): number {
  const parts = zonedParts(instantMs, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

// The UTC instant of a wall-clock time in a time zone; the second pass
// corrects for an offset change (daylight saving) between the two guesses.
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = wallClockAsUtc - offsetMs(wallClockAsUtc, timeZone);
  return wallClockAsUtc - offsetMs(first, timeZone);
}
