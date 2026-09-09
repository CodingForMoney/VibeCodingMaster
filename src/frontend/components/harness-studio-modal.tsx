import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  HarnessBootstrapStatusReport,
  HarnessFeedbackStateReport,
  HarnessFileStatus,
  HarnessStatusReport
} from "../../shared/types/harness.js";
import type {
  AutoMemoryStateReport,
  DurableDocAssignmentState,
  MemoryReviewRunSummary
} from "../../shared/types/memory.js";
import type { ClaudePermissionMode, RoleSessionRecord, SessionEffort, SessionModel, SessionModelOption } from "../../shared/types/session.js";
import { apiClient } from "../state/api-client.js";
import { formatUiError } from "../state/error-format.js";
import { useUiErrorState } from "../state/ui-error-state.js";
import { XtermView } from "../terminal/xterm-view.js";
import { SessionToolbar } from "./session-toolbar.js";
import { StatusBadge } from "./status-badge.js";

export interface HarnessStudioModalProps {
  busy?: boolean;
  effort: SessionEffort;
  model: SessionModel;
  modelOptions: SessionModelOption[];
  open: boolean;
  permissionMode: ClaudePermissionMode;
  taskSlug: string | null;
  bootstrapStatus: HarnessBootstrapStatusReport | null;
  engineerSession: RoleSessionRecord | null;
  status: HarnessStatusReport | null;
  feedbackState: HarnessFeedbackStateReport | null;
  memoryState: AutoMemoryStateReport | null;
  onClose(): void;
  onEffortChange(effort: SessionEffort): void;
  onModelChange(model: SessionModel): void;
  onPermissionModeChange(permissionMode: ClaudePermissionMode): void;
  onEngineerResume(): void;
  onEngineerRestart(): void;
  onEngineerStart(): void;
  onEngineerStop(): void;
  onEngineerNotifyHarnessUpdated(): void;
  onSendFeedback(feedbackPath: string): void;
  onOpenRepositoryDiff(): void;
  onReviewTaskHarness(): void;
  onRefresh(): void;
  onMemoryStateChange(state: AutoMemoryStateReport): void;
}

interface StudioFilePreview {
  path: string;
  title: string;
  content: string;
  editable: boolean;
  readonlyReason?: string;
  source: "harness" | "memory" | "memory-diff";
}

