import type { RoleSessionRecord, SessionEffort, SessionModel } from "../../shared/types/session.js";
import { SessionToolbar } from "./session-toolbar.js";
import { XtermView } from "../terminal/xterm-view.js";

export interface CodexTranslatorSessionModalProps {
  busy?: boolean;
  effort: SessionEffort;
  model: SessionModel;
  open: boolean;
  session?: RoleSessionRecord | null;
  onClose(): void;
  onEffortChange(effort: SessionEffort): void;
  onModelChange(model: SessionModel): void;
  onResume(): void;
  onRestart(): void;
  onStart(): void;
  onStop(): void;
}

export function CodexTranslatorSessionModal({
  busy,
  effort,
  model,
  open,
  session,
  onClose,
  onEffortChange,
  onModelChange,
  onResume,
  onRestart,
  onStart,
  onStop
}: CodexTranslatorSessionModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop translator-session-backdrop">
      <section className="translator-session-modal" role="dialog" aria-modal="true" aria-label="Codex Translator Session">
        <header className="translator-session-header">
          <div>
            <h2>Codex Translator Session</h2>
            <p>{formatTranslatorSessionStatus(session)}</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <SessionToolbar
          role="codex-translator"
          session={session ?? undefined}
          permissionMode="default"
          model={model}
          effort={effort}
          busy={busy}
          onPermissionModeChange={() => undefined}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          onStart={onStart}
          onResume={onResume}
          onRestart={onRestart}
          onStop={onStop}
        />

        <div className="translator-session-terminal">
          {session?.status === "running" ? (
            <XtermView key={session.id} sessionId={session.id} active={open} />
          ) : (
            <div className="terminal-empty">
              <strong>codex-translator</strong>
              <span>{session?.claudeSessionId ? "Resume this project translator session." : "Start the project translator session."}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function formatTranslatorSessionStatus(session?: RoleSessionRecord | null): string {
  if (!session) {
    return "not started";
  }
  const activity = session.status === "running" ? ` · ${session.activityStatus ?? "idle"}` : "";
  return `${session.status}${activity}`;
}
