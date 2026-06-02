import type { TerminalRuntime } from "./terminal-runtime.js";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const DEFAULT_ENTER_DELAY_MS = 75;

export interface SubmitTerminalInputOptions {
  enterDelayMs?: number;
}

export async function submitTerminalInput(
  runtime: Pick<TerminalRuntime, "write">,
  sessionId: string,
  text: string,
  options: SubmitTerminalInputOptions = {}
): Promise<void> {
  runtime.write(sessionId, formatTerminalPaste(text));
  await delay(options.enterDelayMs ?? DEFAULT_ENTER_DELAY_MS);
  runtime.write(sessionId, "\r");
}

export function formatTerminalPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${normalizeTerminalSubmitText(text)}${BRACKETED_PASTE_END}`;
}

export function normalizeTerminalSubmitText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/g, "");
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}
