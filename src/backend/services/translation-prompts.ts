import type {
  TranslationDirection,
  TranslationPromptKey,
  TranslationPromptPreview,
  TranslationSourceKind,
  TranslationSettings
} from "../../shared/types/translation.js";
import { TRANSLATION_PROMPT_KEYS } from "../../shared/types/translation.js";

export interface TranslationPromptInput {
  direction: TranslationDirection;
  text: string;
  contextText?: string;
  sourceKind?: TranslationSourceKind;
  settings: TranslationSettings;
}

export interface BuiltTranslationPrompt {
  systemPrompt: string;
  userPrompt: string;
  parseWarning: boolean;
}

const PRESERVE_RULES = `Preserve verbatim:
- code blocks, inline code, identifiers, function names, type names, module names, package names
- file paths, glob patterns, URLs, branch names, tags, commit hashes, version strings
- shell commands, command flags, environment variable names, git refs
- quoted error messages, stack traces, logs, diffs, numbers, units

Translate only the surrounding prose. Output only the requested translation or summary.`;

const PROMPT_LABELS: Record<TranslationPromptKey, string> = {
  "zh-to-en": "zh-to-en",
  "zh-to-en-with-context": "zh-to-en-with-context",
  "en-to-zh": "en-to-zh"
};

export function buildTranslationPrompt(input: TranslationPromptInput): BuiltTranslationPrompt {
  const key = getTranslationPromptKey(input);

  if (input.direction === "user-input-to-english") {
    if (key === "zh-to-en-with-context") {
      return {
        systemPrompt: resolveTranslationSystemPrompt(key, input.settings),
        userPrompt: `[PRIOR CLAUDE CODE REPLY]\n${input.contextText}\n\n[NEW USER INPUT - translate only this]\n${input.text}`,
        parseWarning: true
      };
    }

    return {
      systemPrompt: resolveTranslationSystemPrompt(key, input.settings),
      userPrompt: input.text,
      parseWarning: false
    };
  }

  return {
    systemPrompt: resolveTranslationSystemPrompt(key, input.settings, input.sourceKind),
    userPrompt: input.text,
    parseWarning: false
  };
}

export function getTranslationPromptKey(input: {
  direction: TranslationDirection;
  contextText?: string;
}): TranslationPromptKey {
  if (input.direction === "user-input-to-english") {
    return input.contextText?.trim()
      ? "zh-to-en-with-context"
      : "zh-to-en";
  }
  return "en-to-zh";
}

export function getBaseTranslationPrompt(
  key: TranslationPromptKey,
  settings: TranslationSettings,
  sourceKind: TranslationSourceKind = "prose"
): string {
  if (key === "zh-to-en") {
    return `You translate a developer's message for Claude Code into clear, concise, professional technical English.

${PRESERVE_RULES}`;
  }

  if (key === "zh-to-en-with-context") {
    return `You translate a developer's message for Claude Code into clear technical English.

Use the prior Claude Code reply only to disambiguate references such as "continue", "that file", or "as you said".
Do not copy facts from the prior reply into the translation unless the new user input clearly refers to them.

Output format:
OK

<English translation>

If the new input is likely ambiguous or contradictory in context, output:
WARN: <short warning in the user's language>

<English translation>

${PRESERVE_RULES}`;
  }

  const targetLanguage = settings.targetLanguage || "the user's language";
  const outputInstruction = sourceKind === "error"
    ? "Explain the prose in the target language, but preserve the exact error text."
    : "Translate the prose faithfully and naturally.";

  return `You translate Claude Code output for a software engineer into ${targetLanguage}.

Source kind: ${sourceKind}.
${outputInstruction}
${PRESERVE_RULES}`;
}

export function resolveTranslationSystemPrompt(
  key: TranslationPromptKey,
  settings: TranslationSettings,
  sourceKind: TranslationSourceKind = "prose"
): string {
  const override = settings.prompts?.[key];
  return override?.trim() ? override : getBaseTranslationPrompt(key, settings, sourceKind);
}

export function getTranslationPromptPreviews(settings: TranslationSettings): TranslationPromptPreview[] {
  return TRANSLATION_PROMPT_KEYS.map((key) => {
    const defaultPrompt = getBaseTranslationPrompt(key, settings);
    const userPrompt = settings.prompts?.[key]?.trim() ? settings.prompts[key] ?? "" : "";
    return {
      key,
      label: PROMPT_LABELS[key],
      defaultPrompt,
      userPrompt,
      customized: Boolean(userPrompt)
    };
  });
}

export function parseTranslationWarning(raw: string): { warning?: string; text: string } {
  const trimmed = raw.trim();
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    return { text: trimmed };
  }

  const firstLine = trimmed.slice(0, firstNewline).trim();
  const rest = trimmed.slice(firstNewline + 1).trim();
  if (firstLine === "OK") {
    return { text: rest };
  }
  if (firstLine.startsWith("WARN:")) {
    const warning = firstLine.slice("WARN:".length).trim();
    return warning ? { warning, text: rest } : { text: rest };
  }
  return { text: trimmed };
}
