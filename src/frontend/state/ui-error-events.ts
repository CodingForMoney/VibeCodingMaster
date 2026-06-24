export interface UiErrorReportDetail {
  message: string;
}

export interface UiErrorClearActionsDetail {
  actions: string[];
}

export interface UiErrorClearMessageDetail {
  message: string;
}

export const UI_ERROR_REPORT_EVENT = "vcm:ui-error-report";
export const UI_ERROR_CLEAR_ACTIONS_EVENT = "vcm:ui-error-clear-actions";
export const UI_ERROR_CLEAR_MESSAGE_EVENT = "vcm:ui-error-clear-message";

export function reportUiError(message: string): void {
  const normalized = message.trim();
  if (!normalized || typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<UiErrorReportDetail>(UI_ERROR_REPORT_EVENT, {
    detail: { message: normalized }
  }));
}

export function clearUiErrorMessage(message: string): void {
  const normalized = message.trim();
  if (!normalized || typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<UiErrorClearMessageDetail>(UI_ERROR_CLEAR_MESSAGE_EVENT, {
    detail: { message: normalized }
  }));
}

export function clearReportedUiErrorsForActions(actions: string[]): void {
  if (actions.length === 0 || typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<UiErrorClearActionsDetail>(UI_ERROR_CLEAR_ACTIONS_EVENT, {
    detail: { actions }
  }));
}
