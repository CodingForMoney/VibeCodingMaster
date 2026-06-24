import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  watch as fsWatch
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import type { Unsubscribe } from "../runtime/terminal-runtime.js";

export type ClaudeTranscriptContentKind =
  | "text"
  | "thinking"
  | "question"
  | "todo"
  | "agent"
  | "tool_use"
  | "tool_result";

export type ClaudeTranscriptStopReason =
  | "end_turn"
  | "tool_use"
  | "stop_sequence"
  | "max_tokens"
  | "pause_turn"
  | "refusal"
  | (string & {});

interface BaseTranscriptEvent {
  id: string;
  timestamp: string;
}

export interface RawQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface RawQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: RawQuestionOption[];
}

export interface RawQuestionPayload {
  questions: RawQuestion[];
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface RawTodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

export interface RawTodoPayload {
  todos: RawTodoItem[];
}

export interface RawAgentPayload {
  description: string;
  prompt: string;
  subagent_type: string;
}

export interface RawToolUsePayload {
  name: string;
  input: unknown;
}

export interface RawToolResultPayload {
  tool_use_id: string;
  content: unknown;
  isError: boolean;
}

export type ClaudeTranscriptEvent =
  | (BaseTranscriptEvent & {
      kind: "text";
      text: string;
      stopReason?: ClaudeTranscriptStopReason;
    })
  | (BaseTranscriptEvent & {
      kind: "thinking";
      text: string;
      stopReason?: ClaudeTranscriptStopReason;
    })
  | (BaseTranscriptEvent & {
      kind: "question";
      question: RawQuestionPayload;
    })
  | (BaseTranscriptEvent & {
      kind: "todo";
      todo: RawTodoPayload;
    })
  | (BaseTranscriptEvent & {
      kind: "agent";
      agent: RawAgentPayload;
    })
  | (BaseTranscriptEvent & {
      kind: "tool_use";
      toolUse: RawToolUsePayload;
    })
  | (BaseTranscriptEvent & {
      kind: "tool_result";
      toolResult: RawToolResultPayload;
    });

export type ClaudeTranscriptEventListener = (event: ClaudeTranscriptEvent) => void;

export interface ClaudeTranscriptService {
  subscribeToRoleSession(
    session: RoleSessionRecord,
    listener: ClaudeTranscriptEventListener,
    options?: ClaudeTranscriptSubscribeOptions
  ): Unsubscribe;
}

export interface ClaudeTranscriptSubscribeOptions {
  replayLastN?: number;
  replaySince?: string;
  onError?: (error: Error) => void;
  onTranscriptPathResolved?: (path: string) => void;
  onPoll?: (checkedAt: string) => void;
}

export interface TailHandlers {
  onContent: (event: ClaudeTranscriptEvent) => void;
  onError?: (err: Error) => void;
  onPoll?: (checkedAt: string) => void;
}

export interface TailOptions {
  replayLastN?: number;
  replaySince?: string;
  pollIntervalMs?: number;
}

const DEFAULT_TAIL_POLL_INTERVAL_MS = 1000;

/**
 * Adapted from CodingForMoney/cc-pm's transcript tailer.
 *
 * Claude Code writes semantic JSONL events under ~/.claude/projects. Tailing
 * those files is much more reliable than trying to infer answer boundaries
 * from the terminal TUI's raw PTY output.
 */
export class TranscriptTail {
  private offset = 0;
  private buffer = "";
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private flushScheduled = false;

  constructor(
    private readonly path: string,
    private readonly handlers: TailHandlers
  ) {}

  start(opts?: TailOptions): void {
    if (!existsSync(this.path)) {
      throw new Error(`transcript not found: ${this.path}`);
    }

    const stat = statSync(this.path);
    if (opts?.replaySince) {
      this.replaySince(opts.replaySince);
    } else if (opts?.replayLastN && opts.replayLastN > 0) {
      this.replayHistory(opts.replayLastN);
    }

    this.offset = stat.size;
    this.buffer = "";
    try {
      this.watcher = fsWatch(this.path, () => {
        this.scheduleFlush("watch");
      });
    } catch {
      this.watcher = null;
    }
    this.pollTimer = setInterval(() => {
      this.scheduleFlush("poll");
    }, opts?.pollIntervalMs ?? DEFAULT_TAIL_POLL_INTERVAL_MS);
    this.scheduleFlush("initial");
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleFlush(source: "initial" | "poll" | "watch"): void {
    if (this.flushing || this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flush(source);
    });
  }

