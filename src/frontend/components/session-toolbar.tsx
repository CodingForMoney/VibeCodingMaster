import type { RoleName } from "../../shared/types/role.js";
import {
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  SESSION_EFFORT_OPTIONS,
  type ClaudePermissionMode,
  type RoleSessionRecord,
  type SessionEffort,
  type SessionModel
} from "../../shared/types/session.js";

export interface SessionToolbarProps {
  role: RoleName;
  session?: RoleSessionRecord;
  permissionMode: ClaudePermissionMode;
  model: SessionModel;
  effort: SessionEffort;
  busy?: boolean;
  onPermissionModeChange(mode: ClaudePermissionMode): void;
  onModelChange(model: SessionModel): void;
  onEffortChange(effort: SessionEffort): void;
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
  effort,
  busy = false,
  onPermissionModeChange,
  onModelChange,
  onEffortChange,
  onStart,
  onResume,
  onStop,
  onRestart
}: SessionToolbarProps) {
  const isRunning = session?.status === "running";
  const canResume = Boolean(session?.claudeSessionId && !isRunning);
  const canStart = !isRunning && !session?.claudeSessionId;
  const isCodexReviewer = role === "codex-reviewer";
  const modeWillChange = Boolean(session && session.permissionMode !== permissionMode);
  const sessionModel = session?.model ?? "default";
  const modelWillChange = Boolean(session && sessionModel !== model);
  const sessionEffort = session?.effort ?? "default";
  const effortWillChange = Boolean(session && sessionEffort !== effort);
  const modelOptions = isCodexReviewer ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;

  return (
    <div className="session-controls">
      {isCodexReviewer ? null : (
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
      )}

      <label className="session-option-field model-field">
        <span>
          Model
          <small>
            {session
              ? `current: ${formatSessionModel(sessionModel, isCodexReviewer)}${modelWillChange ? " / next launch" : ""}`
              : "applies on start"}
          </small>
        </span>
        <select
          value={model}
          onChange={(event) => onModelChange(event.target.value as SessionModel)}
        >
          {modelOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="session-option-field effort-field">
        <span>
          Effort
          <small>
            {session
              ? `current: ${formatSessionEffort(sessionEffort)}${effortWillChange ? " / next launch" : ""}`
              : "applies on start"}
          </small>
        </span>
        <select
          value={effort}
          onChange={(event) => onEffortChange(event.target.value as SessionEffort)}
        >
          {SESSION_EFFORT_OPTIONS.map((option) => (
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

function formatSessionModel(model: SessionModel, isCodexReviewer: boolean): string {
  if (isCodexReviewer) {
    return CODEX_MODEL_OPTIONS.find((option) => option.value === model)?.label ?? model;
  }
  return CLAUDE_MODEL_OPTIONS.find((option) => option.value === model)?.label ?? model;
}

function formatSessionEffort(effort: SessionEffort): string {
  return SESSION_EFFORT_OPTIONS.find((option) => option.value === effort)?.label ?? effort;
}
