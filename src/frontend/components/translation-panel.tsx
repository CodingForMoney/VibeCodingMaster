import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { RoleName } from "../../shared/types/role.js";
import type {
  TranslationEntry,
  TranslationPromptPreview,
  TranslationSettings,
  TranslationWsMessage
} from "../../shared/types/translation.js";
import { apiClient } from "../state/api-client.js";
import { TranslationSettingsModal } from "./translation-settings-modal.js";

type TranslationPanelStatus = Extract<TranslationWsMessage, { type: "translation-status" }>["status"];

export interface TranslationPanelProps {
  taskSlug: string;
  role: RoleName;
  sessionId: string;
}

export function TranslationPanel({ taskSlug, role, sessionId }: TranslationPanelProps) {
  const [settings, setSettings] = useState<TranslationSettings | null>(null);
  const [entries, setEntries] = useState<TranslationEntry[]>([]);
  const [composer, setComposer] = useState("");
  const [composerIsEnglishDraft, setComposerIsEnglishDraft] = useState(false);
  const [autoSendEnabled, setAutoSendEnabled] = useState(false);
  const [contextUsed, setContextUsed] = useState(false);
  const [status, setStatus] = useState<TranslationPanelStatus>("ready");
  const [panelNowMs, setPanelNowMs] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [promptPreviews, setPromptPreviews] = useState<TranslationPromptPreview[]>([]);
  const [testResult, setTestResult] = useState<Awaited<ReturnType<typeof apiClient.testTranslationProvider>> | undefined>();
  const [socketRevision, setSocketRevision] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void Promise.all([
      apiClient.getTranslationSettings(),
      apiClient.getTranslationPrompts()
    ])
      .then(([next, previews]) => {
        setSettings(next);
        setPromptPreviews(previews);
        if (!next.enabled) {
          setShowSettings(true);
        }
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(() => {
    setEntries([]);
    setError("");
    setStatus("ready");
    let active = true;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/translation/${encodeURIComponent(sessionId)}`);
    const handleMessage = (event: MessageEvent) => {
      if (!active) {
        return;
      }
      const message = JSON.parse(event.data as string) as TranslationWsMessage;
      if (message.type === "translation-entry") {
        setEntries((current) => upsertEntry(current, message.entry));
      } else if (message.type === "translation-status") {
        setStatus(message.status);
      } else if (message.type === "translation-error") {
        setError(message.message);
      }
    };
    socket.addEventListener("message", handleMessage);
    return () => {
      active = false;
      socket.removeEventListener("message", handleMessage);
      socket.close();
    };
  }, [sessionId, socketRevision]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length]);

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
    if (!settings) {
      return;
    }
    setBusy(true);
    setError("");
    setComposerIsEnglishDraft(false);
    try {
      const result = await apiClient.translateUserInput(taskSlug, role, {
        text: composer,
        mode: send ? "auto-send" : settings.inputMode,
        useContext: settings.contextEnabled,
        send
      });
      setContextUsed(result.contextUsed);
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
      setContextUsed(false);
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

  async function saveSettings(next: Partial<TranslationSettings>, apiKey?: string) {
    setBusy(true);
    setError("");
    try {
      const saved = await apiClient.updateTranslationSettings({ ...next, ...(apiKey !== undefined ? { apiKey } : {}) });
      const previews = await apiClient.getTranslationPrompts();
      setSettings(saved);
      setPromptPreviews(previews);
      setShowSettings(false);
      setSocketRevision((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save translation settings.");
    } finally {
      setBusy(false);
    }
  }

  async function testProvider() {
    setBusy(true);
    setError("");
    try {
      setTestResult(await apiClient.testTranslationProvider());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Provider test failed.");
    } finally {
      setBusy(false);
    }
  }

  async function clearPanel() {
    setEntries([]);
    await apiClient.clearTranslationSession(sessionId).catch((caught: Error) => setError(caught.message));
  }

  async function retryEntry(entry: TranslationEntry) {
    setBusy(true);
    try {
      const retried = await apiClient.retryTranslation(sessionId, entry.id);
      setEntries((current) => upsertEntry(current, retried));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return <aside className="translation-panel"><p className="muted">Loading translation settings...</p></aside>;
  }

  const panelStatus = getPanelStatus(entries, status, panelNowMs);

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
            <button type="button" onClick={() => setShowSettings(true)}>Settings</button>
            <button type="button" onClick={() => void clearPanel()}>Clear</button>
          </div>
        </div>
        <div>
          <p>{settings.model} · {panelStatus}{contextUsed ? " · context used" : ""}</p>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="translation-entry-list">
        {entries.length === 0 ? <p className="muted">Translated Claude Code output will appear here.</p> : null}
        {entries.map((entry) => (
          <TranslationEntryRow
            entry={entry}
            key={entry.id}
            onRetry={entry.status === "failed" ? () => void retryEntry(entry) : undefined}
          />
        ))}
        <div ref={bottomRef} />
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

      {showSettings ? (
        <TranslationSettingsModal
          settings={settings}
          busy={busy}
          promptPreviews={promptPreviews}
          testResult={testResult}
          onSave={saveSettings}
          onTest={testProvider}
          onClose={() => setShowSettings(false)}
        />
      ) : null}
    </aside>
  );
}

function TranslationEntryRow({ entry, onRetry }: { entry: TranslationEntry; onRetry?: () => void }) {
  const displayText = getTranslationEntryDisplayText(entry);

  return (
    <article className={`translation-entry is-${entry.sourceKind}`}>
      {entry.warning ? <p className="translation-warning">{entry.warning}</p> : null}
      {entry.error ? <p className="translation-warning">{entry.error}</p> : null}
      <pre>{displayText}</pre>
      {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
    </article>
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
