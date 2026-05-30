import { useEffect, useRef, useState } from "react";
import type { RoleName } from "../../shared/types/role.js";
import type {
  TranslateUserInputResult,
  TranslationEntry,
  TranslationPromptPreview,
  TranslationSettings,
  TranslationWsMessage
} from "../../shared/types/translation.js";
import { apiClient } from "../state/api-client.js";
import { StatusBadge } from "./status-badge.js";
import { TranslationSettingsModal } from "./translation-settings-modal.js";

export interface TranslationPanelProps {
  taskSlug: string;
  role: RoleName;
  sessionId: string;
}

export function TranslationPanel({ taskSlug, role, sessionId }: TranslationPanelProps) {
  const [settings, setSettings] = useState<TranslationSettings | null>(null);
  const [entries, setEntries] = useState<TranslationEntry[]>([]);
  const [composer, setComposer] = useState("");
  const [englishPreview, setEnglishPreview] = useState("");
  const [contextUsed, setContextUsed] = useState(false);
  const [status, setStatus] = useState("ready");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [promptPreviews, setPromptPreviews] = useState<TranslationPromptPreview[]>([]);
  const [testResult, setTestResult] = useState<Awaited<ReturnType<typeof apiClient.testTranslationProvider>> | undefined>();
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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/translation/${encodeURIComponent(sessionId)}`);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string) as TranslationWsMessage;
      if (message.type === "translation-entry") {
        setEntries((current) => upsertEntry(current, message.entry));
      } else if (message.type === "translation-status") {
        setStatus(message.status);
      } else if (message.type === "translation-error") {
        setError(message.message);
      }
    });
    socket.addEventListener("error", () => setError("Translation connection failed."));
    return () => socket.close();
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length]);

  async function translateInput(send = false) {
    if (!settings) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result: TranslateUserInputResult = await apiClient.translateUserInput(taskSlug, role, {
        text: composer,
        mode: send ? "auto-send" : settings.inputMode,
        useContext: settings.contextEnabled,
        send
      });
      setEnglishPreview(result.englishPreview);
      setContextUsed(result.contextUsed);
      if (result.sent) {
        setComposer("");
        setEnglishPreview("");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Translation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function sendEnglish() {
    if (!englishPreview.trim()) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiClient.sendTranslatedInput(taskSlug, role, { englishText: englishPreview });
      setComposer("");
      setEnglishPreview("");
      setContextUsed(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to send English input.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(next: Partial<TranslationSettings>, apiKey?: string) {
    setBusy(true);
    setError("");
    try {
      const saved = await apiClient.updateTranslationSettings({ ...next, ...(apiKey ? { apiKey } : {}) });
      const previews = await apiClient.getTranslationPrompts();
      setSettings(saved);
      setPromptPreviews(previews);
      setShowSettings(false);
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

  return (
    <aside className="translation-panel">
      <header className="translation-panel-header">
        <div>
          <h2>Translation</h2>
          <p>{settings.model} · {status}{contextUsed ? " · context used" : ""}</p>
        </div>
        <div className="translation-panel-actions">
          <button type="button" onClick={() => setShowSettings(true)}>Settings</button>
          <button type="button" onClick={() => void clearPanel()}>Clear</button>
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
        <label>
          <span>User-language input</span>
          <textarea
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            placeholder="输入中文，先翻译成英文工程指令..."
          />
        </label>
        <div className="translation-composer-actions">
          <button type="button" disabled={busy || !composer.trim()} onClick={() => void translateInput(false)}>
            Translate
          </button>
          <button type="button" disabled={busy || !englishPreview.trim()} onClick={() => void sendEnglish()}>
            Send English
          </button>
          <button type="button" disabled={busy || !composer.trim()} onClick={() => void translateInput(true)}>
            Auto-send
          </button>
        </div>
        {englishPreview ? (
          <label>
            <span>English preview</span>
            <textarea value={englishPreview} onChange={(event) => setEnglishPreview(event.target.value)} />
          </label>
        ) : null}
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
  const [expanded, setExpanded] = useState(false);
  return (
    <article className={`translation-entry is-${entry.sourceKind}`}>
      <div className="translation-entry-meta">
        <span>{entry.sourceKind}</span>
        <StatusBadge status={entry.status} />
        {entry.contextUsed ? <span>context</span> : null}
      </div>
      {entry.warning ? <p className="translation-warning">{entry.warning}</p> : null}
      {entry.error ? <p className="translation-warning">{entry.error}</p> : null}
      <pre>{entry.translatedText || entry.sourceText}</pre>
      <button type="button" onClick={() => setExpanded(!expanded)}>
        {expanded ? "Hide original" : "Original"}
      </button>
      {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
      {expanded ? <pre className="translation-original">{entry.sourceText}</pre> : null}
    </article>
  );
}

function upsertEntry(entries: TranslationEntry[], entry: TranslationEntry): TranslationEntry[] {
  const index = entries.findIndex((current) => current.id === entry.id);
  if (index === -1) {
    return [...entries, entry];
  }
  return entries.map((current) => current.id === entry.id ? entry : current);
}
