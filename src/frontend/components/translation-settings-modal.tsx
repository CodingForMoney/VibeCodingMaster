import { useEffect, useState } from "react";
import type {
  TranslationProviderTestResult,
  TranslationSettings
} from "../../shared/types/translation.js";

export interface TranslationSettingsModalProps {
  settings: TranslationSettings;
  busy?: boolean;
  testResult?: TranslationProviderTestResult;
  onSave(settings: Partial<TranslationSettings>, apiKey?: string): Promise<void>;
  onTest(): Promise<void>;
  onClose(): void;
}

export function TranslationSettingsModal({
  settings,
  busy = false,
  testResult,
  onSave,
  onTest,
  onClose
}: TranslationSettingsModalProps) {
  const [draft, setDraft] = useState(settings);
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  return (
    <div className="modal-backdrop">
      <section className="translation-settings-modal" role="dialog" aria-modal="true" aria-label="Translation Settings">
        <header>
          <div>
            <h2>Translation Settings</h2>
            <p>Use an OpenAI-compatible endpoint for the embedded translation panel.</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <div className="translation-settings-grid">
          <label>
            <span>Enable translation</span>
            <input
              checked={draft.enabled}
              type="checkbox"
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
          </label>
          <label>
            <span>Base URL</span>
            <input
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label>
            <span>API key</span>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Leave blank to keep existing key"
              type="password"
            />
          </label>
          <label>
            <span>Model</span>
            <input
              value={draft.model}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
          </label>
          <label>
            <span>Target language</span>
            <input
              value={draft.targetLanguage}
              onChange={(event) => setDraft({ ...draft, targetLanguage: event.target.value })}
            />
          </label>
          <label>
            <span>Input mode</span>
            <select
              value={draft.inputMode}
              onChange={(event) => setDraft({ ...draft, inputMode: event.target.value as TranslationSettings["inputMode"] })}
            >
              <option value="review-before-send">Review before send</option>
              <option value="auto-send">Auto-send</option>
            </select>
          </label>
          <label>
            <span>Use context</span>
            <input
              checked={draft.contextEnabled}
              type="checkbox"
              onChange={(event) => setDraft({ ...draft, contextEnabled: event.target.checked })}
            />
          </label>
          <label>
            <span>Translate output</span>
            <input
              checked={draft.translateOutput}
              type="checkbox"
              onChange={(event) => setDraft({ ...draft, translateOutput: event.target.checked })}
            />
          </label>
          <label>
            <span>Translate user input</span>
            <input
              checked={draft.translateUserInput}
              type="checkbox"
              onChange={(event) => setDraft({ ...draft, translateUserInput: event.target.checked })}
            />
          </label>
          <label>
            <span>Max chunk chars</span>
            <input
              min={500}
              max={12000}
              type="number"
              value={draft.maxChunkChars}
              onChange={(event) => setDraft({ ...draft, maxChunkChars: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>Timeout ms</span>
            <input
              min={3000}
              type="number"
              value={draft.requestTimeoutMs}
              onChange={(event) => setDraft({ ...draft, requestTimeoutMs: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>Temperature</span>
            <input
              min={0}
              max={1}
              step={0.1}
              type="number"
              value={draft.temperature}
              onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })}
            />
          </label>
        </div>

        {testResult ? (
          <div className={testResult.ok ? "translation-test-result is-ok" : "translation-test-result is-error"}>
            {testResult.ok ? `Connection ok: ${testResult.model} in ${testResult.elapsedMs}ms` : testResult.error}
          </div>
        ) : null}

        <footer>
          <button type="button" disabled={busy} onClick={onTest}>Test Connection</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onSave(draft, apiKey.trim() || undefined)}
          >
            Save
          </button>
        </footer>
      </section>
    </div>
  );
}

