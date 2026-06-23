import { useEffect, useMemo, useState } from "react";
import type {
  RepositoryDiffFile,
  RepositoryDiffFileCategory,
  RepositoryDiffFileStage,
  RepositoryDiffFileStatus,
  RepositoryDiffReport
} from "../../shared/types/harness.js";
import { apiClient } from "../state/api-client.js";

export interface RepositoryDiffModalProps {
  open: boolean;
  taskSlug: string | null;
  onClose(): void;
}

export function RepositoryDiffModal({ open, taskSlug, onClose }: RepositoryDiffModalProps) {
  const [report, setReport] = useState<RepositoryDiffReport | null>(null);
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedFile = useMemo(
    () => report?.files.find((file) => file.path === selectedPath) ?? report?.files[0] ?? null,
    [report, selectedPath]
  );

  async function loadDiff(commitSha = selectedCommitSha) {
    setBusy(true);
    setError(null);
    try {
      if (!taskSlug) {
        throw new Error("Create or select a task before reviewing harness commits.");
      }
      const nextReport = await apiClient.getRepositoryDiff(taskSlug, commitSha);
      setReport(nextReport);
      setSelectedCommitSha(nextReport.commit?.sha ?? null);
      setSelectedPath((current) =>
        current && nextReport.files.some((file) => file.path === current)
          ? current
          : nextReport.files[0]?.path ?? null
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedCommitSha(null);
    void loadDiff(null);
  }, [open, taskSlug]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop repository-diff-backdrop">
      <section className="repository-diff-modal" role="dialog" aria-modal="true" aria-label="Commit Diff">
        <header className="repository-diff-header">
          <div>
            <h2>Commit Diff</h2>
            <p>
              {report
                ? `${report.commit?.shortSha ?? "HEAD"} · ${report.summary.totalFiles} files · +${report.summary.additions} / -${report.summary.deletions}`
                : "Review a new commit on the active task worktree branch."}
            </p>
          </div>
          <div className="repository-diff-header-actions">
            <label className="repository-diff-commit-picker">
              <span>Commit</span>
              <select
                value={selectedCommitSha ?? ""}
                disabled={busy || !report?.commits.length}
                onChange={(event) => {
                  const nextCommitSha = event.target.value || null;
                  setSelectedCommitSha(nextCommitSha);
                  void loadDiff(nextCommitSha);
                }}
              >
                {report?.commits.map((commit) => (
                  <option key={commit.sha} value={commit.sha}>
                    {commit.shortSha} · {commit.subject}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={busy} onClick={() => void loadDiff()}>
              Refresh
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {error ? <p className="error-banner">{error}</p> : null}

        {report?.warnings.length ? (
          <ul className="warnings repository-diff-warnings">
            {report.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        ) : null}

        <div className="repository-diff-body">
          <aside className="repository-diff-sidebar">
            <RepositoryDiffSummary report={report} busy={busy} />
            <ol className="repository-diff-file-list">
              {report?.files.map((file) => (
                <li key={file.path} className={selectedFile?.path === file.path ? "selected" : ""}>
                  <button type="button" onClick={() => setSelectedPath(file.path)}>
                    <span>{file.path}</span>
                    <small>
                      {formatStatus(file.status)} · {formatStage(file.stage)} · {formatCategory(file.category)}
                    </small>
                  </button>
                </li>
              ))}
              {report && report.files.length === 0 ? (
                <li className="repository-diff-empty">
                  {report.commits.length === 0 ? "No new commits on this task branch." : "No files in this commit."}
                </li>
              ) : null}
            </ol>
          </aside>

          <main className="repository-diff-main">
            {selectedFile ? (
              <>
                <div className="repository-diff-file-header">
                  <div>
                    <h3>{selectedFile.path}</h3>
                    <p>
                      {formatCategory(selectedFile.category)} · {formatStatus(selectedFile.status)} · {formatStage(selectedFile.stage)}
                    </p>
                  </div>
                  <span className="repository-diff-stats">+{selectedFile.additions} / -{selectedFile.deletions}</span>
                </div>
                {selectedFile.binary ? <p className="muted">Binary or non-regular file. Text diff is not available.</p> : null}
                {selectedFile.truncated ? <p className="muted">Diff was truncated for display.</p> : null}
                <pre className="repository-diff-code" aria-label={`${selectedFile.path} diff`}>
                  {renderDiffLines(selectedFile.diff)}
                </pre>
              </>
            ) : (
              <div className="repository-diff-placeholder">
                {busy ? "Loading commit diff..." : "No diff selected."}
              </div>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}

function RepositoryDiffSummary({ report, busy }: { report: RepositoryDiffReport | null; busy: boolean }) {
  const summary = report?.summary;
  return (
    <div className="repository-diff-summary">
      <strong>{busy ? "Loading" : report ? "Commit changes" : "Not loaded"}</strong>
      {summary ? (
        <>
          <span>{summary.harnessFiles} harness files</span>
          <span>{summary.productCodeFiles} product code files</span>
          <span>{summary.committedFiles} committed files</span>
          <span>{report?.commits.length ?? 0} branch commits</span>
          <span>{report?.commit?.subject ?? "HEAD"}</span>
        </>
      ) : null}
    </div>
  );
}

function formatCategory(category: RepositoryDiffFileCategory): string {
  switch (category) {
    case "fixed_harness":
      return "fixed harness";
    case "tools_hooks":
      return "tools/hooks";
    case "generated_context":
      return "generated context";
    case "project_docs":
      return "project docs";
    case "product_code":
      return "product code";
  }
}

function formatStage(stage: RepositoryDiffFileStage): string {
  return stage.replaceAll("_", " ");
}

function formatStatus(status: RepositoryDiffFileStatus): string {
  return status.replaceAll("_", " ");
}

function renderDiffLines(diff: string) {
  return diff
    .split("\n")
    .filter((line) => !isHiddenDiffMetaLine(line))
    .map((line, index) => (
      <span key={`${index}:${line}`} className={`repository-diff-line ${getDiffLineClassName(line)}`}>
        {line || " "}
      </span>
    ));
}

function getDiffLineClassName(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "repository-diff-line-added";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "repository-diff-line-deleted";
  }
  if (line.startsWith("@@")) {
    return "repository-diff-line-hunk";
  }
  return "repository-diff-line-context";
}

function isHiddenDiffMetaLine(line: string): boolean {
  return line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ");
}
