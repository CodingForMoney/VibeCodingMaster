import { useCallback, useEffect, useState } from "react";
import { getRoleDefinition } from "../../shared/constants.js";
import type {
  TaskUsageAnalyticsReport,
  UsageAnalyticsTotals
} from "../../shared/types/usage-analytics.js";
import { apiClient } from "../state/api-client.js";
import { errorReason } from "../state/error-format.js";

export interface UsageAnalyticsModalProps {
  open: boolean;
  taskSlug: string;
  taskTitle?: string;
  onClose(): void;
}

export function UsageAnalyticsModal({ open, taskSlug, taskTitle, onClose }: UsageAnalyticsModalProps) {
  const [report, setReport] = useState<TaskUsageAnalyticsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await apiClient.getTaskUsageAnalytics(taskSlug));
    } catch (caught) {
      setError(`Load task usage analytics failed. Reason: ${errorReason(caught)}`);
    } finally {
      setBusy(false);
    }
  }, [taskSlug]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void load();
  }, [load, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop usage-analytics-backdrop">
      <section className="usage-analytics-modal" role="dialog" aria-modal="true" aria-label="Usage Analytics">
        <header className="usage-analytics-header">
          <div>
            <h2>Usage Analytics</h2>
            <p>{taskTitle?.trim() || taskSlug} · Claude models only</p>
          </div>
          <div className="usage-analytics-header-actions">
            <button type="button" disabled={busy} onClick={() => void load()}>
              {busy ? "Refreshing..." : "Refresh"}
            </button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </header>

        {error ? <p className="inline-error usage-analytics-error">{error}</p> : null}
        {report ? (
          <UsageAnalyticsContent report={report} />
        ) : (
          <div className="usage-analytics-empty">{busy ? "Loading usage data..." : "No usage data available."}</div>
        )}
      </section>
    </div>
  );
}

export function UsageAnalyticsContent({ report }: { report: TaskUsageAnalyticsReport }) {
  return (
    <div className="usage-analytics-content">
      <div className="usage-analytics-meta">
        <span>{report.updatedAt ? `Updated ${formatDateTime(report.updatedAt)}` : "No Claude usage recorded yet"}</span>
        <span>{formatInteger(report.totals.requestCount)} requests · {formatInteger(report.totals.sessionCount)} sessions</span>
      </div>

      <section className="usage-analytics-section" aria-labelledby="usage-task-summary">
        <h3 id="usage-task-summary">Task Summary</h3>
        <UsageTotalsGrid totals={report.totals} />
      </section>

      <section className="usage-analytics-section" aria-labelledby="usage-by-role">
        <h3 id="usage-by-role">Usage by Role</h3>
        <div className="usage-analytics-table-wrap">
          <table className="usage-analytics-table">
            <thead><UsageTableHeader firstColumn="Role" /></thead>
            <tbody>
              {report.byRole.map((summary) => (
                <tr key={summary.role}>
                  <th scope="row">
                    <span>{getRoleDefinition(summary.role).label}</span>
                    <small>{formatInteger(summary.requestCount)} requests · {formatInteger(summary.sessionCount)} sessions</small>
                  </th>
                  <UsageTableCells totals={summary} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="usage-analytics-section" aria-labelledby="usage-by-model">
        <h3 id="usage-by-model">Usage by Model</h3>
        {report.byModel.length > 0 ? (
          <div className="usage-analytics-table-wrap">
            <table className="usage-analytics-table">
              <thead><UsageTableHeader firstColumn="Model" /></thead>
              <tbody>
                {report.byModel.map((summary) => (
                  <tr key={summary.model}>
                    <th scope="row">
                      <span>{summary.model}</span>
                      <small>{formatInteger(summary.requestCount)} requests · {formatInteger(summary.sessionCount)} sessions</small>
                    </th>
                    <UsageTableCells totals={summary} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="usage-analytics-no-models">No Claude model usage recorded yet.</p>
        )}
      </section>
    </div>
  );
}

function UsageTotalsGrid({ totals }: { totals: UsageAnalyticsTotals }) {
  return (
    <dl className="usage-totals-grid">
      <UsageMetric label="Input Tokens" value={formatInteger(totals.inputTokens)} />
      <UsageMetric label="Output Tokens" value={formatInteger(totals.outputTokens)} />
      <UsageMetric label="Cache Read" value={formatInteger(totals.cacheReadTokens)} />
      <UsageMetric label="Cache Creation" value={formatInteger(totals.cacheCreationTokens)} />
      <UsageMetric label="Estimated Cost" value={formatCost(totals.costUsd)} />
    </dl>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function UsageTableHeader({ firstColumn }: { firstColumn: string }) {
  return (
    <tr>
      <th scope="col">{firstColumn}</th>
      <th scope="col">Input</th>
      <th scope="col">Output</th>
      <th scope="col">Cache Read</th>
      <th scope="col">Cache Creation</th>
      <th scope="col">Estimated Cost</th>
    </tr>
  );
}

function UsageTableCells({ totals }: { totals: UsageAnalyticsTotals }) {
  return (
    <>
      <td>{formatInteger(totals.inputTokens)}</td>
      <td>{formatInteger(totals.outputTokens)}</td>
      <td>{formatInteger(totals.cacheReadTokens)}</td>
      <td>{formatInteger(totals.cacheCreationTokens)}</td>
      <td>{formatCost(totals.costUsd)}</td>
    </>
  );
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatCost(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 6
  }).format(value);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
