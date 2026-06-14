import { useEffect, useState } from "react";
import type {
  HarnessApplyResult,
  HarnessBootstrapStatusReport,
  HarnessStatusReport
} from "../../shared/types/harness.js";
import { XtermView } from "../terminal/xterm-view.js";
import { StatusBadge } from "./status-badge.js";

export interface HarnessPanelProps {
  status: HarnessStatusReport | null;
  bootstrapStatus: HarnessBootstrapStatusReport | null;
  applyResult?: HarnessApplyResult | null;
  busy?: boolean;
  onRefresh(): Promise<void>;
  onApply(): Promise<void>;
  onStartBootstrap(): Promise<void>;
}

export function HarnessPanel({
  status,
  bootstrapStatus,
  applyResult,
  busy = false,
  onRefresh,
  onApply,
  onStartBootstrap
}: HarnessPanelProps) {
  const [showBootstrapTerminal, setShowBootstrapTerminal] = useState(false);
  const bootstrapSession = bootstrapStatus?.session;

  useEffect(() => {
    if (!bootstrapSession) {
      setShowBootstrapTerminal(false);
    }
  }, [bootstrapSession]);

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

        Bootstrap stage below and the applyResult/warnings blocks are out of scope.
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
            <strong>Bootstrap</strong>
            <p className="muted">{bootstrapStatus ? formatBootstrapStatus(bootstrapStatus.status) : "not loaded"}</p>
          </div>
          <div className="harness-actions">
            <button
              type="button"
              disabled={busy || !bootstrapStatus?.canStart}
              onClick={() => {
                setShowBootstrapTerminal(true);
                void onStartBootstrap();
              }}
            >
              Run Bootstrap
            </button>
          </div>
        </div>

        {bootstrapStatus ? (
          <>
            <ol className="harness-file-list">
              {bootstrapStatus.checks.map((check) => (
                <li key={check.key} title={check.detail ?? check.path ?? ""}>
                  <span>{check.path ? `${check.label}: ${check.path}` : check.label}</span>
                  <StatusBadge status={check.status} />
                </li>
              ))}
            </ol>

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
          </>
        ) : (
          <p className="muted">Refresh harness status to load bootstrap checks.</p>
        )}
      </div>

      {applyResult ? (
        <div className="harness-result">
          <p>{applyResult.message}</p>
          {applyResult.changedFiles.length > 0 ? (
            <ul>
              {applyResult.changedFiles.map((change) => (
                <li key={`${change.path}:${change.action}`}>
                  <strong>{change.action}</strong> {change.path}
                </li>
              ))}
            </ul>
          ) : null}
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

      {showBootstrapTerminal && bootstrapSession ? (
        <div className="harness-bootstrap-modal" role="dialog" aria-modal="true" aria-label="Harness bootstrap terminal">
          <div className="harness-bootstrap-modal-surface">
            <header className="harness-bootstrap-modal-header">
              <div>
                <strong>Harness Bootstrap Terminal</strong>
                <p className="muted">{bootstrapSession.command}</p>
              </div>
              <div className="harness-bootstrap-modal-actions">
                <StatusBadge status={bootstrapSession.status} />
                <button type="button" onClick={() => setShowBootstrapTerminal(false)}>
                  Close
                </button>
              </div>
            </header>
            <div className="harness-bootstrap-terminal">
              <XtermView sessionId={bootstrapSession.id} active={showBootstrapTerminal} />
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
