export function errorReason(error: unknown, fallback = "Unknown error."): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error === undefined) {
    return fallback;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function formatUiError(action: string, error: unknown, fallback?: string): string {
  return `${action} failed. Reason: ${errorReason(error, fallback)}`;
}

export function clearUiErrorForActions(current: string, actions: string[]): string {
  return actions.some((action) => current.startsWith(`${action} failed.`)) ? "" : current;
}
