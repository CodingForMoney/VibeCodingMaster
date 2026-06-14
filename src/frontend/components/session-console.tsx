import type { VcmOrchestrationMode } from "../../shared/types/message.js";
import type { RoleName } from "../../shared/types/role.js";
import type { ClaudePermissionMode, RoleSessionRecord, SessionEffort, SessionModel } from "../../shared/types/session.js";
import { XtermView } from "../terminal/xterm-view.js";
import { SessionToolbar } from "./session-toolbar.js";
import { TranslationPanel } from "./translation-panel.js";

export interface SessionConsoleProps {
  role: RoleName;
  session?: RoleSessionRecord;
  permissionMode: ClaudePermissionMode;
  model: SessionModel;
  effort: SessionEffort;
  active?: boolean;
  busy?: boolean;
  orchestrationMode: VcmOrchestrationMode;
  translationEnabled: boolean;
  onPermissionModeChange(mode: ClaudePermissionMode): void;
  onModelChange(model: SessionModel): void;
  onEffortChange(effort: SessionEffort): void;
  onOrchestrationModeChange(mode: VcmOrchestrationMode): void;
  onStart(): void;
  onResume(): void;
  onStop(): void;
  onRestart(): void;
  onTerminalEvent(message: string): void;
}

export function SessionConsole({
  role,
  session,
  permissionMode,
  model,
  effort,
  active = true,
  busy,
  orchestrationMode,
  translationEnabled,
  onPermissionModeChange,
  onModelChange,
  onEffortChange,
  onOrchestrationModeChange,
  onStart,
  onResume,
  onStop,
  onRestart,
  onTerminalEvent
}: SessionConsoleProps) {
  const autoOrchestrationEnabled = orchestrationMode === "auto";
  const isCodexReviewer = role === "codex-reviewer";

  return (
    <section className="session-console">
      <div className="session-console-top">
        <SessionToolbar
          role={role}
          session={session}
          permissionMode={permissionMode}
          model={model}
          effort={effort}
          busy={busy}
          onPermissionModeChange={onPermissionModeChange}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          onStart={onStart}
          onResume={onResume}
          onStop={onStop}
          onRestart={onRestart}
        />
        {isCodexReviewer ? null : (
          <div className="session-console-actions">
            <button
              aria-label={`Auto orchestration is ${autoOrchestrationEnabled ? "on" : "off"}`}
              aria-pressed={autoOrchestrationEnabled}
              className={`translation-toggle${autoOrchestrationEnabled ? " is-active" : ""}`}
              disabled={busy}
              type="button"
              onClick={() => onOrchestrationModeChange(autoOrchestrationEnabled ? "manual" : "auto")}
            >
              {autoOrchestrationEnabled ? "✅ Auto orchestration" : "× Auto orchestration"}
            </button>
          </div>
        )}
      </div>
      {session?.status === "running" ? (
        <SessionConsoleBody
          active={active}
          onTerminalEvent={onTerminalEvent}
          role={role}
          session={session}
          taskSlug={session.taskSlug}
          translationEnabled={!isCodexReviewer && translationEnabled}
        />
      ) : (
        <div className="terminal-empty">
          <strong>{role}</strong>
          <span>
            {isCodexReviewer
              ? session?.claudeSessionId
                ? "Resume this role to reconnect the Codex Reviewer terminal."
                : "Start this role to open an embedded Codex Reviewer terminal."
              : session?.claudeSessionId
              ? "Resume this role to reconnect its Claude Code conversation."
              : "Start this role to open an embedded Claude Code terminal."}
          </span>
        </div>
      )}
    </section>
  );
}

function SessionConsoleBody({
  active,
  onTerminalEvent,
  role,
  session,
  taskSlug,
  translationEnabled
}: {
  active: boolean;
  onTerminalEvent(message: string): void;
  role: RoleName;
  session: RoleSessionRecord;
  taskSlug: string;
  translationEnabled: boolean;
}) {
  return (
    <div className={translationEnabled ? "session-console-body has-translation" : "session-console-body"}>
      <div className="terminal-pane">
        <XtermView key={session.id} sessionId={session.id} active={active} onEvent={onTerminalEvent} />
      </div>
      {translationEnabled ? (
        <div className="translation-pane">
          <TranslationPanel key={session.id} active={active} taskSlug={taskSlug} role={role} sessionId={session.id} />
        </div>
      ) : null}
    </div>
  );
}
