import type {
  TranslationProviderTestResult,
  TranslationSecretSettings,
  TranslationSettings,
  TranslationTokenUsage
} from "../../shared/types/translation.js";

export interface TranslationProviderRequest {
  settings: TranslationSettings;
  secrets: TranslationSecretSettings;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}

export interface TranslationProviderResult {
  text: string;
  elapsedMs: number;
  tokenUsage?: TranslationTokenUsage;
}

export interface TranslationProvider {
  testConnection(settings: TranslationSettings, secrets: TranslationSecretSettings): Promise<TranslationProviderTestResult>;
  translate(input: TranslationProviderRequest): Promise<TranslationProviderResult>;
}

export class TranslationProviderError extends Error {
  readonly code: string;
  readonly elapsedMs: number;

  constructor(message: string, code: string, elapsedMs = 0) {
    super(message);
    this.name = "TranslationProviderError";
    this.code = code;
    this.elapsedMs = elapsedMs;
  }
}

export function createOpenAiCompatibleTranslationProvider(fetchImpl: typeof fetch = fetch): TranslationProvider {
  return {
    async testConnection(settings, secrets) {
      const startedAt = performance.now();
      try {
        await this.translate({
          settings,
          secrets,
          systemPrompt: "Reply with exactly: ok",
          userPrompt: "ok"
        });
        return {
          ok: true,
          model: settings.model,
          elapsedMs: Math.round(performance.now() - startedAt)
        };
      } catch (error) {
        return {
          ok: false,
          model: settings.model,
          elapsedMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : "Translation provider failed."
        };
      }
    },
    async translate(input) {
      const apiKey = input.secrets.apiKey?.trim();
      if (!apiKey) {
        throw new TranslationProviderError("Translation API key is not configured.", "config");
      }

      const startedAt = performance.now();
      const elapsed = () => Math.round(performance.now() - startedAt);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.settings.requestTimeoutMs);
      const externalAbort = () => controller.abort();
      if (input.signal) {
        if (input.signal.aborted) {
          controller.abort();
        } else {
          input.signal.addEventListener("abort", externalAbort, { once: true });
        }
      }

      try {
        const response = await fetchImpl(buildChatCompletionsUrl(input.settings.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: input.settings.model,
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: input.userPrompt }
            ],
            temperature: input.settings.temperature,
            stream: false
          }),
          signal: controller.signal
        });

        const rawText = await response.text();
        let payload: unknown = null;
        try {
          payload = rawText ? JSON.parse(rawText) : null;
        } catch {
          if (!response.ok) {
            throw new TranslationProviderError(rawText || response.statusText, `HTTP ${response.status}`, elapsed());
          }
          throw new TranslationProviderError("Translation provider returned invalid JSON.", "parse", elapsed());
        }

        if (!response.ok) {
          throw new TranslationProviderError(extractErrorMessage(payload) ?? response.statusText, `HTTP ${response.status}`, elapsed());
        }

        const content = extractContent(payload);
        if (!content) {
          throw new TranslationProviderError("Translation provider returned empty content.", "parse", elapsed());
        }

        return {
          text: content,
          elapsedMs: elapsed(),
          tokenUsage: parseOpenAiUsage((payload as { usage?: unknown } | null)?.usage)
        };
      } catch (error) {
        if (error instanceof TranslationProviderError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const code = message.toLowerCase().includes("abort") ? "timeout" : "network";
        throw new TranslationProviderError(message, code, elapsed());
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", externalAbort);
      }
    }
  };
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

export function parseOpenAiUsage(raw: unknown): TranslationTokenUsage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const usage = raw as Record<string, unknown>;
  const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : input + output;
  if (input === 0 && output === 0 && total === 0) {
    return undefined;
  }
  return { input, output, total };
}

function extractContent(payload: unknown): string | null {
  const choices = (payload as { choices?: unknown[] } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
  return typeof content === "string" ? content.trim() : null;
}

function extractErrorMessage(payload: unknown): string | null {
  const error = (payload as { error?: unknown } | null)?.error;
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    return error;
  }
  return (error as { message?: string }).message ?? JSON.stringify(error);
}

