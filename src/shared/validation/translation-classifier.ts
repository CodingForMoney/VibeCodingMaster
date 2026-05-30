import type { TranslationSourceKind } from "../types/translation.js";
import { shouldSkipForTargetLanguage } from "./language-detect.js";

export interface ClassifiedTranslationChunk {
  sourceKind: TranslationSourceKind;
  text: string;
  reason?: string;
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)\b/i;

export function stripAnsiForTranslation(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(/\r/g, "");
}

export function containsSensitiveToken(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

export function classifyTranslationChunk(value: string, targetLanguage: string): ClassifiedTranslationChunk {
  const text = stripAnsiForTranslation(value).trim();
  if (!text) {
    return { sourceKind: "already-target-language", text, reason: "empty" };
  }

  if (containsSensitiveToken(text)) {
    return { sourceKind: "sensitive", text, reason: "possible secret" };
  }

  if (shouldSkipForTargetLanguage(text, targetLanguage)) {
    return { sourceKind: "already-target-language", text, reason: "target language" };
  }

  if (isPermissionPrompt(text)) {
    return { sourceKind: "permission-prompt", text };
  }

  if (isDiff(text)) {
    return { sourceKind: "diff", text };
  }

  if (isCode(text)) {
    return { sourceKind: "code", text };
  }

  if (isToolOutput(text)) {
    return { sourceKind: "tool-output", text };
  }

  if (isStackTraceOrError(text)) {
    return { sourceKind: "error", text };
  }

  if (isLogLike(text)) {
    return { sourceKind: "log", text };
  }

  return { sourceKind: "prose", text };
}

export function shouldTranslateSourceKind(kind: TranslationSourceKind): boolean {
  return kind === "prose" || kind === "error";
}

export function shouldSummarizeSourceKind(kind: TranslationSourceKind): boolean {
  return kind === "log" || kind === "tool-output";
}

export function shouldPreserveSourceKind(kind: TranslationSourceKind): boolean {
  return kind === "code" || kind === "diff" || kind === "permission-prompt";
}

function isPermissionPrompt(text: string): boolean {
  return /(?:allow|approve|permission|permissions|accept edits|yes\/no|y\/n|confirm|是否允许|权限)/i.test(text);
}

function isDiff(text: string): boolean {
  return /^diff --git /m.test(text) || /^@@ .+ @@/m.test(text) || /^[+-]{3} /m.test(text);
}

function isCode(text: string): boolean {
  if (/```/.test(text)) {
    return true;
  }

  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length < 2) {
    return false;
  }

  const codeLike = lines.filter((line) =>
    /^\s*(?:import|export|const|let|var|function|class|interface|type|if|for|while|return|<\/?[A-Za-z]|[{}[\]();]|#include|def |async def )/.test(line)
  );
  return codeLike.length / lines.length >= 0.55;
}

function isToolOutput(text: string): boolean {
  return /^●\s*\w+\(/m.test(text) || /^\s*⎿\s+/m.test(text) || /\b(?:Bash|Read|Edit|Write|Grep|Glob)\(/.test(text);
}

function isStackTraceOrError(text: string): boolean {
  return /(?:Error:|Exception|Traceback \(most recent call last\)|^\s*at .+\(.+:\d+:\d+\)|npm ERR!|failed|失败)/m.test(text);
}

function isLogLike(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length >= 8) {
    return true;
  }

  return lines.length >= 3 && lines.some((line) => /^\[[^\]]+\]|\d{4}-\d{2}-\d{2}|^\s*(?:PASS|FAIL|WARN|INFO|DEBUG)\b/.test(line));
}

