import type { RoleName } from "../../shared/types/role.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import { StatusBadge } from "./status-badge.js";

export interface MessageTimelineProps {
  messages: VcmRoleMessage[];
  orchestration?: VcmOrchestrationState | null;
  busy?: boolean;
  maxMessages?: number | null;
  showControls?: boolean;
  showHeader?: boolean;
  onModeChange?(mode: VcmOrchestrationState["mode"]): void;
  onPausedChange?(paused: boolean): void;
  onStage(message: VcmRoleMessage): void;
  onReject(message: VcmRoleMessage): void;
  onOpenRole(role: RoleName): void;
}

export function getMessageCounts(messages: VcmRoleMessage[]) {
  return {
    pending: messages.filter((message) => message.status === "pending_approval").length,
    queued: messages.filter((message) => message.status === "queued").length,
    delivered: messages.filter((message) => message.status === "delivered" || message.status === "staged").length
  };
}

export function MessageTimeline({
  messages,
  orchestration,
  busy,
  maxMessages = 6,
  showControls = true,
  showHeader = true,
  onModeChange,
  onPausedChange,
  onStage,
  onReject,
  onOpenRole
}: MessageTimelineProps) {
  const counts = getMessageCounts(messages);
  const mode = orchestration?.mode ?? "manual";
  const visibleMessages = maxMessages === null ? messages : messages.slice(-maxMessages);

  return (
    <section className="message-panel">
      {showHeader ? (
        <div className="message-panel-header">
          <div>
            <h2>Messages</h2>
            <p className="muted">
              {counts.pending} pending / {counts.queued} queued / {counts.delivered} delivered
            </p>
          </div>
          {showControls && onModeChange && onPausedChange ? (
            <div className="message-controls">
              <label className="message-mode-toggle">
                <input
                  type="checkbox"
                  checked={mode === "auto"}
                  disabled={busy}
                  onChange={(event) => onModeChange(event.target.checked ? "auto" : "manual")}
                />
                <span>Auto orchestration</span>
              </label>
              <button type="button" disabled={busy || mode !== "auto"} onClick={() => onPausedChange(!orchestration?.paused)}>
                {orchestration?.paused ? "Resume" : "Pause"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {messages.length === 0 ? (
        <p className="muted">No role messages yet.</p>
      ) : (
        <ol className="message-list">
          {visibleMessages.map((message) => {
            const canStage = message.status === "pending_approval" || message.status === "queued";
            const canReject = message.status === "pending_approval" || message.status === "queued";
            return (
              <li className={`message-item message-${message.status}`} key={message.id}>
                <div className="message-item-main">
                  <div className="message-meta">
                    <strong>{message.fromRole} {"->"} {message.toRole}</strong>
                    <span>{message.type}</span>
                    <StatusBadge status={message.status} />
                  </div>
                  <p>{message.body}</p>
                  {message.bodyPath ? <span className="message-path">{message.bodyPath}</span> : null}
                </div>
                <div className="message-actions">
                  <button type="button" onClick={() => onOpenRole(message.toRole)}>
                    Open Role
                  </button>
                  <button
                    type="button"
                    disabled={busy || !canStage}
                    onClick={() => onStage(message)}
                  >
                    Stage
                  </button>
                  <button
                    type="button"
                    disabled={busy || !canReject}
                    onClick={() => onReject(message)}
                  >
                    Reject
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
