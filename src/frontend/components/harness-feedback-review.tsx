import { useState } from "react";
import type { HarnessFeedbackStateReport } from "../../shared/types/harness.js";

export interface HarnessFeedbackReviewProps {
  busy?: boolean;
  state: HarnessFeedbackStateReport | null;
  onApprove(comment: string): void;
  onCancel(comment: string): void;
  onComment(comment: string): void;
  onReject(comment: string): void;
}

export function HarnessFeedbackReview({
  busy,
  state,
  onApprove,
  onCancel,
  onComment,
  onReject
}: HarnessFeedbackReviewProps) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [dismissedNoticeKey, setDismissedNoticeKey] = useState<string | null>(null);
  if (!state || state.status === "idle") {
    return null;
  }

  const active = state.active;
  const noticeKey = getHarnessFeedbackNoticeKey(state);
  if (dismissedNoticeKey === noticeKey) {
    return null;
  }

  const needsReview = state.status === "awaiting_user_approval";
  const title = active?.title ?? state.pending[0]?.title ?? "Harness feedback";
  const label = active?.source === "task-retrospective" ? "Task Harness Review" : "Harness Feedback";
  const closeFloat = () => {
    setOpen(false);
    setDismissedNoticeKey(noticeKey);
  };

  return (
    <>
      <section className={needsReview ? "harness-feedback-float needs-review" : "harness-feedback-float"}>
        <div>
          <strong>{needsReview ? `${label} needed` : label}</strong>
          <span>{formatHarnessFeedbackStatus(state)}</span>
        </div>
        <p title={title}>{title}</p>
        <div className="harness-feedback-float-actions">
          <button type="button" disabled={busy} onClick={closeFloat}>Close</button>
          <button type="button" disabled={busy || !active} onClick={() => setOpen(true)}>
            {needsReview ? "Review" : "Open"}
          </button>
        </div>
      </section>

      {open && active ? (
        <div className="modal-backdrop harness-feedback-backdrop">
          <section className="harness-feedback-modal" role="dialog" aria-modal="true" aria-label="Harness feedback review">
            <header>
              <div>
                <h2>{label}</h2>
                <p className="muted">{state.status.replaceAll("_", " ")} · queued {state.queuedCount}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)}>Close</button>
            </header>

            <div className="harness-feedback-modal-body">
              <section>
                <h3>{active.source === "task-retrospective" ? "Task Retrospective Request" : "Feedback"}</h3>
                <pre>{active.feedbackContent || "No feedback content found."}</pre>
              </section>
              <section>
                <h3>Harness Engineer Analysis</h3>
                <pre>{active.analysisContent || "Analysis is not available yet."}</pre>
              </section>
            </div>

            {needsReview ? (
              <footer className="harness-feedback-review-actions">
                <textarea
                  value={comment}
                  placeholder="Optional note for Harness Engineer..."
                  onChange={(event) => setComment(event.target.value)}
                />
                <div>
                  <button type="button" disabled={busy} onClick={() => onComment(comment)}>
                    Send Feedback
                  </button>
                  <button type="button" disabled={busy} onClick={() => onReject(comment)}>
                    Reject
                  </button>
                  <button type="button" disabled={busy} onClick={() => onApprove(comment)}>
                    Approve
                  </button>
                </div>
              </footer>
            ) : active ? (
              <footer className="harness-feedback-review-actions">
                <textarea
                  value={comment}
                  placeholder="Optional cancellation note..."
                  onChange={(event) => setComment(event.target.value)}
                />
                <div>
                  <button type="button" disabled={busy} onClick={() => onCancel(comment)}>
                    Cancel
                  </button>
                </div>
              </footer>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}

function getHarnessFeedbackNoticeKey(state: HarnessFeedbackStateReport): string {
  if (state.active) {
    return [
      "active",
      state.status,
      state.active.id,
      state.active.path,
      state.active.updatedAt ?? "",
      state.active.analysisPath ?? "",
      state.active.applyReportPath ?? ""
    ].join(":");
  }
  const pending = state.pending[0];
  if (pending) {
    return ["pending", state.status, pending.id, pending.path, state.queuedCount].join(":");
  }
  return [state.status, state.queuedCount].join(":");
}

function formatHarnessFeedbackStatus(state: HarnessFeedbackStateReport): string {
  if (state.status === "queued") {
    return `${state.queuedCount} queued`;
  }
  if (state.status === "awaiting_user_approval") {
    return "waiting for approval";
  }
  if (state.status === "analyzing") {
    return "Harness Engineer analyzing";
  }
  if (state.status === "applying") {
    return "Harness Engineer applying";
  }
  return state.status;
}
