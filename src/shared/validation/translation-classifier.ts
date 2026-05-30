import type { TranslationSourceKind } from "../types/translation.js";
import { shouldSkipForTargetLanguage } from "./language-detect.js";

export interface ClassifiedTranslationChunk {
  sourceKind: TranslationSourceKind;
  text: string;
  reason?: string;
}

const CSI_ANSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const CURSOR_FORWARD_PATTERN = /(?:\u001b\[|\u009b)(\d*)C/g;
const OSC_ANSI_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const SIMPLE_ESCAPE_PATTERN = /\u001b[=>M78]|\u001b[()][A-Za-z0-9]/g;
const SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)\b/i;

export function stripAnsiForTranslation(value: string): string {
  let text = value
    .replace(OSC_ANSI_PATTERN, "")
    .replace(CURSOR_FORWARD_PATTERN, (_match, count: string) => " ".repeat(Number(count || "1")))
    .replace(CSI_ANSI_PATTERN, "")
    .replace(SIMPLE_ESCAPE_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  while (/[^\n]\u0008/.test(text)) {
    text = text.replace(/[^\n]\u0008/g, "");
  }

  return text.replace(/\u0008/g, "");
}

export function cleanClaudeOutputForTranslation(value: string): string {
  const lines = stripAnsiForTranslation(value).split("\n");
  const kept: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/g, "");
    const trimmed = line.trim();
    if (!trimmed) {
      appendBlankLine(kept);
      continue;
    }

    if (isClaudeCodeNoiseLine(trimmed)) {
      continue;
    }

    kept.push(unboxClaudeCodeLine(line));
  }

  return collapseBlankLines(kept).trim();
}

export function containsSensitiveToken(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

export function classifyTranslationChunk(value: string, targetLanguage: string): ClassifiedTranslationChunk {
  const text = cleanClaudeOutputForTranslation(value);
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
  const logLikeLines = lines.filter((line) =>
    /^\[[^\]]+\]|\d{4}-\d{2}-\d{2}|^\s*(?:PASS|FAIL|WARN|INFO|DEBUG|ERROR)\b/.test(line)
  );
  if (logLikeLines.length >= 2) {
    return true;
  }

  return lines.length >= 8 && logLikeLines.length / lines.length >= 0.25;
}

function appendBlankLine(lines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }
}

function collapseBlankLines(lines: string[]): string {
  const collapsed: string[] = [];
  for (const line of lines) {
    if (!line.trim() && (!collapsed.length || !collapsed[collapsed.length - 1]?.trim())) {
      continue;
    }
    collapsed.push(line);
  }
  return collapsed.join("\n");
}

function isClaudeCodeNoiseLine(trimmed: string): boolean {
  const unboxed = trimmed.replace(/^[│┃|]\s*/u, "").replace(/\s*[│┃|]$/u, "").trim();
  if (isBoxDrawingLine(trimmed)) {
    return true;
  }

  if (/^(?:[●⏺]\s*)?(?:Bash|Read|Edit|Write|Grep|Glob|LS|Task|TodoWrite|MultiEdit|NotebookEdit|WebFetch|WebSearch)\(/i.test(unboxed)) {
    return true;
  }

  if (/^⎿/.test(unboxed)) {
    return true;
  }

  if (/^(?:esc to interrupt|ctrl-c|shift\+tab|accept edits|auto-accept|edit permissions)/i.test(unboxed)) {
    return true;
  }

  if (/^>\s*$/.test(unboxed)) {
    return true;
  }

  if (/^(?:[✻✽✢·*]\s*)?(?:Working|Thinking|Reading|Writing|Searching|Loading|Compiling|Checking|Running|Updating)\.{0,3}$/i.test(unboxed)) {
    return true;
  }

  return false;
}

function isBoxDrawingLine(trimmed: string): boolean {
  return /^[╭╮╰╯─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬\s]+$/.test(trimmed);
}

function unboxClaudeCodeLine(line: string): string {
  if (!/^\s*[│┃]/u.test(line) && !/[│┃]\s*$/u.test(line)) {
    return line;
  }

  return line.trim().replace(/^[│┃]\s*/u, "").replace(/\s*[│┃]$/u, "");
}
