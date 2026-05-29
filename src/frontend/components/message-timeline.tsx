import type { RoleName } from "../../shared/types/role.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import { StatusBadge } from "./status-badge.js";

export interface MessageTimelineProps {
  messages: VcmRoleMessage[];
  orchestration?: VcmOrchestrationState | null;
  busy?: boolean;
  onModeChange(mode: VcmOrchestrationState["mode"]): void;
  onPausedChange(paused: boolean): void;
  onStage(message: VcmRoleMessage): void;
  onReject(message: VcmRoleMessage): void;
  onOpenRole(role: RoleName): void;
}

export function MessageTimeline({
  messages,
  orchestration,
  busy,
  onModeChange,
  onPausedChange,
  onStage,
  onReject,
  onOpenRole
}: MessageTimelineProps) {
  const pendingCount = messages.filter((message) => message.status === "pending_approval").length;
  const queuedCount = messages.filter((message) => message.status === "queued").length;
  const deliveredCount = messages.filter((message) => message.status === "delivered" || message.status === "staged").length;
  const mode = orchestration?.mode ?? "manual";

  return (
    <section className="message-panel">
      <div className="message-panel-header">
        <div>
          <h2>Messages</h2>
          <p className="muted">
            {pendingCount} pending / {queuedCount} queued / {deliveredCount} delivered
          </p>
        </div>
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
      </div>

      {messages.length === 0 ? (
        <p className="muted">No role messages yet.</p>
      ) : (
        <ol className="message-list">
          {messages.slice(-6).map((message) => {
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
