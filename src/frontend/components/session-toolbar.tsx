import type { RoleName } from "../../shared/types/role.js";
import type { ClaudePermissionMode, RoleSessionRecord } from "../../shared/types/session.js";

export interface SessionToolbarProps {
  role: RoleName;
  session?: RoleSessionRecord;
  permissionMode: ClaudePermissionMode;
  busy?: boolean;
  onPermissionModeChange(mode: ClaudePermissionMode): void;
  onStart(): void;
  onResume(): void;
  onStop(): void;
  onRestart(): void;
}

export function SessionToolbar({
  role,
  session,
  permissionMode,
  busy = false,
  onPermissionModeChange,
  onStart,
  onResume,
  onStop,
  onRestart
}: SessionToolbarProps) {
  const isRunning = session?.status === "running";
  const canResume = Boolean(session?.claudeSessionId && !isRunning);
  const canStart = !isRunning && !session?.claudeSessionId;
  const modeWillChange = Boolean(session && session.permissionMode !== permissionMode);

  return (
    <div className="session-controls">
      <label className="permission-mode-field">
        <span>
          Permission
          <small>
            {session
              ? `current: ${formatPermissionMode(session.permissionMode)}${modeWillChange ? " / next launch" : ""}`
              : "applies on start"}
          </small>
        </span>
        <select
          value={permissionMode}
          onChange={(event) => onPermissionModeChange(event.target.value as ClaudePermissionMode)}
        >
          <option value="default">默认</option>
          <option value="bypassPermissions">bypassPermissions</option>
          <option value="dangerously-skip-permissions">--dangerously-skip-permissions</option>
        </select>
      </label>

      <div className="session-toolbar">
        <button type="button" disabled={busy || !canStart} onClick={onStart}>
          Start
        </button>
        <button type="button" disabled={busy || !canResume} onClick={onResume}>
          Resume
        </button>
        <button type="button" disabled={busy || !session} onClick={onRestart}>
          Restart
        </button>
        <button type="button" disabled={busy || !session} onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  );
}

function formatPermissionMode(permissionMode: ClaudePermissionMode): string {
  return permissionMode === "dangerously-skip-permissions"
    ? "--dangerously-skip-permissions"
    : permissionMode;
}
