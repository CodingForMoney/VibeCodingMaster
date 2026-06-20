import { useEffect, useState } from "react";
import type { TranslationSettings } from "../../shared/types/translation.js";

export interface TranslationSettingsModalProps {
  settings: TranslationSettings;
  busy?: boolean;
  onSave(settings: Partial<TranslationSettings>, apiKey?: string): Promise<void>;
  onClose(): void;
}

export function TranslationSettingsModal({
  settings,
  busy = false,
  onSave,
  onClose
}: TranslationSettingsModalProps) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  return (
    <div className="modal-backdrop">
      <section className="translation-settings-modal" role="dialog" aria-modal="true" aria-label="Translation Settings">
        <header>
          <div>
            <h2>Translation Settings</h2>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <div className="translation-settings-grid">
          <label>
            <span>Target language</span>
            <input
              value={draft.targetLanguage}
              onChange={(event) => setDraft({ ...draft, targetLanguage: event.target.value })}
            />
          </label>
          <label>
            <span>Source language</span>
            <input
              value={draft.sourceLanguage}
              onChange={(event) => setDraft({ ...draft, sourceLanguage: event.target.value })}
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
        </div>

        <footer>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onSave({
              targetLanguage: draft.targetLanguage,
              sourceLanguage: draft.sourceLanguage,
              contextEnabled: draft.contextEnabled,
              requestTimeoutMs: draft.requestTimeoutMs,
              enabled: true,
              translateOutput: true,
              translateUserInput: true,
              inputMode: "review-before-send"
            })}
          >
            Save
          </button>
        </footer>
      </section>
    </div>
  );
}
