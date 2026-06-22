import { useEffect, useState } from "react";
import type {
  CommitAndRebaseHarnessTaskResult,
  HarnessApplyResult,
  HarnessBootstrapStatusReport,
  HarnessStatusReport
} from "../../shared/types/harness.js";
import {
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  type ClaudePermissionMode,
  type RoleSessionRecord,
  type SessionEffort,
  type SessionModel
} from "../../shared/types/session.js";
import { XtermView } from "../terminal/xterm-view.js";
import { StatusBadge } from "./status-badge.js";

type BootstrapLaunchOptions = {
  permissionMode: ClaudePermissionMode;
  model: SessionModel;
  effort: SessionEffort;
};

export interface HarnessPanelProps {
  status: HarnessStatusReport | null;
  bootstrapStatus: HarnessBootstrapStatusReport | null;
  applyResult?: HarnessApplyResult | null;
  taskSyncResult?: CommitAndRebaseHarnessTaskResult | null;
  harnessEngineerSession?: RoleSessionRecord | null;
  canCommitAndRebaseTask?: boolean;
  busy?: boolean;
  onRefresh(): Promise<void>;
  onApply(): Promise<void>;
  onCommitAndRebaseTask(): Promise<void>;
  onOpenStudio(): void;
  onStartBootstrap(input: BootstrapLaunchOptions): Promise<void>;
  onRestartBootstrap(input: BootstrapLaunchOptions): Promise<void>;
  onStopBootstrap(): Promise<void>;
  onRunBootstrap(): Promise<void>;
}

