import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RoleName } from "../../shared/types/role.js";
import type {
  CodexTranslationSourceFileBrowserResult,
  CodexTranslationSourceFileEntry,
  CodexTranslationState,
  TranslationEntry,
  TranslationFailureItem,
  TranslationSessionEvent,
  TranslationSessionStatus
} from "../../shared/types/translation.js";
import { TRANSLATION_ENTRY_RETENTION_LIMIT } from "../../shared/types/translation.js";
import { apiClient } from "../state/api-client.js";

type TranslationPanelStatus = TranslationSessionStatus;
const DEFAULT_TARGET_LANGUAGE = "zh-CN";
const TRANSLATION_MODE_LABEL = "中英互译";

export interface TranslationPanelProps {
  active?: boolean;
  taskSlug: string;
  role: RoleName;
  sessionId: string;
}

export function TranslationPanel({ active = true, taskSlug, role, sessionId }: TranslationPanelProps) {
  const [entries, setEntries] = useState<TranslationEntry[]>([]);
  const [failures, setFailures] = useState<TranslationFailureItem[]>([]);
  const [composer, setComposer] = useState("");
  const [composerIsEnglishDraft, setComposerIsEnglishDraft] = useState(false);
  const [autoSendEnabled, setAutoSendEnabled] = useState(false);
  const [status, setStatus] = useState<TranslationPanelStatus>("ready");
  const [lastPollAt, setLastPollAt] = useState("");
  const [panelNowMs, setPanelNowMs] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileTranslationOpen, setFileTranslationOpen] = useState(false);
  const [codexState, setCodexState] = useState<CodexTranslationState | null>(null);
  const [selectedFileJobId, setSelectedFileJobId] = useState<string>("");
  const [selectedFileOutput, setSelectedFileOutput] = useState("");
  const [selectedFileReport, setSelectedFileReport] = useState("");
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [fileBrowserState, setFileBrowserState] = useState<CodexTranslationSourceFileBrowserResult | null>(null);
  const [fileBrowserPath, setFileBrowserPath] = useState("");
  const [fileBrowserQuery, setFileBrowserQuery] = useState("");
  const [fileBrowserSelectedPath, setFileBrowserSelectedPath] = useState("");
  const [fileBrowserBusy, setFileBrowserBusy] = useState(false);
  const [scrollRevision, setScrollRevision] = useState(0);
  const activeRef = useRef(active);
  const cursorRef = useRef(1);
  const entryListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!fileTranslationOpen) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (cancelled) {
        return;
      }
      await refreshCodexTranslationState(true);
      if (!cancelled) {
        timer = window.setTimeout(tick, 2000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [fileTranslationOpen, selectedFileJobId]);

  useEffect(() => {
    setEntries([]);
    setFailures([]);
    setError("");
    setStatus("ready");
    setLastPollAt("");
    cursorRef.current = 1;
    let cancelled = false;
    let timer: number | undefined;

    const schedule = () => {
      if (cancelled) {
        return;
      }
      timer = window.setTimeout(tick, activeRef.current ? 200 : 1000);
    };

    const tick = async () => {
      if (cancelled) {
        return;
      }
      try {
        const result = await apiClient.pollTranslationSession(sessionId, cursorRef.current);
        if (cancelled) {
          return;
        }
        applyTranslationEvents(result.events);
        cursorRef.current = result.nextCursor;
        setStatus(result.status);
        if (activeRef.current) {
          setLastPollAt(formatPollTimestamp(new Date().toISOString()));
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Translation poll failed.");
        }
      } finally {
        schedule();
      }
    };

    void apiClient.startTranslationSession(taskSlug, role)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setStatus(result.status);
        cursorRef.current = result.nextCursor;
        void tick();
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Translation start failed.");
        }
      });

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      void apiClient.stopTranslationSession(sessionId).catch(() => undefined);
    };
  }, [sessionId, taskSlug, role]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const entryList = entryListRef.current;
    if (!entryList) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      entryList.scrollTop = entryList.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, scrollRevision]);

  const activeTranslationStartedAt = getActiveTranslationStartedAt(entries);
  useEffect(() => {
    if (!activeTranslationStartedAt) {
      return;
    }

    setPanelNowMs(Date.now());
    const interval = window.setInterval(() => setPanelNowMs(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [activeTranslationStartedAt]);

  async function translateInput(send = false) {
    setBusy(true);
    setError("");
    setComposerIsEnglishDraft(false);
    try {
      const result = await apiClient.translateUserInput(taskSlug, role, {
        text: composer,
        mode: send ? "auto-send" : "review-before-send",
        useContext: false,
        send
      });
      if (result.sent) {
        setComposer("");
        setComposerIsEnglishDraft(false);
      } else {
        setComposer(result.englishPreview);
        setComposerIsEnglishDraft(true);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Translation failed.");
    } finally {
      setBusy(false);
    }
  }

  function applyTranslationEvents(events: TranslationSessionEvent[]) {
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      if (event.type === "status") {
        setStatus(event.status);
      } else if (event.type === "error") {
        setError(event.message);
      } else if (event.type === "failures") {
        setFailures(event.failures);
      }
    }

    const entryEvents = events.filter((event): event is Extract<TranslationSessionEvent, { type: "entry" }> =>
      event.type === "entry"
    );
    if (entryEvents.length > 0) {
      setEntries((current) => {
        const nextEntries = entryEvents.reduce((next, event) => upsertEntry(next, event.entry), current);
        const trimmed = trimTranslationEntries(nextEntries);
        if (trimmed.removedIds.size > 0) {
          setFailures((currentFailures) =>
            currentFailures.filter((failure) => !trimmed.removedIds.has(failure.translationId))
          );
        }
        return trimmed.entries;
      });
      setScrollRevision((current) => current + 1);
    }
  }

  async function sendEnglish() {
    if (!composer.trim()) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiClient.sendTranslatedInput(taskSlug, role, { englishText: composer });
      setComposer("");
      setComposerIsEnglishDraft(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to send English input.");
    } finally {
      setBusy(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (!busy && composer.trim()) {
      if (composerIsEnglishDraft) {
        void sendEnglish();
      } else {
        void translateInput(autoSendEnabled);
      }
    }
  }

  async function clearPanel() {
    setEntries([]);
    setFailures([]);
    cursorRef.current = 1;
    await apiClient.clearTranslationSession(sessionId).catch((caught: Error) => setError(caught.message));
  }

  async function ignoreFailures() {
    setBusy(true);
    setError("");
    try {
      const result = await apiClient.ignoreTranslationFailures(sessionId);
      setFailures(result.failures);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to ignore translation failures.");
    } finally {
      setBusy(false);
    }
  }

  async function retryFailures() {
    setBusy(true);
    setError("");
    try {
      const result = await apiClient.retryTranslationFailures(sessionId);
      setFailures(result.failures);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to retry translation failures.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshCodexTranslationState(refreshSelected = false) {
    try {
      const next = await apiClient.getCodexTranslationState();
      setCodexState(next);
      if (!selectedFileJobId && next.fileIndex.jobs[0]) {
        void selectFileJob(next.fileIndex.jobs[0].id);
      } else if (refreshSelected && selectedFileJobId) {
        const result = await apiClient.readCodexFileTranslation(selectedFileJobId);
        setSelectedFileOutput(result.output);
        setSelectedFileReport(result.report);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load file translations.");
    }
  }

  async function selectFileJob(jobId: string) {
    setSelectedFileJobId(jobId);
    setSelectedFileOutput("");
    setSelectedFileReport("");
    try {
      const result = await apiClient.readCodexFileTranslation(jobId);
      setSelectedFileOutput(result.output);
      setSelectedFileReport(result.report);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to read translated file.");
    }
  }

  async function openFileBrowser() {
    setFileBrowserOpen(true);
    await loadFileBrowser(fileBrowserPath, fileBrowserQuery);
  }

  async function loadFileBrowser(path = "", query = "") {
    setFileBrowserBusy(true);
    setError("");
    try {
      const result = await apiClient.browseCodexTranslationSourceFiles({
        path,
        query,
        limit: 250
      });
      setFileBrowserState(result);
      setFileBrowserPath(result.currentPath);
      setFileBrowserQuery(query);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to browse source files.");
    } finally {
      setFileBrowserBusy(false);
    }
  }

  async function createFileTranslation(sourcePath = fileBrowserSelectedPath) {
    const normalizedSourcePath = sourcePath.trim();
    if (!normalizedSourcePath) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const job = await apiClient.createCodexFileTranslation({
        taskSlug,
        sourcePath: normalizedSourcePath,
        targetLanguage: DEFAULT_TARGET_LANGUAGE
      });
      setFileBrowserOpen(false);
      await refreshCodexTranslationState();
      await selectFileJob(job.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to create file translation.");
    } finally {
      setBusy(false);
    }
  }

  async function createBootstrap() {
    setBusy(true);
    setError("");
    try {
      await apiClient.createCodexBootstrap({
        taskSlug,
        targetLanguage: DEFAULT_TARGET_LANGUAGE
      });
      await refreshCodexTranslationState();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to create translation bootstrap.");
    } finally {
      setBusy(false);
    }
  }

  async function promoteSelectedFile() {
    if (!selectedFileJobId) {
      return;
    }
    const targetPath = window.prompt("Promote translation to project path:");
    if (!targetPath?.trim()) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiClient.promoteCodexTranslation(selectedFileJobId, targetPath);
      await selectFileJob(selectedFileJobId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to promote translation.");
    } finally {
      setBusy(false);
    }
  }

  const panelStatus = getPanelStatus(entries, status, panelNowMs);
  const failureCount = failures.length;

  return (
    <aside className="translation-panel">
      <header className="translation-panel-header">
        <div className="translation-panel-titlebar">
          <h2>Translation</h2>
          <div className="translation-panel-actions">
            <button
              aria-pressed={autoSendEnabled}
              className={`auto-send-toggle${autoSendEnabled ? " is-active" : ""}`}
              type="button"
              onClick={() => setAutoSendEnabled((current) => !current)}
            >
              {autoSendEnabled ? "✅ Auto-send" : "× Auto-send"}
            </button>
            {failureCount > 0 ? (
              <>
                <button type="button" disabled={busy} onClick={() => void ignoreFailures()}>
                  Ignore {failureCount}
                </button>
                <button type="button" disabled={busy} onClick={() => void retryFailures()}>
                  Retry {failureCount}
                </button>
              </>
            ) : null}
            <button
              aria-pressed={fileTranslationOpen}
              type="button"
              onClick={() => setFileTranslationOpen(true)}
            >
              File
            </button>
            <button type="button" onClick={() => void clearPanel()}>Clear</button>
          </div>
        </div>
        <div className="translation-status-row">
          <p>Codex · {TRANSLATION_MODE_LABEL} · {panelStatus}</p>
          <p>{lastPollAt ? `poll ${lastPollAt}` : "poll -"}</p>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="translation-entry-list" ref={entryListRef}>
        {entries.length === 0 ? <p className="muted">Translated Claude Code output will appear here.</p> : null}
        {entries.map((entry) => (
          <TranslationEntryRow
            entry={entry}
            key={entry.id}
          />
        ))}
      </div>

      <div className="translation-composer">
        <div className="translation-composer-row">
          <textarea
            value={composer}
            onChange={(event) => {
              setComposer(event.target.value);
              if (!event.target.value.trim()) {
                setComposerIsEnglishDraft(false);
              }
            }}
            onKeyDown={handleComposerKeyDown}
            placeholder="输入中文，先翻译成英文工程指令..."
          />
          <div className="translation-composer-actions">
            <button type="button" disabled={busy || !composerIsEnglishDraft || !composer.trim()} onClick={() => void sendEnglish()}>
              Send English
            </button>
          </div>
        </div>
      </div>

      {fileTranslationOpen ? (
        <div className="modal-backdrop file-translation-backdrop">
          <FileTranslationPanel
            busy={busy}
            state={codexState}
            selectedJobId={selectedFileJobId}
            output={selectedFileOutput}
            report={selectedFileReport}
            onBootstrap={() => void createBootstrap()}
            onClose={() => {
              setFileTranslationOpen(false);
              setFileBrowserOpen(false);
            }}
            onRefresh={() => void refreshCodexTranslationState()}
            onSelectJob={(jobId) => void selectFileJob(jobId)}
            onTranslate={() => void openFileBrowser()}
            onPromote={() => void promoteSelectedFile()}
          />
        </div>
      ) : null}

      {fileBrowserOpen ? (
        <TranslationSourceFileBrowserModal
          busy={busy || fileBrowserBusy}
          state={fileBrowserState}
          currentPath={fileBrowserPath}
          query={fileBrowserQuery}
          selectedPath={fileBrowserSelectedPath}
          onBrowse={(nextPath, nextQuery) => void loadFileBrowser(nextPath, nextQuery)}
          onClose={() => setFileBrowserOpen(false)}
          onQueryChange={setFileBrowserQuery}
          onSelectPath={setFileBrowserSelectedPath}
          onTranslate={() => void createFileTranslation()}
        />
      ) : null}
    </aside>
  );
}

function TranslationSourceFileBrowserModal({
  busy,
  state,
  currentPath,
  query,
  selectedPath,
  onBrowse,
  onClose,
  onQueryChange,
  onSelectPath,
  onTranslate
}: {
  busy: boolean;
  state: CodexTranslationSourceFileBrowserResult | null;
  currentPath: string;
  query: string;
  selectedPath: string;
  onBrowse(path: string, query?: string): void;
  onClose(): void;
  onQueryChange(query: string): void;
  onSelectPath(path: string): void;
  onTranslate(): void;
}) {
  const entries = state?.entries ?? [];
  const directoryEntries = entries.filter((entry) => entry.type === "directory");
  const fileEntries = entries.filter((entry) => entry.type === "file");

  return (
    <div className="modal-backdrop translation-file-browser-backdrop">
      <section className="translation-file-browser-modal" role="dialog" aria-modal="true" aria-label="Select Source File">
        <header>
          <div>
            <h2>Select Source File</h2>
            <p>{currentPath || "."}</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <div className="translation-file-browser-controls">
          <div className="translation-file-browser-nav">
            <button type="button" disabled={busy || !currentPath} onClick={() => onBrowse(state?.parentPath ?? "", "")}>
              Up
            </button>
            <button type="button" disabled={busy || !currentPath} onClick={() => onBrowse("", "")}>
              Root
            </button>
          </div>
          <form
            className="translation-file-browser-search"
            onSubmit={(event) => {
              event.preventDefault();
              onBrowse(currentPath, query);
            }}
          >
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search files"
            />
            <button type="submit" disabled={busy}>Search</button>
            <button type="button" disabled={busy || !query} onClick={() => onBrowse(currentPath, "")}>
              Clear
            </button>
          </form>
        </div>

        <div className="translation-file-browser-layout">
          <div className="translation-file-browser-list">
            {busy && !state ? <p className="muted">Loading files...</p> : null}
            {!busy && entries.length === 0 ? <p className="muted">No source files found.</p> : null}
            {directoryEntries.length > 0 ? (
              <div className="translation-file-browser-group">
                <h3>Folders</h3>
                {directoryEntries.map((entry) => (
                  <FileBrowserEntryButton
                    entry={entry}
                    key={entry.path}
                    selected={selectedPath === entry.path}
                    onBrowse={onBrowse}
                    onSelectPath={onSelectPath}
                  />
                ))}
              </div>
            ) : null}
            {fileEntries.length > 0 ? (
              <div className="translation-file-browser-group">
                <h3>Files</h3>
                {fileEntries.map((entry) => (
                  <FileBrowserEntryButton
                    entry={entry}
                    key={entry.path}
                    selected={selectedPath === entry.path}
                    onBrowse={onBrowse}
                    onSelectPath={onSelectPath}
                  />
                ))}
              </div>
            ) : null}
            {state?.truncated ? <p className="translation-entry-note">Result limit reached.</p> : null}
          </div>

          <aside className="translation-file-browser-selection">
            <label>
              <span>Source path</span>
              <input
                value={selectedPath}
                onChange={(event) => onSelectPath(event.target.value)}
              />
            </label>
            <button type="button" disabled={busy || !selectedPath.trim()} onClick={onTranslate}>
              Translate File
            </button>
          </aside>
        </div>
      </section>
    </div>
  );
}

function FileBrowserEntryButton({
  entry,
  selected,
  onBrowse,
  onSelectPath
}: {
  entry: CodexTranslationSourceFileEntry;
  selected: boolean;
  onBrowse(path: string, query?: string): void;
  onSelectPath(path: string): void;
}) {
  const isDirectory = entry.type === "directory";
  return (
    <button
      className={selected ? "translation-file-browser-entry is-selected" : "translation-file-browser-entry"}
      type="button"
      onClick={() => isDirectory ? onBrowse(entry.path, "") : onSelectPath(entry.path)}
      onDoubleClick={() => isDirectory ? onBrowse(entry.path, "") : undefined}
    >
      <span>{isDirectory ? "DIR" : "FILE"}</span>
      <strong>{entry.name}</strong>
      <small>{entry.path}</small>
    </button>
  );
}

function FileTranslationPanel({
  busy,
  state,
  selectedJobId,
  output,
  report,
  onBootstrap,
  onClose,
  onRefresh,
  onSelectJob,
  onTranslate,
  onPromote
}: {
  busy: boolean;
  state: CodexTranslationState | null;
  selectedJobId: string;
  output: string;
  report: string;
  onBootstrap(): void;
  onClose(): void;
  onRefresh(): void;
  onSelectJob(jobId: string): void;
  onTranslate(): void;
  onPromote(): void;
}) {
  const jobs = state?.fileIndex.jobs ?? [];
  const selectedJob = jobs.find((job) => job.id === selectedJobId);

  return (
    <section className="file-translation-modal" role="dialog" aria-modal="true" aria-label="File Translation">
      <header className="file-translation-header">
        <div>
          <h2>File Translation</h2>
          <p>Codex · 中英互译</p>
        </div>
        <div className="file-translation-toolbar">
          <button type="button" disabled={busy} onClick={onTranslate}>Translate</button>
          <button type="button" disabled={busy} onClick={onBootstrap}>Bootstrap</button>
          <button type="button" disabled={busy} onClick={onRefresh}>Refresh</button>
          <button type="button" disabled={busy || !selectedJob} onClick={onPromote}>Promote</button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </header>
      {!state?.memoryInitialized ? (
        <p className="translation-entry-note">Translation memory is not initialized. Run Bootstrap before important file translations.</p>
      ) : null}
      <div className="file-translation-layout">
        <div className="file-translation-list">
          {jobs.length === 0 ? <p className="muted">No translated files yet.</p> : null}
          {jobs.map((job) => (
            <button
              className={job.id === selectedJobId ? "file-translation-item is-active" : "file-translation-item"}
              key={job.id}
              type="button"
              onClick={() => onSelectJob(job.id)}
            >
              <strong>{job.sourcePath}</strong>
              <span>{job.status} · {job.targetLanguage}</span>
            </button>
          ))}
        </div>
        <div className="file-translation-preview">
          {selectedJob ? (
            <>
              <header>
                <strong>{selectedJob.sourcePath}</strong>
                <span>{selectedJob.status}</span>
              </header>
              <div className="translation-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{output || report || "Translation output is not available yet."}</ReactMarkdown>
              </div>
            </>
          ) : (
            <p className="muted">Select a translated file to preview it.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function TranslationEntryRow({ entry }: { entry: TranslationEntry }) {
  if (entry.sourceKind === "conversation-boundary") {
    return <ConversationBoundaryRow entry={entry} />;
  }

  const displayText = getTranslationEntryDisplayText(entry);
  const isToolOutput = entry.sourceKind === "tool-output";
  const isUserInput = entry.direction === "user-input-to-english";
  const className = [
    "translation-entry",
    `is-${entry.sourceKind}`,
    isUserInput ? "is-user-input" : ""
  ].filter(Boolean).join(" ");

  return (
    <article className={className}>
      {isToolOutput ? (
        <pre>{displayText}</pre>
      ) : (
        <div className="translation-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown>
        </div>
      )}
      {entry.warning ? <p className="translation-entry-note">{entry.warning}</p> : null}
      {entry.error ? <p className="translation-entry-note is-error">{entry.error}</p> : null}
    </article>
  );
}

function ConversationBoundaryRow({ entry }: { entry: TranslationEntry }) {
  const label = entry.boundaryKind === "end" ? "结束" : "开始";
  const turn = entry.conversationTurn ?? 0;
  const time = formatBoundaryTimestamp(entry.occurredAt ?? entry.createdAt);

  return (
    <div className="translation-conversation-boundary" aria-label={`${label} 第 ${turn} 轮 ${time}`}>
      <span className="translation-boundary-dash" aria-hidden="true" />
      <span>{label}</span>
      <span>第 {turn} 轮</span>
      <time>{time}</time>
      <span className="translation-boundary-dash" aria-hidden="true" />
    </div>
  );
}

function getActiveTranslationStartedAt(entries: TranslationEntry[]): string | undefined {
  const activeEntry = entries.find(isActiveTranslation);
  return activeEntry?.translationStartedAt ?? activeEntry?.createdAt;
}

function getPanelStatus(entries: TranslationEntry[], fallbackStatus: TranslationPanelStatus, nowMs: number): string {
  const activeEntry = entries.find(isActiveTranslation);
  if (activeEntry) {
    return `translating ${formatElapsed(Math.max(0, nowMs - getEntryStartedMs(activeEntry)))}`;
  }

  const latestEntry = entries.at(-1);
  if (latestEntry?.status === "failed" || fallbackStatus === "failed") {
    return "error";
  }

  return fallbackStatus;
}

function isActiveTranslation(entry: TranslationEntry): boolean {
  return entry.status === "queued" || entry.status === "translating";
}

function trimTranslationEntries(entries: TranslationEntry[]): {
  entries: TranslationEntry[];
  removedIds: Set<string>;
} {
  const overflow = entries.length - TRANSLATION_ENTRY_RETENTION_LIMIT;
  if (overflow <= 0) {
    return { entries, removedIds: new Set() };
  }

  const removedIds = new Set<string>();
  for (const entry of entries) {
    if (removedIds.size >= overflow) {
      break;
    }
    if (isActiveTranslation(entry)) {
      continue;
    }
    removedIds.add(entry.id);
  }

  if (removedIds.size === 0) {
    return { entries, removedIds };
  }

  return {
    entries: entries.filter((entry) => !removedIds.has(entry.id)),
    removedIds
  };
}

function getEntryStartedMs(entry: TranslationEntry): number {
  const timestamp = Date.parse(entry.translationStartedAt ?? entry.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function getTranslationEntryDisplayText(entry: TranslationEntry): string {
  if (entry.status === "queued" || entry.status === "translating") {
    return entry.sourceText;
  }

  if (entry.status === "translated") {
    return entry.translatedText;
  }

  return entry.translatedText || entry.sourceText;
}

function upsertEntry(entries: TranslationEntry[], entry: TranslationEntry): TranslationEntry[] {
  const index = entries.findIndex((current) => current.id === entry.id);
  if (index === -1) {
    return [...entries, entry];
  }
  return entries.map((current) => current.id === entry.id ? entry : current);
}

function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 1000) {
    return `${Math.max(0.1, elapsedMs / 1000).toFixed(1)}s`;
  }

  const seconds = elapsedMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function formatPollTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleTimeString();
}

function formatBoundaryTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleTimeString();
}
