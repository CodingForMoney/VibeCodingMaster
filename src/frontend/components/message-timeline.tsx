import { useState } from "react";
import type { VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import { SwitchControl } from "./switch-control.js";

export interface MessageTimelineProps {
  messages: VcmRoleMessage[];
  orchestration?: VcmOrchestrationState | null;
  busy?: boolean;
  maxMessages?: number | null;
  showControls?: boolean;
  showHeader?: boolean;
  onModeChange?(mode: VcmOrchestrationState["mode"]): void;
  onMarkAllDone?(): void;
}

export function getMessageCounts(messages: VcmRoleMessage[]) {
  return {
    total: messages.length,
    accepted: messages.filter((message) => message.acceptedAt).length,
    delivered: messages.filter((message) => message.deliveredAt).length
  };
}

export interface MessageTimelineRecord {
  message: VcmRoleMessage;
  sequence: number;
}

export function getVisibleMessageRecords(
  messages: VcmRoleMessage[],
  maxMessages: number | null = 6
): MessageTimelineRecord[] {
  const chronological = [...messages]
    .sort(compareMessageTimelineTimeAscending)
    .map((message, index) => ({
      message,
      sequence: index + 1
    }));
  const visible = maxMessages === null
    ? chronological
    : chronological.slice(-maxMessages);
  return [...visible].sort((left, right) => right.sequence - left.sequence);
}

export function MessageTimeline({
  messages,
  orchestration,
  busy,
  maxMessages = 6,
  showControls = true,
  showHeader = true,
  onModeChange,
  onMarkAllDone
}: MessageTimelineProps) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const counts = getMessageCounts(messages);
  const mode = orchestration?.mode ?? "auto";
  const visibleRecords = getVisibleMessageRecords(messages, maxMessages);

  async function copyMessage(message: VcmRoleMessage) {
    await writeClipboardText(message.body);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1200);
  }

  return (
    <section className="message-panel">
      {showHeader ? (
        <div className="message-panel-header">
          <div>
            <h2>Messages</h2>
            <p className="muted">
              {counts.total} total / {counts.accepted} accepted
            </p>
          </div>
          {showControls && onModeChange ? (
            <div className="message-controls">
              <SwitchControl
                checked={mode === "auto"}
                className="message-mode-toggle"
                disabled={busy}
                label="Auto orchestration"
                onChange={(checked) => onModeChange(checked ? "auto" : "manual")}
              />
            </div>
          ) : null}
          {showControls && onMarkAllDone ? (
            <button type="button" disabled={busy} onClick={onMarkAllDone}>
              Mark All Done
            </button>
          ) : null}
        </div>
      ) : null}

      {messages.length === 0 ? (
        <p className="muted">No role messages yet.</p>
      ) : (
        <ol className="message-list">
          {visibleRecords.map(({ message, sequence }) => {
            return (
              <li className="message-item" key={message.id}>
                <div className="message-item-main">
                  <div className="message-meta">
                    <span className="message-sequence">#{sequence}</span>
                    <time dateTime={getMessageSortTime(message)}>{formatMessageTimestamp(getMessageSortTime(message))}</time>
                    <strong>{message.fromRole} {"->"} {message.toRole}</strong>
                    <span>{message.type}</span>
                  </div>
                  <p>{message.body}</p>
                  {message.failureReason ? <span className="message-reason">{message.failureReason}</span> : null}
                  {message.bodyPath ? <span className="message-path">{message.bodyPath}</span> : null}
                </div>
                <div className="message-actions">
                  <button type="button" disabled={busy} onClick={() => void copyMessage(message)}>
                    {copiedMessageId === message.id ? "Copied" : "Copy"}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function formatMessageTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function getMessageSortTime(message: VcmRoleMessage): string {
  return message.acceptedAt
    ?? message.deliveredAt
    ?? message.dispatchingAt
    ?? message.createdAt;
}

function compareMessageTimelineTimeAscending(left: VcmRoleMessage, right: VcmRoleMessage): number {
  const time = getMessageSortTime(left).localeCompare(getMessageSortTime(right));
  if (time !== 0) {
    return time;
  }
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) {
    return created;
  }
  return left.id.localeCompare(right.id);
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}
