import type { RoleName } from "../../shared/types/role.js";
import {
  CLAUDE_MODEL_OPTIONS,
  type ClaudeModel,
  type ClaudePermissionMode,
  type RoleSessionRecord
} from "../../shared/types/session.js";

export interface SessionToolbarProps {
  role: RoleName;
  session?: RoleSessionRecord;
  permissionMode: ClaudePermissionMode;
  model: ClaudeModel;
  busy?: boolean;
  onPermissionModeChange(mode: ClaudePermissionMode): void;
  onModelChange(model: ClaudeModel): void;
  onStart(): void;
  onResume(): void;
  onStop(): void;
  onRestart(): void;
}

export function SessionToolbar({
  role,
  session,
  permissionMode,
  model,
  busy = false,
  onPermissionModeChange,
  onModelChange,
  onStart,
  onResume,
  onStop,
  onRestart
}: SessionToolbarProps) {
  const isRunning = session?.status === "running";
  const canResume = Boolean(session?.claudeSessionId && !isRunning);
  const canStart = !isRunning && !session?.claudeSessionId;
  const modeWillChange = Boolean(session && session.permissionMode !== permissionMode);
  const sessionModel = session?.model ?? "default";
  const modelWillChange = Boolean(session && sessionModel !== model);

  return (
    <div className="session-controls">
      <label className="session-option-field permission-mode-field">
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
        </select>
      </label>

      <label className="session-option-field model-field">
        <span>
          Model
          <small>
            {session
              ? `current: ${formatClaudeModel(sessionModel)}${modelWillChange ? " / next launch" : ""}`
              : "applies on start"}
          </small>
        </span>
        <select
          value={model}
          onChange={(event) => onModelChange(event.target.value as ClaudeModel)}
        >
          {CLAUDE_MODEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
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
  return permissionMode;
}

function formatClaudeModel(model: ClaudeModel): string {
  return CLAUDE_MODEL_OPTIONS.find((option) => option.value === model)?.label ?? model;
}
