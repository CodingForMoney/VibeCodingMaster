import { useEffect, useState } from "react";
import {
  UI_ERROR_CLEAR_ACTIONS_EVENT,
  UI_ERROR_CLEAR_MESSAGE_EVENT,
  UI_ERROR_REPORT_EVENT,
  type UiErrorClearActionsDetail,
  type UiErrorClearMessageDetail,
  type UiErrorReportDetail
} from "../state/ui-error-events.js";

interface UiErrorNotice {
  id: string;
  message: string;
  count: number;
  createdAt: string;
  updatedAt: string;
}

const MAX_ERROR_NOTICES = 8;

export function UiErrorCenter() {
  const [notices, setNotices] = useState<UiErrorNotice[]>([]);

  useEffect(() => {
    const handleReport = (event: Event) => {
      const message = (event as CustomEvent<UiErrorReportDetail>).detail?.message?.trim();
      if (!message) {
        return;
      }
      const timestamp = new Date().toISOString();
      setNotices((current) => {
        const existing = current.find((notice) => notice.message === message);
        if (existing) {
          return [
            {
              ...existing,
              count: existing.count + 1,
              updatedAt: timestamp
            },
            ...current.filter((notice) => notice.id !== existing.id)
          ];
        }

        return [
          {
            id: `ui_error_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            message,
            count: 1,
            createdAt: timestamp,
            updatedAt: timestamp
          },
          ...current
        ].slice(0, MAX_ERROR_NOTICES);
      });
    };

    const handleClearActions = (event: Event) => {
      const actions = (event as CustomEvent<UiErrorClearActionsDetail>).detail?.actions ?? [];
      if (actions.length === 0) {
        return;
      }
      setNotices((current) =>
        current.filter((notice) =>
          !actions.some((action) => notice.message.startsWith(`${action} failed.`))
        )
      );
    };

    const handleClearMessage = (event: Event) => {
      const message = (event as CustomEvent<UiErrorClearMessageDetail>).detail?.message?.trim();
      if (!message) {
        return;
      }
      setNotices((current) => current.filter((notice) => notice.message !== message));
    };

    window.addEventListener(UI_ERROR_REPORT_EVENT, handleReport);
    window.addEventListener(UI_ERROR_CLEAR_ACTIONS_EVENT, handleClearActions);
    window.addEventListener(UI_ERROR_CLEAR_MESSAGE_EVENT, handleClearMessage);
    return () => {
      window.removeEventListener(UI_ERROR_REPORT_EVENT, handleReport);
      window.removeEventListener(UI_ERROR_CLEAR_ACTIONS_EVENT, handleClearActions);
      window.removeEventListener(UI_ERROR_CLEAR_MESSAGE_EVENT, handleClearMessage);
    };
  }, []);

  if (notices.length === 0) {
    return null;
  }

  return (
    <aside className="ui-error-center" role="alert" aria-live="polite" aria-label="Application errors">
      <header className="ui-error-center-header">
        <div>
          <h2>Errors</h2>
          <p>{notices.length} active</p>
        </div>
        <button type="button" onClick={() => setNotices([])}>Clear</button>
      </header>
      <ol className="ui-error-list">
        {notices.map((notice) => (
          <li key={notice.id}>
            <div>
              <p>{notice.message}</p>
              <span>
                {formatNoticeTime(notice.updatedAt)}
                {notice.count > 1 ? ` · repeated ${notice.count} times` : ""}
              </span>
            </div>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => setNotices((current) => current.filter((candidate) => candidate.id !== notice.id))}
            >
              Close
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function formatNoticeTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
