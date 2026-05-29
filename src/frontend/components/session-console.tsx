import type { RoleName } from "../../shared/types/role.js";
import type { ClaudePermissionMode, RoleSessionRecord } from "../../shared/types/session.js";
import { XtermView } from "../terminal/xterm-view.js";
import { SessionToolbar } from "./session-toolbar.js";

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
  return (
    <section className="session-console">
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
      {session?.status === "running" ? (
        <XtermView sessionId={session.id} active={active} onEvent={onTerminalEvent} />
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
