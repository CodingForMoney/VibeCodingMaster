import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { HarnessBootstrapStatusReport, HarnessFileStatus, HarnessStatusReport } from "../../shared/types/harness.js";
import type { HarnessFileContent } from "../../shared/types/harness.js";
import type { ClaudePermissionMode, RoleSessionRecord, SessionEffort, SessionModel } from "../../shared/types/session.js";
import { apiClient } from "../state/api-client.js";
import { formatUiError } from "../state/error-format.js";
import { XtermView } from "../terminal/xterm-view.js";
import { SessionToolbar } from "./session-toolbar.js";
import { StatusBadge } from "./status-badge.js";

export interface HarnessStudioModalProps {
  busy?: boolean;
  effort: SessionEffort;
  model: SessionModel;
  open: boolean;
  permissionMode: ClaudePermissionMode;
  taskSlug: string | null;
  bootstrapStatus: HarnessBootstrapStatusReport | null;
  engineerSession: RoleSessionRecord | null;
  status: HarnessStatusReport | null;
  onClose(): void;
  onEffortChange(effort: SessionEffort): void;
  onModelChange(model: SessionModel): void;
  onPermissionModeChange(permissionMode: ClaudePermissionMode): void;
  onEngineerResume(): void;
  onEngineerRestart(): void;
  onEngineerStart(): void;
  onEngineerStop(): void;
  onEngineerNotifyHarnessUpdated(): void;
  onOpenRepositoryDiff(): void;
  onReviewTaskHarness(): void;
  onRefresh(): void;
}

