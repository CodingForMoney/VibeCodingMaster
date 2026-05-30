import type {
  TranslationDirection,
  TranslationSourceKind,
  TranslationSettings
} from "../../shared/types/translation.js";

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

export function buildTranslationPrompt(input: TranslationPromptInput): BuiltTranslationPrompt {
  if (input.direction === "user-input-to-english") {
    if (input.contextText?.trim()) {
      return {
        systemPrompt: `You translate a developer's message for Claude Code into clear technical English.

Use the prior Claude Code reply only to disambiguate references such as "continue", "that file", or "as you said".
Do not copy facts from the prior reply into the translation unless the new user input clearly refers to them.

Output format:
OK

<English translation>

If the new input is likely ambiguous or contradictory in context, output:
WARN: <short warning in the user's language>

<English translation>

${PRESERVE_RULES}`,
        userPrompt: `[PRIOR CLAUDE CODE REPLY]\n${input.contextText}\n\n[NEW USER INPUT - translate only this]\n${input.text}`,
        parseWarning: true
      };
    }

    return {
      systemPrompt: `You translate a developer's message for Claude Code into clear, concise, professional technical English.

${PRESERVE_RULES}`,
      userPrompt: input.text,
      parseWarning: false
    };
  }

  const targetLanguage = input.settings.targetLanguage || "the user's language";
  const sourceKind = input.sourceKind ?? "prose";
  const outputInstruction = sourceKind === "error"
    ? "Explain the prose in the target language, but preserve the exact error text."
    : "Translate the prose faithfully and naturally.";

  return {
    systemPrompt: `You translate Claude Code output for a software engineer into ${targetLanguage}.

Source kind: ${sourceKind}.
${outputInstruction}
${PRESERVE_RULES}`,
    userPrompt: input.text,
    parseWarning: false
  };
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

