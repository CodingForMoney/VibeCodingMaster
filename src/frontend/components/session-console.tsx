import { useState } from "react";
import type { RoleName } from "../../shared/types/role.js";
import type { ClaudePermissionMode, RoleSessionRecord } from "../../shared/types/session.js";
import { XtermView } from "../terminal/xterm-view.js";
import { SessionToolbar } from "./session-toolbar.js";
import { TranslationPanel } from "./translation-panel.js";

export interface SessionConsoleProps {
  role: RoleName;
  session?: RoleSessionRecord;
  permissionMode: ClaudePermissionMode;
  active?: boolean;
  busy?: boolean;
  onPermissionModeChange(mode: ClaudePermissionMode): void;
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
  active = true,
  busy,
  onPermissionModeChange,
  onStart,
  onResume,
  onStop,
  onRestart,
  onTerminalEvent
}: SessionConsoleProps) {
  const [translationEnabled, setTranslationEnabled] = useState(false);

  return (
    <section className="session-console">
      <div className="session-console-top">
        <SessionToolbar
          role={role}
          session={session}
          permissionMode={permissionMode}
          busy={busy}
          onPermissionModeChange={onPermissionModeChange}
          onStart={onStart}
          onResume={onResume}
          onStop={onStop}
          onRestart={onRestart}
        />
        <button
          aria-pressed={translationEnabled}
          className={`translation-toggle${translationEnabled ? " is-active" : ""}`}
          type="button"
          onClick={() => setTranslationEnabled((current) => !current)}
        >
          {translationEnabled ? "✅ Translate" : "× Translate"}
        </button>
      </div>
      {session?.status === "running" ? (
        <SessionConsoleBody
          active={active}
          onTerminalEvent={onTerminalEvent}
          role={role}
          session={session}
          taskSlug={session.taskSlug}
          translationEnabled={translationEnabled}
        />
      ) : (
        <div className="terminal-empty">
          <strong>{role}</strong>
          <span>
            {session?.claudeSessionId
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
          <TranslationPanel key={session.id} taskSlug={taskSlug} role={role} sessionId={session.id} />
        </div>
      ) : null}
    </div>
  );
}