export function HarnessStudioModal({
  busy,
  effort,
  model,
  open,
  permissionMode,
  taskSlug,
  bootstrapStatus,
  engineerSession,
  status,
  onClose,
  onEffortChange,
  onModelChange,
  onPermissionModeChange,
  onEngineerResume,
  onEngineerRestart,
  onEngineerStart,
  onEngineerStop,
  onEngineerNotifyHarnessUpdated,
  onOpenRepositoryDiff,
  onReviewTaskHarness,
  onRefresh
}: HarnessStudioModalProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<HarnessFileContent | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [editingFile, setEditingFile] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const files = status?.files ?? [];
  const agents = files.filter((file) => file.kind.startsWith("agent-"));
  const vcmRoleAgents = agents.filter((file) => isVcmRoleAgent(file));
  const auxiliaryAgents = agents.filter((file) => !isVcmRoleAgent(file));
  const skills = files.filter((file) => file.kind.startsWith("skill-"));
  const tools = files.filter((file) => file.kind.startsWith("tool-"));
  const rootContext = files.filter((file) => file.kind === "root-claude" || file.kind === "gitignore" || file.kind === "pull-request-template");
  const dirty = Boolean(selectedFile && draftContent !== selectedFile.content);

  useEffect(() => {
    if (!open) {
      setSelectedPath(null);
      setSelectedFile(null);
      setDraftContent("");
      setEditingFile(false);
      setFileError(null);
    }
  }, [files, open, selectedPath]);

  useEffect(() => {
    if (!open || !selectedPath || !taskSlug) {
      return;
    }

    let cancelled = false;
    setFileBusy(true);
    setFileError(null);
    setEditingFile(false);
    void apiClient.getHarnessFileContent(taskSlug, selectedPath)
      .then((file) => {
        if (cancelled) {
          return;
        }
        setSelectedFile(file);
        setDraftContent(file.content);
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setFileError(formatUiError(`Load harness file ${selectedPath}`, error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFileBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, selectedPath, taskSlug]);

  async function saveSelectedFile() {
    if (!selectedFile || !selectedFile.editable || !dirty || !taskSlug) {
      return;
    }

    setFileBusy(true);
    setFileError(null);
    try {
      const result = await apiClient.updateHarnessFileContent(taskSlug, selectedFile.path, { content: draftContent });
      setSelectedFile(result.file);
      setDraftContent(result.file.content);
      setEditingFile(false);
      onRefresh();
    } catch (error) {
      setFileError(formatUiError(`Save harness file ${selectedFile.path}`, error));
    } finally {
      setFileBusy(false);
    }
  }

  function closeFilePreview() {
    setSelectedPath(null);
    setSelectedFile(null);
    setDraftContent("");
    setEditingFile(false);
    setFileError(null);
  }

  async function copyHarnessFilePath(filePath: string) {
    setFileError(null);
    try {
      await writeClipboardText(filePath);
      setCopiedPath(filePath);
      window.setTimeout(() => {
        setCopiedPath((current) => current === filePath ? null : current);
      }, 1200);
    } catch (error) {
      setFileError(formatUiError(`Copy harness file path ${filePath}`, error));
    }
  }

  if (!open) {
    return null;
  }

  return (
    <>
      <div className="modal-backdrop harness-studio-backdrop">
        <section className="harness-studio-modal" role="dialog" aria-modal="true" aria-label="Harness Studio">
          <header className="harness-studio-header">
            <div>
              <h2>Harness Studio</h2>
              {!taskSlug ? <p className="muted">Create or select a task before editing harness files.</p> : null}
            </div>
            <div className="harness-studio-header-actions">
              <button type="button" disabled={busy || !taskSlug} onClick={onReviewTaskHarness}>Review Task Harness</button>
              <button type="button" disabled={busy} onClick={onOpenRepositoryDiff}>Review Diff</button>
              <button type="button" disabled={busy} onClick={onRefresh}>Refresh</button>
              <button type="button" onClick={onClose}>Close</button>
            </div>
          </header>

          <div className="harness-studio-layout">
            <aside className={selectedPath ? "harness-studio-left harness-studio-left-preview" : "harness-studio-left"}>
              {selectedPath ? (
                <section className="harness-studio-section harness-studio-file-preview">
                  <header className="harness-studio-file-editor-header">
                    <div>
                      <h3>{selectedFile?.title ?? "Harness File"}</h3>
                      <p className="muted">{selectedFile?.path ?? selectedPath}</p>
                    </div>
                    <div className="harness-studio-file-editor-actions">
                      {selectedFile ? <StatusBadge status={selectedFile.editable ? "ok" : "unknown"} /> : null}
                      {!editingFile ? (
                        <button
                          type="button"
                          disabled={fileBusy || !taskSlug || !selectedFile?.editable}
                          onClick={() => setEditingFile(true)}
                        >
                          Edit
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={fileBusy || !taskSlug || !selectedFile?.editable || !dirty}
                            onClick={() => void saveSelectedFile()}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            disabled={fileBusy}
                            onClick={() => {
                              setDraftContent(selectedFile?.content ?? "");
                              setEditingFile(false);
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      <button type="button" onClick={closeFilePreview}>Return</button>
                    </div>
                  </header>
                  {selectedFile?.readonlyReason ? (
                    <p className="muted">{selectedFile.readonlyReason}</p>
                  ) : null}
                  {fileError ? <p className="error-banner">{fileError}</p> : null}
                  <textarea
                    className={editingFile ? "harness-studio-file-textarea is-editing" : "harness-studio-file-textarea"}
                    value={draftContent}
                    spellCheck={false}
                    readOnly={!editingFile}
                    disabled={fileBusy}
                    onChange={(event) => setDraftContent(event.target.value)}
                  />
                </section>
              ) : (
                <>
                  <HarnessFileSection title="VCM Roles" files={vcmRoleAgents} selectedPath={selectedPath} copiedPath={copiedPath} onCopy={(path) => void copyHarnessFilePath(path)} onSelect={setSelectedPath} />
                  <HarnessFileSection title="Auxiliary Roles" files={auxiliaryAgents} selectedPath={selectedPath} copiedPath={copiedPath} onCopy={(path) => void copyHarnessFilePath(path)} onSelect={setSelectedPath} />
                  <HarnessCollapsibleSection title="Overview">
                    <section className="harness-studio-overview">
                      <div className="harness-studio-metrics">
                        <HarnessMetric label="Fixed install" value={status ? status.initialized ? status.needsApply ? "updates" : "current" : "new" : "unknown"} />
                        <HarnessMetric label="Revision" value={String(status?.harnessRevision ?? 0)} />
                        <HarnessMetric label="Managed files" value={String(files.length)} />
                        <HarnessMetric label="Pending updates" value={String(status?.plannedChanges.length ?? 0)} />
                        <HarnessMetric label="Bootstrap" value={bootstrapStatus?.status.replaceAll("_", " ") ?? "unknown"} />
                        <HarnessMetric label="Engineer" value={formatSessionStatus(engineerSession)} />
                      </div>
                      {status?.warnings.length ? (
                        <ul className="warnings">
                          {status.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                        </ul>
                      ) : null}
                    </section>
                  </HarnessCollapsibleSection>
                  <HarnessFileSection title="Skills" files={skills} selectedPath={selectedPath} copiedPath={copiedPath} onCopy={(path) => void copyHarnessFilePath(path)} onSelect={setSelectedPath} collapsible />
                  <HarnessFileSection title="Root Context" files={rootContext} selectedPath={selectedPath} copiedPath={copiedPath} onCopy={(path) => void copyHarnessFilePath(path)} onSelect={setSelectedPath} collapsible />
                  <HarnessFileSection title="Tools" files={tools} selectedPath={selectedPath} copiedPath={copiedPath} onCopy={(path) => void copyHarnessFilePath(path)} onSelect={setSelectedPath} collapsible />

                  <HarnessCollapsibleSection title="Project Docs">
                    <ul className="harness-studio-doc-list">
                      {bootstrapStatus?.checks.map((check) => (
                        <li key={check.key}>
                          <span>{check.path ?? check.label}</span>
                          <StatusBadge status={check.status} />
                        </li>
                      )) ?? <li><span>No bootstrap status loaded.</span></li>}
                    </ul>
                  </HarnessCollapsibleSection>
                </>
              )}
            </aside>

            <section className="harness-studio-section harness-studio-engineer">
              <div className="harness-studio-engineer-header">
                <div>
                  <h3>Harness Engineer</h3>
                  <p className="muted">{formatSessionStatus(engineerSession)}</p>
                </div>
                <StatusBadge status={engineerSession?.status ?? "unknown"} />
              </div>
              <SessionToolbar
                role="harness-engineer"
                session={engineerSession ?? undefined}
                permissionMode={permissionMode}
                model={model}
                effort={effort}
                busy={busy}
                onPermissionModeChange={onPermissionModeChange}
                onModelChange={onModelChange}
                onEffortChange={onEffortChange}
                onStart={onEngineerStart}
                onResume={onEngineerResume}
                onRestart={onEngineerRestart}
                onStop={onEngineerStop}
                onNotifyHarnessUpdated={onEngineerNotifyHarnessUpdated}
              />
              <div className="harness-engineer-terminal">
                {engineerSession?.status === "running" ? (
                  <XtermView key={engineerSession.id} sessionId={engineerSession.id} active={open} />
                ) : (
                  <div className="terminal-empty">
                    <strong>harness-engineer</strong>
                    <span>{engineerSession?.claudeSessionId ? "Resume this project Harness Engineer session." : "Start this project Harness Engineer session."}</span>
                  </div>
                )}
              </div>
            </section>
          </div>
        </section>
      </div>

    </>
  );
}

function HarnessMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="harness-studio-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HarnessFileSection({
  title,
  files,
  selectedPath,
  copiedPath,
  onCopy,
  onSelect,
  collapsible = false
}: {
  title: string;
  files: HarnessFileStatus[];
  selectedPath: string | null;
  copiedPath: string | null;
  onCopy(path: string): void;
  onSelect(path: string): void;
  collapsible?: boolean;
}) {
  const content = (
    <ol className="harness-studio-file-list">
      {files.length ? files.map((file) => (
        <li key={file.path} className={file.path === selectedPath ? "selected" : undefined}>
          <button className="harness-studio-file-path-button" type="button" title={file.path} onClick={() => onSelect(file.path)}>
            {file.path}
          </button>
          <button
            className="harness-studio-file-copy-button"
            type="button"
            title={`Copy ${file.path}`}
            onClick={() => onCopy(file.path)}
          >
            {copiedPath === file.path ? "Copied" : "Copy"}
          </button>
          <StatusBadge status={file.action} />
        </li>
      )) : <li><span>No files.</span></li>}
    </ol>
  );

  if (collapsible) {
    return (
      <HarnessCollapsibleSection title={title}>
        {content}
      </HarnessCollapsibleSection>
    );
  }

  return (
    <section className="harness-studio-section">
      <h3>{title}</h3>
      {content}
    </section>
  );
}

function HarnessCollapsibleSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="harness-studio-section harness-studio-collapsible-section">
      <summary>
        <h3>{title}</h3>
        <span>Show</span>
      </summary>
      <div className="harness-studio-collapsible-content">
        {children}
      </div>
    </details>
  );
}

function isVcmRoleAgent(file: HarnessFileStatus): boolean {
  return file.kind === "agent-project-manager"
    || file.kind === "agent-architect"
    || file.kind === "agent-coder"
    || file.kind === "agent-reviewer"
    || file.kind === "agent-gate-reviewer";
}

function formatSessionStatus(session: RoleSessionRecord | null): string {
  if (!session) {
    return "not started";
  }
  return session.status === "running"
    ? `${session.status} / ${session.activityStatus ?? "idle"}`
    : session.status;
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}
