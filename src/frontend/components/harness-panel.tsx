import type { HarnessApplyResult, HarnessStatusReport } from "../../shared/types/harness.js";
import { StatusBadge } from "./status-badge.js";

export interface HarnessPanelProps {
  status: HarnessStatusReport | null;
  applyResult?: HarnessApplyResult | null;
  busy?: boolean;
  onRefresh(): Promise<void>;
  onApply(): Promise<void>;
}

export function HarnessPanel({
  status,
  applyResult,
  busy = false,
  onRefresh,
  onApply
}: HarnessPanelProps) {
  if (!status) {
    return null;
  }

  return (
    <section className="harness-panel">
      <div className="harness-panel-header">
        <div>
          <h2>VCM Harness</h2>
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
    </section>
  );
}
