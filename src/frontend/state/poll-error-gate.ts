import { formatUiError, errorReason } from "./error-format.js";
import { clearReportedUiErrorsForActions } from "./ui-error-events.js";

interface PollErrorState {
  consecutiveFailures: number;
  lastMessage: string;
  lastReportedAt: number;
}

const REACHABILITY_REPORT_THRESHOLD = 3;
const REACHABILITY_REPEAT_REPORT_MS = 30000;
const pollErrors = new Map<string, PollErrorState>();

export function recordPollError(action: string, error: unknown): string | null {
  const message = formatUiError(action, error);
  if (!isBackendReachabilityError(error)) {
    pollErrors.set(action, {
      consecutiveFailures: 1,
      lastMessage: message,
      lastReportedAt: Date.now()
    });
    return message;
  }

  const previous = pollErrors.get(action);
  const nextFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const now = Date.now();
  const shouldReport = nextFailures >= REACHABILITY_REPORT_THRESHOLD && (
    !previous ||
    previous.lastMessage !== message ||
    now - previous.lastReportedAt >= REACHABILITY_REPEAT_REPORT_MS
  );

  pollErrors.set(action, {
    consecutiveFailures: nextFailures,
    lastMessage: message,
    lastReportedAt: shouldReport ? now : previous?.lastReportedAt ?? 0
  });

  return shouldReport ? message : null;
}

export function clearPollError(action: string): void {
  pollErrors.delete(action);
  clearReportedUiErrorsForActions([action]);
}

function isBackendReachabilityError(error: unknown): boolean {
  const reason = errorReason(error);
  return (
    reason.includes("could not reach the VCM backend") ||
    reason.includes("Failed to fetch") ||
    reason.includes("NetworkError") ||
    reason.includes("Load failed") ||
    reason.includes("ERR_CONNECTION")
  );
}
