import { isVcmRoleName } from "../../shared/constants.js";
import type { TranslationTargetLanguage } from "../../shared/types/app-settings.js";
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
  translationEnabled: boolean;
  translationAutoSendEnabled: boolean;
  translationTargetLanguage: TranslationTargetLanguage;
  onPermissionModeChange(mode: ClaudePermissionMode): void;
  onModelChange(model: SessionModel): void;
  onEffortChange(effort: SessionEffort): void;
  onStart(): void;
  onResume(): void;
  onStop(): void;
  onRestart(): void;
  onNotifyHarnessUpdated?(): void;
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
  translationEnabled,
  translationAutoSendEnabled,
  translationTargetLanguage,
  onPermissionModeChange,
  onModelChange,
  onEffortChange,
  onStart,
  onResume,
  onStop,
  onRestart,
  onNotifyHarnessUpdated,
  onTerminalEvent
}: SessionConsoleProps) {
  const showTranslation = isVcmRoleName(role) && translationEnabled && session?.status === "running";

  return (
    <section className="session-console">
      <div className={showTranslation ? "session-console-body has-translation" : "session-console-body"}>
        <div className="terminal-pane">
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
            onNotifyHarnessUpdated={onNotifyHarnessUpdated}
          />
          {session?.status === "running" ? (
            <XtermView key={session.id} sessionId={session.id} active={active} onEvent={onTerminalEvent} />
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
        </div>
        {showTranslation ? (
          <div className="translation-pane">
            <TranslationPanel
              key={session.id}
              active={active}
              autoSendEnabled={translationAutoSendEnabled}
              targetLanguage={translationTargetLanguage}
              taskSlug={session.taskSlug}
              role={role}
              sessionId={session.id}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
