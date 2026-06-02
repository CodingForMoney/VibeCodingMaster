import { useEffect, useState } from "react";
import type {
  TranslationPromptKey,
  TranslationPromptPreview,
  TranslationProviderTestResult,
  TranslationSettings
} from "../../shared/types/translation.js";

export interface TranslationSettingsModalProps {
  settings: TranslationSettings;
  busy?: boolean;
  promptPreviews: TranslationPromptPreview[];
  testResult?: TranslationProviderTestResult;
  onSave(settings: Partial<TranslationSettings>, apiKey?: string): Promise<void>;
  onTest(): Promise<void>;
  onClose(): void;
}

export function TranslationSettingsModal({
  settings,
  busy = false,
  promptPreviews,
  testResult,
  onSave,
  onTest,
  onClose
}: TranslationSettingsModalProps) {
  const [draft, setDraft] = useState(settings);
  const [apiKey, setApiKey] = useState(settings.apiKey ?? "");

  useEffect(() => {
    setDraft(settings);
    setApiKey(settings.apiKey ?? "");
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
              placeholder="API key"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              type="text"
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
            <span>Use context</span>
            <input
              checked={draft.contextEnabled}
              type="checkbox"
              onChange={(event) => setDraft({ ...draft, contextEnabled: event.target.checked })}
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

        <section className="translation-prompt-settings">
          <header>
            <div>
              <h3>Translation Prompts</h3>
              <p>Edit the three cc-pm style prompt slots directly.</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDraft({ ...draft, prompts: undefined })}
            >
              Reset prompts
            </button>
          </header>

          <div className="translation-prompt-stack">
            {promptPreviews.map((preview) => (
              <label key={preview.key}>
                <span>{preview.label}</span>
                <textarea
                  value={getPromptValue(draft, preview)}
                  onChange={(event) => setDraft({
                    ...draft,
                    prompts: updatePromptOverride(draft.prompts, preview.key, event.target.value, preview.defaultPrompt)
                  })}
                />
              </label>
            ))}
          </div>
        </section>

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
            onClick={() => void onSave({
              ...draft,
              enabled: true,
              translateOutput: true,
              translateUserInput: true,
              inputMode: "review-before-send"
            }, apiKey.trim())}
          >
            Save
          </button>
        </footer>
      </section>
    </div>
  );
}

function updatePromptOverride(
  prompts: TranslationSettings["prompts"],
  key: TranslationPromptKey,
  value: string,
  defaultPrompt: string
): TranslationSettings["prompts"] {
  const next = { ...(prompts ?? {}) };
  if (value.trim() && value !== defaultPrompt) {
    next[key] = value;
  } else {
    delete next[key];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function getPromptValue(settings: TranslationSettings, preview: TranslationPromptPreview): string {
  return settings.prompts?.[preview.key] ?? preview.defaultPrompt;
}