export function HarnessPanel({
  status,
  bootstrapStatus,
  applyResult,
  taskSyncResult,
  harnessEngineerSession,
  canCommitAndRebaseTask = false,
  busy = false,
  onRefresh,
  onApply,
  onCommitAndRebaseTask,
  onOpenStudio,
  onStartBootstrap,
  onRestartBootstrap,
  onStopBootstrap,
  onRunBootstrap
}: HarnessPanelProps) {
  const [showBootstrapTerminal, setShowBootstrapTerminal] = useState(false);
  const [bootstrapPermissionMode, setBootstrapPermissionMode] = useState<ClaudePermissionMode>("default");
  const [bootstrapModel, setBootstrapModel] = useState<SessionModel>("default");
  const [bootstrapEffort, setBootstrapEffort] = useState<SessionEffort>("default");
  const bootstrapSession = bootstrapStatus?.session;
  const bootstrapRunning = bootstrapStatus?.status === "running";
  const bootstrapSessionRunning = bootstrapSession?.status === "running";

  useEffect(() => {
    if (bootstrapSession?.permissionMode) {
      setBootstrapPermissionMode(bootstrapSession.permissionMode);
    }
    if (bootstrapSession?.model) {
      setBootstrapModel(bootstrapSession.model);
    }
    if (bootstrapSession?.effort) {
      setBootstrapEffort(bootstrapSession.effort);
    }
  }, [bootstrapSession]);

  const bootstrapLaunchOptions = {
    permissionMode: bootstrapPermissionMode,
    model: bootstrapModel,
    effort: bootstrapEffort
  };

  if (!status) {
    return null;
  }

  return (
    <section className="harness-panel">
      {/*
        Fixed install stage — three mutually exclusive states driven by
        status.initialized and status.needsApply (see HarnessStatusReport):

          State A  !status.initialized
            -> No file list. Only an "Initialize" button (calls onApply).
               Header subtitle: "Not initialized".
          State B  status.initialized && status.needsApply
            -> "Files to update" list built from status.plannedChanges
               (path + action via StatusBadge) + "Update" button (calls onApply)
               + "Refresh" button (calls onRefresh).
            Header subtitle: `${status.plannedChanges.length} pending updates`.
          State C  status.initialized && !status.needsApply
            -> No file list, no apply button. "Up to date" indicator +
               "Refresh" button (calls onRefresh).

        Bootstrap keeps a compact status/action row; verbose check details and
        fixed-install output are intentionally kept out of the sidebar.
      */}
      <div className="harness-stage">
        <div className="harness-panel-header">
          <div>
            <strong>Fixed install</strong>
            <p className="muted">
              {!status.initialized
                ? "Not initialized"
                : status.needsApply
                  ? `${status.plannedChanges.length} pending updates`
                  : "Up to date"}
            </p>
          </div>
          <div className="harness-actions">
            {!status.initialized ? (
              <button type="button" disabled={busy} onClick={() => void onApply()}>
                Initialize
              </button>
            ) : (
              <>
                <button type="button" disabled={busy} onClick={() => void onRefresh()}>
                  Refresh
                </button>
                {status.needsApply ? (
                  <button type="button" disabled={busy} onClick={() => void onApply()}>
                    Update
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>

        {status.initialized && status.needsApply ? (
          <>
            <h3 className="harness-file-list-title">Files to update</h3>
            <ol className="harness-file-list">
              {status.plannedChanges.map((change) => (
                <li key={`${change.path}:${change.action}`}>
                  <span>{change.path}</span>
                  <StatusBadge status={change.action} />
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>

      <div className="harness-stage">
        <div className="harness-panel-header">
          <div>
            <strong>Harness Studio</strong>
            <p className="muted">Engineer: {formatHarnessEngineerStatus(harnessEngineerSession)}</p>
          </div>
          <div className="harness-actions">
            <button type="button" disabled={busy} onClick={onOpenStudio}>
              Open Studio
            </button>
          </div>
        </div>
      </div>

      <div className="harness-stage">
        <div className="harness-panel-header">
          <div>
            <strong>Bootstrap</strong>
            <p className="muted">{bootstrapStatus ? formatBootstrapStatus(bootstrapStatus.status) : "not loaded"}</p>
          </div>
          <div className="harness-actions">
            <button
              type="button"
              disabled={busy || !bootstrapStatus?.canStart}
              onClick={() => {
                setShowBootstrapTerminal(true);
              }}
            >
              Open Bootstrap
            </button>
          </div>
        </div>

        {bootstrapSession ? (
          <div className="harness-bootstrap-session">
            <div>
              <span>{bootstrapSession.command}</span>
              <StatusBadge status={bootstrapSession.status} />
            </div>
            <button
              type="button"
              onClick={() => setShowBootstrapTerminal(true)}
            >
              Open Terminal
            </button>
          </div>
        ) : null}
      </div>

      {applyResult?.changedFiles.length && canCommitAndRebaseTask && !taskSyncResult ? (
        <div className="harness-result">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onCommitAndRebaseTask()}
          >
            Commit &amp; rebase task
          </button>
        </div>
      ) : null}

      {taskSyncResult ? (
        <div className="harness-result">
          <p className="muted">{taskSyncResult.message}</p>
        </div>
      ) : null}

      {status.warnings.length > 0 ? (
        <ul className="warnings">
          {status.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {bootstrapStatus?.warnings.length ? (
        <ul className="warnings">
          {bootstrapStatus.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {showBootstrapTerminal ? (
        <div className="harness-bootstrap-modal" role="dialog" aria-modal="true" aria-label="Harness Engineer bootstrap session">
          <div className="harness-bootstrap-modal-surface">
            <header className="harness-bootstrap-modal-header">
              <div>
                <strong>Harness Engineer Bootstrap</strong>
                <p className="muted">{bootstrapSession?.command ?? "Start Harness Engineer, then run bootstrap when ready."}</p>
              </div>
              <div className="harness-bootstrap-modal-actions">
                {bootstrapSession ? <StatusBadge status={bootstrapSession.status} /> : null}
                <button type="button" onClick={() => setShowBootstrapTerminal(false)}>
                  Close
                </button>
              </div>
            </header>

            <div className="harness-bootstrap-controls">
              <label>
                <span>Permission</span>
                <select
                  value={bootstrapPermissionMode}
                  disabled={busy || bootstrapRunning || bootstrapSessionRunning}
                  onChange={(event) => setBootstrapPermissionMode(event.target.value as ClaudePermissionMode)}
                >
                  <option value="default">默认</option>
                  <option value="bypassPermissions">bypassPermissions</option>
                </select>
              </label>
              <label>
                <span>Model</span>
                <select
                  value={bootstrapModel}
                  disabled={busy || bootstrapRunning || bootstrapSessionRunning}
                  onChange={(event) => setBootstrapModel(event.target.value as SessionModel)}
                >
                  {CLAUDE_MODEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Effort</span>
                <select
                  value={bootstrapEffort}
                  disabled={busy || bootstrapRunning || bootstrapSessionRunning}
                  onChange={(event) => setBootstrapEffort(event.target.value as SessionEffort)}
                >
                  {CLAUDE_EFFORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <div className="harness-bootstrap-control-actions">
                <button
                  type="button"
                  disabled={busy || bootstrapRunning || !bootstrapStatus?.canStart}
                  onClick={() => void onStartBootstrap(bootstrapLaunchOptions)}
                >
                  Start
                </button>
                <button
                  type="button"
                  disabled={busy || bootstrapRunning || !bootstrapStatus?.canStart}
                  onClick={() => void onRestartBootstrap(bootstrapLaunchOptions)}
                >
                  Restart
                </button>
                <button
                  type="button"
                  disabled={busy || !bootstrapSession}
                  onClick={() => void onStopBootstrap()}
                >
                  Stop
                </button>
                <button
                  type="button"
                  disabled={busy || bootstrapRunning || !bootstrapSessionRunning}
                  onClick={() => void onRunBootstrap()}
                >
                  Run bootstrap
                </button>
              </div>
            </div>

            <div className="harness-bootstrap-terminal">
              {bootstrapSessionRunning ? (
                <XtermView sessionId={bootstrapSession.id} active={showBootstrapTerminal} />
              ) : (
                <div className="terminal-empty">
                  <strong>Harness Bootstrap</strong>
                  <span>Start Harness Engineer first. When it is ready, click Run bootstrap to send the prompt.</span>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function formatBootstrapStatus(status: HarnessBootstrapStatusReport["status"]): string {
  return status.replaceAll("_", " ");
}

function formatHarnessEngineerStatus(session?: RoleSessionRecord | null): string {
  if (!session) {
    return "not started";
  }
  return session.status === "running"
    ? `${session.status} / ${session.activityStatus ?? "idle"}`
    : session.status;
}