  private flush(source: "initial" | "poll" | "watch"): void {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      const stat = statSync(this.path);
      if (source === "poll") {
        this.handlers.onPoll?.(new Date().toISOString());
      }
      if (stat.size < this.offset) {
        this.offset = stat.size;
        this.buffer = "";
        return;
      }
      if (stat.size === this.offset) {
        return;
      }

      const toRead = stat.size - this.offset;
      const fd = openSync(this.path, "r");
      try {
        const buf = Buffer.alloc(toRead);
        readSync(fd, buf, 0, toRead, this.offset);
        this.offset = stat.size;
        this.buffer += buf.toString("utf-8");
      } finally {
        closeSync(fd);
      }

      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) {
          this.tryEmit(line);
        }
      }
    } catch (error) {
      this.handlers.onError?.(error as Error);
    } finally {
      this.flushing = false;
    }
  }

  private replayHistory(n: number): void {
    try {
      const text = readFileSync(this.path, "utf-8");
      const events: ClaudeTranscriptEvent[] = [];
      for (const line of text.split("\n")) {
        if (line.trim()) {
          events.push(...parseAssistantContent(line));
        }
      }
      for (const event of events.slice(-n)) {
        this.handlers.onContent(event);
      }
    } catch (error) {
      this.handlers.onError?.(error as Error);
    }
  }

  private replaySince(replaySince: string): void {
    const sinceMs = Date.parse(replaySince);
    if (!Number.isFinite(sinceMs)) {
      return;
    }

    try {
      const text = readFileSync(this.path, "utf-8");
      for (const line of text.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        for (const event of parseAssistantContent(line)) {
          const eventMs = Date.parse(event.timestamp);
          if (Number.isFinite(eventMs) && eventMs >= sinceMs) {
            this.handlers.onContent(event);
          }
        }
      }
    } catch (error) {
      this.handlers.onError?.(error as Error);
    }
  }

  private tryEmit(line: string): void {
    for (const event of parseAssistantContent(line)) {
      this.handlers.onContent(event);
    }
  }
}

export function createClaudeTranscriptService(): ClaudeTranscriptService {
  return {
    subscribeToRoleSession(session, listener, options = {}) {
      let tail: TranscriptTail | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;

      const start = () => {
        if (stopped) {
          return;
        }
        const transcriptPath = resolveExistingClaudeTranscriptPath(session);
        if (!transcriptPath) {
          retryTimer = setTimeout(start, 500);
          return;
        }

        try {
          tail = new TranscriptTail(transcriptPath, {
            onContent: listener,
            onError: options.onError,
            onPoll: options.onPoll
          });
          tail.start({
            replayLastN: options.replayLastN,
            replaySince: options.replaySince
          });
          options.onTranscriptPathResolved?.(transcriptPath);
        } catch (error) {
          options.onError?.(error as Error);
          tail?.stop();
          tail = undefined;
          retryTimer = setTimeout(start, 500);
        }
      };

      start();

      return () => {
        stopped = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
        }
        tail?.stop();
      };
    }
  };
}

export function resolveExistingClaudeTranscriptPath(session: RoleSessionRecord): string | undefined {
  const sessionPath = existingFile(session.transcriptPath);
  if (sessionPath) {
    return sessionPath;
  }

  const cwdPath = existingFile(claudeTranscriptPath(session.cwd, session.claudeSessionId));
  if (cwdPath) {
    return cwdPath;
  }

  return findClaudeTranscriptPathBySessionId(session.claudeSessionId);
}

export function findClaudeTranscriptPathBySessionId(claudeSessionId: string): string | undefined {
  const root = claudeProjectsRoot();
  let projectDirs;
  try {
    projectDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const matches: Array<{ path: string; mtimeMs: number }> = [];
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const candidate = existingFile(join(root, dirent.name, `${claudeSessionId}.jsonl`));
    if (!candidate) {
      continue;
    }

    try {
      matches.push({ path: candidate, mtimeMs: statSync(candidate).mtimeMs });
    } catch {
      // Ignore files that disappear while scanning Claude's transcript folder.
    }
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path;
}

function existingFile(candidate: string | undefined): string | undefined {
  if (!candidate) {
    return undefined;
  }

  try {
    return statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function claudeProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export function projectHash(projectDir: string): string {
  return projectDir.replace(/[\/\s]+/g, "-");
}

export function projectsTranscriptDir(projectDir: string): string {
  return join(claudeProjectsRoot(), projectHash(projectDir));
}

export function claudeTranscriptPath(projectDir: string, claudeSessionId: string): string {
  return join(projectsTranscriptDir(projectDir), `${claudeSessionId}.jsonl`);
}

export function parseAssistantContent(line: string): ClaudeTranscriptEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }

  if (obj.type === "user") {
    return parseUserToolResults(obj);
  }

  if (obj.type !== "assistant") {
    return [];
  }

  const messageRecord = obj.message as Record<string, unknown> | undefined;
  if (messageRecord?.model === "<synthetic>") {
    return [];
  }

  const message = obj.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const questions: { id: string; payload: RawQuestionPayload }[] = [];
  const todos: { id: string; payload: RawTodoPayload }[] = [];
  const agents: { id: string; payload: RawAgentPayload }[] = [];
  const rawTools: { id: string; payload: RawToolUsePayload }[] = [];
  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString();
  const uuid = typeof obj.uuid === "string" ? obj.uuid : undefined;
  const rawStopReason = (message as Record<string, unknown> | undefined)?.stop_reason;
  const stopReason = typeof rawStopReason === "string" ? rawStopReason : undefined;

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
      thinkingParts.push(block.thinking);
      continue;
    }
    if (block.type !== "tool_use") {
      continue;
    }

    const toolId = typeof block.id === "string" ? block.id : undefined;
    const toolName = typeof block.name === "string" ? block.name : undefined;
    if (!toolId || !toolName) {
      continue;
    }
    if (toolName === "AskUserQuestion") {
      const payload = parseQuestionInput(block.input);
      if (payload) {
        questions.push({ id: toolId, payload });
      }
    } else if (toolName === "TodoWrite") {
      const payload = parseTodoInput(block.input);
      if (payload) {
        todos.push({ id: toolId, payload });
      }
    } else if (toolName === "Agent" || toolName === "Task") {
      const payload = parseAgentInput(block.input);
      if (payload) {
        agents.push({ id: toolId, payload });
      }
    } else {
      rawTools.push({
        id: toolId,
        payload: { name: toolName, input: block.input }
      });
    }
  }

  const out: ClaudeTranscriptEvent[] = [];
  if (textParts.length > 0) {
    const text = textParts.join("\n\n");
    out.push({
      kind: "text",
      timestamp,
      text,
      id: uuid ?? `${timestamp}-${text.slice(0, 16)}`,
      ...(stopReason !== undefined ? { stopReason } : {})
    });
  }
  if (thinkingParts.length > 0) {
    const text = thinkingParts.join("\n\n");
    out.push({
      kind: "thinking",
      timestamp,
      text,
      id: uuid ? `${uuid}#thinking` : `${timestamp}-thinking-${text.slice(0, 16)}`,
      ...(stopReason !== undefined ? { stopReason } : {})
    });
  }

  for (const question of questions) {
    out.push({
      kind: "question",
      timestamp,
      id: question.id,
      question: question.payload
    });
  }
  for (const todo of todos) {
    out.push({
      kind: "todo",
      timestamp,
      id: todo.id,
      todo: todo.payload
    });
  }
  for (const agent of agents) {
    out.push({
      kind: "agent",
      timestamp,
      id: agent.id,
      agent: agent.payload
    });
  }
  for (const tool of rawTools) {
    out.push({
      kind: "tool_use",
      timestamp,
      id: tool.id,
      toolUse: tool.payload
    });
  }

  return out;
}