export function HarnessStudioModal({
  busy,
  effort,
  model,
  modelOptions,
  open,
  permissionMode,
  taskSlug,
  bootstrapStatus,
  engineerSession,
  status,
  feedbackState,
  memoryState,
  onClose,
  onEffortChange,
  onModelChange,
  onPermissionModeChange,
  onEngineerResume,
  onEngineerRestart,
  onEngineerStart,
  onEngineerStop,
  onEngineerNotifyHarnessUpdated,
  onSendFeedback,
  onOpenRepositoryDiff,
  onReviewTaskHarness,
  onRefresh,
  onMemoryStateChange
}: HarnessStudioModalProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedMemoryPath, setSelectedMemoryPath] = useState(false);
  const [selectedFile, setSelectedFile] = useState<StudioFilePreview | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [editingFile, setEditingFile] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [, setFileError] = useUiErrorState(null);
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
      setSelectedMemoryPath(false);
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
    if (selectedPath.startsWith("memory-review:")) {
      return;
    }

    let cancelled = false;
    setFileBusy(true);
    setFileError(null);
    setEditingFile(false);
    const loadFile = selectedMemoryPath
      ? apiClient.getMemoryFileContent(taskSlug, selectedPath).then((file): StudioFilePreview => ({
          path: file.path,
          title: file.title,
          content: file.content,
          editable: file.editable,
          source: "memory"
        }))
      : apiClient.getHarnessFileContent(taskSlug, selectedPath).then((file): StudioFilePreview => ({
          path: file.path,
          title: file.title,
          content: file.content,
          editable: file.editable,
          readonlyReason: file.readonlyReason,
          source: "harness"
        }));
    void loadFile
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
  }, [open, selectedMemoryPath, selectedPath, taskSlug]);

  async function saveSelectedFile() {
    if (!selectedFile || !selectedFile.editable || !dirty || !taskSlug) {
      return;
    }

    setFileBusy(true);
    setFileError(null);
    try {
      if (selectedFile.source === "memory") {
        const nextState = await apiClient.updateMemoryFileContent(taskSlug, selectedFile.path, { content: draftContent });
        const file = await apiClient.getMemoryFileContent(taskSlug, selectedFile.path);
        setSelectedFile({
          path: file.path,
          title: file.title,
          content: file.content,
          editable: true,
          source: "memory"
        });
        setDraftContent(file.content);
        onMemoryStateChange(nextState);
      } else {
        const result = await apiClient.updateHarnessFileContent(taskSlug, selectedFile.path, { content: draftContent });
        setSelectedFile({
          path: result.file.path,
          title: result.file.title,
          content: result.file.content,
          editable: result.file.editable,
          readonlyReason: result.file.readonlyReason,
          source: "harness"
        });
        setDraftContent(result.file.content);
      }
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
    setSelectedMemoryPath(false);
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

  function openMemoryDiff(run: MemoryReviewRunSummary) {
    const previewPath = `memory-review:${run.runId}`;
    setSelectedPath(previewPath);
    setSelectedMemoryPath(false);
    setSelectedFile({
      path: run.runId,
      title: `Memory Diff: ${run.runId}`,
      content: run.diff || "No memory diff was recorded.",
      editable: false,
      readonlyReason: `Applied by ${run.source}. Status: ${run.status}.`,
      source: "memory-diff"
    });
    setDraftContent(run.diff || "No memory diff was recorded.");
    setEditingFile(false);
  }

  async function revertMemoryRun(run: MemoryReviewRunSummary) {
    if (!taskSlug || !run.canRevert || !window.confirm(`Revert memory changes from ${run.runId}?`)) {
      return;
    }
    setFileBusy(true);
    setFileError(null);
    try {
      const nextState = await apiClient.revertMemoryRun({ taskSlug, runId: run.runId });
      onMemoryStateChange(nextState);
      closeFilePreview();
    } catch (error) {
      setFileError(formatUiError(`Revert memory review ${run.runId}`, error));
    } finally {
      setFileBusy(false);
    }
  }

  async function retryMemoryReview() {
    if (!taskSlug) {
      return;
    }
    setFileBusy(true);
    setFileError(null);
    try {
      onMemoryStateChange(await apiClient.retryMemoryReview({ taskSlug }));
    } catch (error) {
      setFileError(formatUiError("Retry Auto Memory review", error));
    } finally {
      setFileBusy(false);
    }
  }

  async function retryDurableDocAssignment(assignment: DurableDocAssignmentState) {
    if (!taskSlug) {
      return;
    }
    setFileBusy(true);
    setFileError(null);
    try {
      onMemoryStateChange(await apiClient.retryDurableDocAssignment({
        taskSlug,
        assignmentId: assignment.id
      }));
    } catch (error) {
      setFileError(formatUiError(`Retry durable document assignment ${assignment.id}`, error));
    } finally {
      setFileBusy(false);
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
                <div className="harness-studio-left-scroll">
                  <HarnessFileSection title="VCM Roles" files={vcmRoleAgents} selectedPath={selectedPath} copiedPath={copiedPath} onCopy={(path) => void copyHarnessFilePath(path)} onSelect={(path) => { setSelectedMemoryPath(false); setSelectedPath(path); }} />
                  <HarnessFileSection title="Auxiliary Roles" files={auxiliaryAgents} selectedPath={selectedPath} copiedPath={copiedPath} onCopy={(path) => void copyHarnessFilePath(path)} onSelect={(path) => { setSelectedMemoryPath(false); setSelectedPath(path); }} />
                  <MemorySection
                    state={memoryState}
                    busy={fileBusy}
                    copiedPath={copiedPath}
                    onCopy={(path) => void copyHarnessFilePath(path)}
                    onSelect={(path) => { setSelectedMemoryPath(true); setSelectedPath(path); }}
                    onViewDiff={openMemoryDiff}
                    onRevert={(run) => void revertMemoryRun(run)}
                    onRetry={() => void retryMemoryReview()}
                    onRetryAssignment={(assignment) => void retryDurableDocAssignment(assignment)}
                  />
                  <HarnessFeedbackInbox state={feedbackState} busy={busy} taskSlug={taskSlug} onSend={onSendFeedback} />
                  <HarnessCollapsibleSection title="Overview">
                    <section className="harness-studio-overview">
                      <div className="harness-studio-metrics">
                        <HarnessMetric label="Fixed install" value={status ? status.initialized ? status.needsApply ? "updates" : "current" : "new" : "unknown"} />
                        <HarnessMetric label="Revision" value={String(status?.harnessRevision ?? 0)} />
                        <HarnessMetric label="Managed files" value={String(files.length)} />
                        <HarnessMetric label="Pending updates" value={String(status?.plannedChanges.length ?? 0)} />
                        <HarnessMetric label="Bootstrap" value={bootstrapStatus?.status.replaceAll("_", " ") ?? "unknown"} />
                        <HarnessMetric label="Code intelligence" value={formatCodeIntelligenceState(status)} />
                        <HarnessMetric label="Engineer" value={formatSessionStatus(engineerSession)} />
                      </div>
                      {status?.warnings.length ? (
                        <ul className="warnings">
                          {status.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                        </ul>
                      ) : null}
                    </section>
                  </HarnessCollapsibleSection>
                  <HarnessCollapsibleSection title="Code Intelligence">
                    <ul className="harness-studio-doc-list harness-studio-code-intelligence-list">
                      {status?.codeIntelligence?.languages.length ? status.codeIntelligence.languages.map((language) => (
                        <li key={language.language}>
                          <span>{language.label}</span>
                          <code title="Language server">{language.serverCommand}</code>
                          <code title={language.pluginReady ? "VCM Claude Code plugin ready" : "VCM Claude Code plugin missing"}>{language.pluginName}</code>
                          <StatusBadge status={language.state === "server_runnable" ? "ok" : language.state === "server_failed" ? "failed" : "missing"} />
                          <span className="harness-studio-code-intelligence-detail">
                            {language.error ?? "Server runnable; workspace readiness is checked in each role session."}
                          </span>
                        </li>
                      )) : <li><span>No supported project language detected.</span></li>}
                    </ul>
                  </HarnessCollapsibleSection>
                  <HarnessFileSection title="Skills" files={skills} selectedPath={selectedPath} copiedPath={copiedPath} onCopy={(path) => void copyHarnessFilePath(path)} onSelect={(path) => { setSelectedMemoryPath(false); setSelectedPath(path); }} collapsible />
                  <HarnessFileSection title="Root Context" files={rootContext} selectedPath={selectedPath} copiedPath={copiedPath} onCopy={(path) => void copyHarnessFilePath(path)} onSelect={(path) => { setSelectedMemoryPath(false); setSelectedPath(path); }} collapsible />
                  <HarnessFileSection title="Tools" files={tools} selectedPath={selectedPath} copiedPath={copiedPath} onCopy={(path) => void copyHarnessFilePath(path)} onSelect={(path) => { setSelectedMemoryPath(false); setSelectedPath(path); }} collapsible />

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
                </div>
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
                modelOptions={modelOptions}
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
                    <span>{engineerSession?.claudeSessionId ? "Resume this task Harness Engineer session." : "Start this task Harness Engineer session."}</span>
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

function HarnessFeedbackInbox({
  state,
  busy,
  taskSlug,
  onSend
}: {
  state: HarnessFeedbackStateReport | null;
  busy?: boolean;
  taskSlug: string | null;
  onSend(feedbackPath: string): void;
}) {
  return (
    <HarnessCollapsibleSection title={`Harness Feedback Inbox (${state?.queuedCount ?? 0})`}>
      {state?.warnings.length ? (
        <ul className="warnings">
          {state.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      <ul className="harness-studio-doc-list">
        {state?.pending.length ? state.pending.map((item) => (
          <li key={item.path}>
            <span title={item.path}>{item.title}</span>
            <code>{item.reporterRole ?? "unknown"}</code>
            <button
              type="button"
              title="Send this feedback to Harness Engineer"
              disabled={busy || !taskSlug}
              onClick={() => onSend(item.path)}
            >
              Send
            </button>
          </li>
        )) : <li><span>No pending harness feedback.</span></li>}
      </ul>
    </HarnessCollapsibleSection>
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

function MemorySection({
  state,
  busy,
  copiedPath,
  onCopy,
  onSelect,
  onViewDiff,
  onRevert,
  onRetry,
  onRetryAssignment
}: {
  state: AutoMemoryStateReport | null;
  busy: boolean;
  copiedPath: string | null;
  onCopy(path: string): void;
  onSelect(path: string): void;
  onViewDiff(run: MemoryReviewRunSummary): void;
  onRevert(run: MemoryReviewRunSummary): void;
  onRetry(): void;
  onRetryAssignment(assignment: DurableDocAssignmentState): void;
}) {
  const assignments = state?.active?.assignments.length
    ? state.active.assignments
    : state?.runs.flatMap((run) => run.assignments) ?? [];
  return (
    <HarnessCollapsibleSection title="Memory">
      <div className="harness-memory-status">
        <span>Status</span>
        <StatusBadge status={memoryStatusBadge(state?.status)} />
        {state?.active?.currentRole ? <span className="muted">Collecting {state.active.currentRole}</span> : null}
        {state?.active?.error ? <p className="warnings">{state.active.error}</p> : null}
        {state?.status === "failed" && !state.active?.assignments.length ? (
          <button className="harness-memory-action-button" type="button" disabled={busy} onClick={onRetry}>Retry</button>
        ) : null}
      </div>
      <ol className="harness-studio-file-list">
        {state?.files.map((file) => (
          <li key={file.path}>
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
            <span className="muted">{formatBytes(file.sizeBytes)}</span>
          </li>
        )) ?? <li><span>No memory files.</span></li>}
      </ol>
      {assignments.length ? (
        <div className="harness-memory-runs">
          <h4>Durable Documentation</h4>
          <ol className="harness-studio-file-list">
            {assignments.map((assignment) => (
              <li key={assignment.id} className="harness-memory-assignment">
                <div className="harness-memory-assignment-detail" title={assignment.id}>
                  <span>{assignment.targetPath}</span>
                  {assignment.error ? <p className="warnings">{assignment.error}</p> : null}
                </div>
                <code>{assignment.owner ?? "PM"}</code>
                <StatusBadge status={assignmentStatusBadge(assignment.status)} />
                {assignment.status === "failed" ? (
                  <button
                    className="harness-memory-action-button"
                    type="button"
                    disabled={busy}
                    title={assignment.error}
                    onClick={() => onRetryAssignment(assignment)}
                  >
                    Retry
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {state?.runs.length ? (
        <div className="harness-memory-runs">
          <h4>Applied History</h4>
          <ol className="harness-studio-file-list">
            {state.runs.map((run) => (
              <li key={run.runId}>
                <button className="harness-studio-file-path-button" type="button" onClick={() => onViewDiff(run)}>
                  {run.runId}
                </button>
                <StatusBadge status={run.status === "applied" ? "ok" : run.status === "failed" ? "failed" : "unknown"} />
                {run.canRevert ? (
                  <button className="harness-memory-action-button" type="button" disabled={busy} onClick={() => onRevert(run)}>Revert</button>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </HarnessCollapsibleSection>
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
    || file.kind === "agent-tester"
    || file.kind === "agent-reviewer";
}

function formatSessionStatus(session: RoleSessionRecord | null): string {
  if (!session) {
    return "not started";
  }
  return session.status === "running"
    ? `${session.status} / ${session.activityStatus ?? "idle"}`
    : session.status;
}

function formatCodeIntelligenceState(status: HarnessStatusReport | null): string {
  return status?.codeIntelligence?.state.replaceAll("_", " ") ?? "unknown";
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}

function memoryStatusBadge(status: AutoMemoryStateReport["status"] | undefined) {
  if (status === "collecting" || status === "reviewing" || status === "documenting") {
    return "running" as const;
  }
  if (status === "failed") {
    return "failed" as const;
  }
  return status === "idle" ? "ok" as const : "unknown" as const;
}

function assignmentStatusBadge(status: DurableDocAssignmentState["status"]) {
  if (status === "completed") {
    return "ok" as const;
  }
  if (status === "failed") {
    return "failed" as const;
  }
  return "running" as const;
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
