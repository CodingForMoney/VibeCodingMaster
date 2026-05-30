import type { RoleName } from "./role.js";

export type TranslationProviderType = "openai-compatible";

export type TranslationDirection =
  | "user-input-to-english"
  | "cc-output-to-user";

export type TranslationInputMode =
  | "review-before-send"
  | "auto-send";

export type TranslationPromptKey =
  | "zh-to-en"
  | "zh-to-en-with-context"
  | "en-to-zh";

export const TRANSLATION_PROMPT_KEYS: readonly TranslationPromptKey[] = [
  "zh-to-en",
  "zh-to-en-with-context",
  "en-to-zh"
] as const;

export type TranslationSourceKind =
  | "prose"
  | "code"
  | "diff"
  | "log"
  | "tool-output"
  | "permission-prompt"
  | "error"
  | "already-target-language"
  | "sensitive";

export type TranslationStatus =
  | "queued"
  | "translating"
  | "translated"
  | "skipped"
  | "failed"
  | "redacted"
  | "summarized"
  | "preserved";

export interface TranslationSettings {
  version: 1;
  enabled: boolean;
  providerType: TranslationProviderType;
  baseUrl: string;
  apiKey?: string;
  model: string;
  sourceLanguage: "auto" | string;
  targetLanguage: string;
  workingLanguage: "en";
  inputMode: TranslationInputMode;
  translateOutput: boolean;
  translateUserInput: boolean;
  contextEnabled: boolean;
  preserveTechnicalTokens: boolean;
  skipCjkText: boolean;
  redactSecrets: boolean;
  maxChunkChars: number;
  requestTimeoutMs: number;
  temperature: number;
  prompts?: Partial<Record<TranslationPromptKey, string>>;
}

export interface TranslationSecretSettings {
  apiKey?: string;
}

export interface TranslationTokenUsage {
  input: number;
  output: number;
  total?: number;
}

export interface TranslationEntry {
  id: string;
  taskSlug: string;
  role: RoleName;
  direction: TranslationDirection;
  sourceKind: TranslationSourceKind;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  translatedText: string;
  status: TranslationStatus;
  contextUsed: boolean;
  warning?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
  provider: TranslationProviderType;
  model: string;
  tokenUsage?: TranslationTokenUsage;
}

export interface TranslateUserInputRequest {
  text: string;
  mode?: TranslationInputMode;
  useContext?: boolean;
  send?: boolean;
}

export interface TranslateUserInputResult {
  translation: TranslationEntry;
  englishPreview: string;
  contextUsed: boolean;
  requiresReview: boolean;
  sent: boolean;
}

export interface SendTranslatedInputRequest {
  englishText: string;
}

export interface TranslationProviderTestResult {
  ok: boolean;
  model: string;
  elapsedMs: number;
  error?: string;
}

export interface TranslationPromptPreview {
  key: TranslationPromptKey;
  label: string;
  defaultPrompt: string;
  userPrompt: string;
  customized: boolean;
}

export type TranslationWsMessage =
  | { type: "translation-entry"; entry: TranslationEntry }
  | { type: "translation-status"; status: "ready" | "paused" | "translating" | "failed" }
  | { type: "translation-error"; id?: string; message: string };