function parseUserToolResults(obj: Record<string, unknown>): ClaudeTranscriptEvent[] {
  const message = obj.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString();
  const out: ClaudeTranscriptEvent[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }
    out.push({
      kind: "tool_result",
      timestamp,
      id: `${toolUseId}#result`,
      toolResult: {
        tool_use_id: toolUseId,
        content: block.content,
        isError: block.is_error === true
      }
    });
  }
  return out;
}

function parseQuestionInput(raw: unknown): RawQuestionPayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rawQuestions = (raw as Record<string, unknown>).questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return null;
  }

  const questions: RawQuestion[] = [];
  for (const rawQuestion of rawQuestions) {
    if (!rawQuestion || typeof rawQuestion !== "object") {
      continue;
    }
    const questionRecord = rawQuestion as Record<string, unknown>;
    const rawOptions = questionRecord.options;
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
      continue;
    }

    const options: RawQuestionOption[] = [];
    for (const rawOption of rawOptions) {
      if (!rawOption || typeof rawOption !== "object") {
        continue;
      }
      const optionRecord = rawOption as Record<string, unknown>;
      const option: RawQuestionOption = {
        label: typeof optionRecord.label === "string" ? optionRecord.label : "",
        description: typeof optionRecord.description === "string" ? optionRecord.description : ""
      };
      if (typeof optionRecord.preview === "string") {
        option.preview = optionRecord.preview;
      }
      options.push(option);
    }

    if (options.length > 0) {
      questions.push({
        question: typeof questionRecord.question === "string" ? questionRecord.question : "",
        header: typeof questionRecord.header === "string" ? questionRecord.header : "",
        multiSelect: questionRecord.multiSelect === true,
        options
      });
    }
  }

  return questions.length > 0 ? { questions } : null;
}

function parseTodoInput(raw: unknown): RawTodoPayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rawTodos = (raw as Record<string, unknown>).todos;
  if (!Array.isArray(rawTodos) || rawTodos.length === 0) {
    return null;
  }

  const todos: RawTodoItem[] = [];
  for (const rawTodo of rawTodos) {
    if (!rawTodo || typeof rawTodo !== "object") {
      continue;
    }
    const todoRecord = rawTodo as Record<string, unknown>;
    const content = typeof todoRecord.content === "string" ? todoRecord.content : "";
    const activeForm = typeof todoRecord.activeForm === "string" ? todoRecord.activeForm : "";
    const rawStatus = todoRecord.status;
    const status: TodoStatus = rawStatus === "in_progress" || rawStatus === "completed"
      ? rawStatus
      : "pending";
    if (content || activeForm) {
      todos.push({ content, activeForm, status });
    }
  }

  return todos.length > 0 ? { todos } : null;
}

function parseAgentInput(raw: unknown): RawAgentPayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description : "";
  const prompt = typeof record.prompt === "string" ? record.prompt : "";
  const subagent_type = typeof record.subagent_type === "string" ? record.subagent_type : "";
  if (!description && !prompt) {
    return null;
  }
  return { description, prompt, subagent_type };
}
