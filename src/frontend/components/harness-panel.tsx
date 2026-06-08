import { useState } from "react";
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

  if (!status) {
    return null;
  }

  const bootstrapSession = bootstrapStatus?.session;

  return (
    <section className="harness-panel">
      <div className="harness-stage">
        <div className="harness-panel-header">
          <div>
            <strong>Fixed install</strong>
            <p className="muted">
              {status.needsApply
                ? `${status.plannedChanges.length} planned changes`
                : "up to date"}
            </p>
          </div>
          <div className="harness-actions">
            <button type="button" disabled={busy} onClick={() => void onRefresh()}>
              Refresh
            </button>
            <button type="button" disabled={busy || !status.needsApply} onClick={() => void onApply()}>
              Install / Update
            </button>
          </div>
        </div>

        <ol className="harness-file-list">
          {status.files.map((file) => (
            <li key={file.path}>
              <span>{file.path}</span>
              <StatusBadge status={file.action} />
            </li>
          ))}
        </ol>
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
                  onClick={() => setShowBootstrapTerminal((current) => !current)}
                >
                  {showBootstrapTerminal ? "Hide Terminal" : "Open Terminal"}
                </button>
                {showBootstrapTerminal ? (
                  <div className="harness-bootstrap-terminal">
                    <XtermView sessionId={bootstrapSession.id} active={showBootstrapTerminal} />
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">Refresh harness status to load bootstrap checks.</p>
        )}
      </div>

      {status.plannedChanges.length > 0 ? (
        <div className="harness-changes">
          <h3>Planned Changes</h3>
          <ul>
            {status.plannedChanges.map((change) => (
              <li key={`${change.path}:${change.action}`}>
                <strong>{change.action}</strong> {change.path}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
    </section>
  );
}

function formatBootstrapStatus(status: HarnessBootstrapStatusReport["status"]): string {
  return status.replaceAll("_", " ");
}
