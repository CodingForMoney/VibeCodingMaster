import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  TRANSLATION_TARGET_LANGUAGE_OPTIONS,
  type TranslationTargetLanguage
} from "../../shared/types/app-settings.js";
import type { RoleName } from "../../shared/types/role.js";
import type {
  TranslationSourceFileBrowserResult,
  TranslationSourceFileEntry,
  TranslationState,
  TranslationEntry,
  TranslationFailureItem,
  TranslationSessionEvent,
  TranslationSessionStatus
} from "../../shared/types/translation.js";
import { TRANSLATION_ENTRY_RETENTION_LIMIT } from "../../shared/types/translation.js";
import { apiClient } from "../state/api-client.js";
import { clearUiErrorForActions, formatUiError } from "../state/error-format.js";
import { clearPollError, recordPollError } from "../state/poll-error-gate.js";

type TranslationPanelStatus = TranslationSessionStatus;
const TRANSLATED_COMPOSER_SEPARATOR = "\n\n--- Translation ---\n";

export interface TranslationPanelProps {
  active?: boolean;
  autoSendEnabled: boolean;
  targetLanguage: TranslationTargetLanguage;
  taskSlug: string;
  role: RoleName;
  sessionId: string;
}

export function TranslationPanel({
  active = true,
  autoSendEnabled,
  targetLanguage,
  taskSlug,
  role,
  sessionId
}: TranslationPanelProps) {
  const [entries, setEntries] = useState<TranslationEntry[]>([]);
  const [failures, setFailures] = useState<TranslationFailureItem[]>([]);
  const [composer, setComposer] = useState("");
  const [manualSource, setManualSource] = useState("");
  const [composerIsEnglishDraft, setComposerIsEnglishDraft] = useState(false);
  const [status, setStatus] = useState<TranslationPanelStatus>("ready");
  const [lastPollAt, setLastPollAt] = useState("");
  const [panelNowMs, setPanelNowMs] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scrollRevision, setScrollRevision] = useState(0);
  const activeRef = useRef(active);
  const cursorRef = useRef(1);
  const entryListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

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
      timer = window.setTimeout(tick, activeRef.current ? 1000 : 5000);
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
        clearPollError("Poll conversation translation events");
        setError((current) => clearUiErrorForActions(current, ["Poll conversation translation events"]));
        if (activeRef.current) {
          setLastPollAt(formatPollTimestamp(new Date().toISOString()));
        }
      } catch (caught) {
        if (!cancelled) {
          const message = recordPollError("Poll conversation translation events", caught);
          if (message) {
            setError(message);
          }
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
          setError(formatUiError("Start conversation translation session", caught));
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
    const sourceText = composer;
    setBusy(true);
    setError("");
    setComposerIsEnglishDraft(false);
    try {
      const result = await apiClient.translateUserInput(taskSlug, role, {
        text: sourceText,
        mode: send ? "auto-send" : "review-before-send",
        useContext: false,
        send
      });
      if (result.sent) {
        setComposer("");
        setComposerIsEnglishDraft(false);
      } else {
        setComposer(formatTranslatedComposerDraft(sourceText, result.englishPreview));
        setComposerIsEnglishDraft(true);
      }
    } catch (caught) {
      setError(formatUiError("Translate composer input", caught));
    } finally {
      setBusy(false);
    }
  }

  async function translateManualOutput() {
    const sourceText = manualSource.trim();
    if (!sourceText) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const entry = await apiClient.translateManualOutput(taskSlug, role, { text: sourceText });
      setEntries((current) => trimTranslationEntries(upsertEntry(current, entry)).entries);
      setManualSource("");
      setScrollRevision((current) => current + 1);
    } catch (caught) {
      setError(formatUiError("Translate pasted English output", caught));
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
        setError(formatUiError("Process translation session event", event.message));
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
    const englishText = composerIsEnglishDraft ? extractTranslatedComposerDraft(composer) : composer;
    if (!englishText.trim()) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiClient.sendTranslatedInput(taskSlug, role, { englishText });
      setComposer("");
      setComposerIsEnglishDraft(false);
    } catch (caught) {
      setError(formatUiError("Send translated English input to role", caught));
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
    await apiClient.clearTranslationSession(sessionId).catch((caught: Error) => setError(formatUiError("Clear conversation translation panel", caught)));
  }

  async function ignoreFailures() {
    setBusy(true);
    setError("");
    try {
      const result = await apiClient.ignoreTranslationFailures(sessionId);
      setFailures(result.failures);
    } catch (caught) {
      setError(formatUiError("Ignore failed conversation translations", caught));
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
      setError(formatUiError("Retry failed conversation translations", caught));
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
            <button type="button" onClick={() => void clearPanel()}>Clear</button>
          </div>
        </div>
        <div className="translation-status-row">
          <p>Claude Code · target {getTranslationTargetLanguageLabel(targetLanguage)} · {panelStatus}</p>
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
        <div className="translation-composer-row translation-manual-row">
          <textarea
            value={manualSource}
            onChange={(event) => setManualSource(event.target.value)}
            placeholder="Paste English to translate on demand..."
          />
          <div className="translation-composer-actions">
            <button
              type="button"
              disabled={busy || !manualSource.trim()}
              onClick={() => void translateManualOutput()}
            >
              Translate
            </button>
          </div>
        </div>
        <div className="translation-composer-row">
          <textarea
            value={composer}
            onChange={(event) => {
              setComposer(event.target.value);
              if (!event.target.value.trim() || (composerIsEnglishDraft && !hasTranslatedComposerDraft(event.target.value))) {
                setComposerIsEnglishDraft(false);
              }
            }}
            onKeyDown={handleComposerKeyDown}
            placeholder="输入中文，先翻译成英文工程指令..."
          />
          <div className="translation-composer-actions">
            <button
              type="button"
              disabled={busy || !composerIsEnglishDraft || !extractTranslatedComposerDraft(composer).trim()}
              onClick={() => void sendEnglish()}
            >
              Send English
            </button>
          </div>
        </div>
      </div>

    </aside>
  );
}

function getTranslationTargetLanguageLabel(targetLanguage: TranslationTargetLanguage): string {
  return TRANSLATION_TARGET_LANGUAGE_OPTIONS.find((option) => option.value === targetLanguage)?.label ?? targetLanguage;
}

export function FileTranslationModalHost({
  open,
  taskSlug,
  targetLanguage,
  onClose
}: {
  open: boolean;
  taskSlug: string | null;
  targetLanguage: TranslationTargetLanguage;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [translationState, setTranslationState] = useState<TranslationState | null>(null);
  const [selectedFileJobId, setSelectedFileJobId] = useState<string>("");
  const [selectedFileOutput, setSelectedFileOutput] = useState("");
  const [selectedFileReport, setSelectedFileReport] = useState("");
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [fileBrowserState, setFileBrowserState] = useState<TranslationSourceFileBrowserResult | null>(null);
  const [fileBrowserPath, setFileBrowserPath] = useState("");
  const [fileBrowserQuery, setFileBrowserQuery] = useState("");
  const [fileBrowserSelectedPath, setFileBrowserSelectedPath] = useState("");
  const [fileBrowserBusy, setFileBrowserBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (cancelled) {
        return;
      }
      await refreshTranslationState(true);
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
  }, [open, selectedFileJobId]);

  async function refreshTranslationState(refreshSelected = false) {
    try {
      const next = await apiClient.getTranslationState();
      setTranslationState(next);
      const selectedStillVisible = selectedFileJobId
        ? next.fileIndex.jobs.some((job) => job.id === selectedFileJobId)
        : false;
      if ((!selectedFileJobId || !selectedStillVisible) && next.fileIndex.jobs[0]) {
        void selectFileJob(next.fileIndex.jobs[0].id);
      } else if (!next.fileIndex.jobs[0]) {
        setSelectedFileJobId("");
        setSelectedFileOutput("");
        setSelectedFileReport("");
      } else if (refreshSelected && selectedFileJobId) {
        const result = await apiClient.readFileTranslation(selectedFileJobId);
        setSelectedFileOutput(result.output);
        setSelectedFileReport(result.report);
      }
    } catch (caught) {
      setError(formatUiError("Load file translation list", caught));
    }
  }

  async function selectFileJob(jobId: string) {
    setSelectedFileJobId(jobId);
    setSelectedFileOutput("");
    setSelectedFileReport("");
    try {
      const result = await apiClient.readFileTranslation(jobId);
      setSelectedFileOutput(result.output);
      setSelectedFileReport(result.report);
    } catch (caught) {
      setError(formatUiError(`Read translated file ${jobId}`, caught));
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
      const result = await apiClient.browseTranslationSourceFiles({
        path,
        query,
        limit: 250
      });
      setFileBrowserState(result);
      setFileBrowserPath(result.currentPath);
      setFileBrowserQuery(query);
    } catch (caught) {
      setError(formatUiError("Browse translation source files", caught));
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
      if (!taskSlug) {
        throw new Error("Create or select a task before translating files.");
      }
      const job = await apiClient.createFileTranslation({
        taskSlug,
        sourcePath: normalizedSourcePath,
        targetLanguage
      });
      setFileBrowserOpen(false);
      await refreshTranslationState();
      await selectFileJob(job.id);
    } catch (caught) {
      setError(formatUiError(`Create file translation for ${normalizedSourcePath}`, caught));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return null;
  }

  return (
    <>
      <div className="modal-backdrop file-translation-backdrop">
        <FileTranslationPanel
          busy={busy}
          error={error}
          state={translationState}
          selectedJobId={selectedFileJobId}
          output={selectedFileOutput}
          report={selectedFileReport}
          onClose={() => {
            setFileBrowserOpen(false);
            onClose();
          }}
          onRefresh={() => void refreshTranslationState()}
          onSelectJob={(jobId) => void selectFileJob(jobId)}
          onTranslate={() => void openFileBrowser()}
        />
      </div>
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
    </>
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
  state: TranslationSourceFileBrowserResult | null;
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
  entry: TranslationSourceFileEntry;
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
  error,
  state,
  selectedJobId,
  output,
  report,
  onClose,
  onRefresh,
  onSelectJob,
  onTranslate
}: {
  busy: boolean;
  error?: string;
  state: TranslationState | null;
  selectedJobId: string;
  output: string;
  report: string;
  onClose(): void;
  onRefresh(): void;
  onSelectJob(jobId: string): void;
  onTranslate(): void;
}) {
  const jobs = state?.fileIndex.jobs ?? [];
  const selectedJob = jobs.find((job) => job.id === selectedJobId);

  return (
    <section className="file-translation-modal" role="dialog" aria-modal="true" aria-label="File Translation">
      <header className="file-translation-header">
        <div>
          <h2>File Translation</h2>
          <p>Claude Code · 中英互译</p>
        </div>
        <div className="file-translation-toolbar">
          <button type="button" disabled={busy} onClick={onTranslate}>Translate</button>
          <button type="button" disabled={busy} onClick={onRefresh}>Refresh</button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </header>
      {error ? <div className="error-banner">{error}</div> : null}
      {!state?.memoryInitialized ? (
        <p className="translation-entry-note">Translation memory is not initialized. Run Bootstrap from the sidebar before important file translations.</p>
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
    if (entry.direction === "user-input-to-english") {
      return formatTranslatedComposerDraft(entry.sourceText, entry.translatedText);
    }
    return entry.translatedText;
  }

  return entry.translatedText || entry.sourceText;
}

export function formatTranslatedComposerDraft(sourceText: string, translatedText: string): string {
  return `${sourceText.trimEnd()}${TRANSLATED_COMPOSER_SEPARATOR}${translatedText.trimStart()}`;
}

export function hasTranslatedComposerDraft(composerText: string): boolean {
  return composerText.includes(TRANSLATED_COMPOSER_SEPARATOR);
}

export function extractTranslatedComposerDraft(composerText: string): string {
  const separatorIndex = composerText.indexOf(TRANSLATED_COMPOSER_SEPARATOR);
  if (separatorIndex === -1) {
    return composerText;
  }
  return composerText.slice(separatorIndex + TRANSLATED_COMPOSER_SEPARATOR.length);
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
