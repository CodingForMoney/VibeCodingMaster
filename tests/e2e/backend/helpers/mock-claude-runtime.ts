import { mkdir, appendFile, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { ClaudeHookEventName, ClaudeHookRequest } from "../../../../src/shared/types/claude-hook.js";
import type { RoleName } from "../../../../src/shared/types/role.js";
import type { TerminalEvent } from "../../../../src/shared/types/terminal.js";
import type {
  CreateTerminalSessionInput,
  SubscribeTerminalOptions,
  TerminalEventListener,
  TerminalProcessExitListener,
  TerminalRuntime,
  TerminalSession,
  Unsubscribe
} from "../../../../src/backend/runtime/terminal-runtime.js";
import { VcmError } from "../../../../src/backend/errors.js";

type PromptMatcher = RegExp | string | ((prompt: string, session: TerminalSession) => boolean);
type MockClaudeScenarioHandler = (ctx: MockClaudePromptContext) => Promise<void> | void;
type HookDispatcher = (input: ClaudeHookRequest, options: { stopEndpoint: boolean }) => Promise<unknown>;

interface RuntimeEntry {
  input: CreateTerminalSessionInput;
  session: TerminalSession;
  listeners: Set<TerminalEventListener>;
  replayBuffer: string;
  writes: string[];
  pendingPaste?: string;
  claudeSessionId: string;
  transcriptPath: string;
}

interface MockClaudeScenario {
  role: RoleName;
  matcher: PromptMatcher;
  handler: MockClaudeScenarioHandler;
  used: number;
  once: boolean;
}

export interface MockClaudeRuntimeOptions {
  transcriptRoot: string;
  now?: () => string;
}

export class MockClaudeRuntime implements TerminalRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly processExitListeners = new Set<TerminalProcessExitListener>();
  private readonly scenarios: MockClaudeScenario[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly now: () => string;
  private hookDispatcher: HookDispatcher | undefined;
  private sessionSeq = 0;
  private eventSeq = 0;
  private transcriptSeq = 0;

  constructor(private readonly options: MockClaudeRuntimeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  setHookDispatcher(dispatcher: HookDispatcher): void {
    this.hookDispatcher = dispatcher;
  }

  onPrompt(role: RoleName, matcher: PromptMatcher, handler: MockClaudeScenarioHandler, options: { once?: boolean } = {}): void {
    this.scenarios.push({
      role,
      matcher,
      handler,
      used: 0,
      once: options.once ?? true
    });
  }

  getWrites(sessionId: string): string[] {
    return [...this.getEntry(sessionId).writes];
  }

  getCreateInput(sessionId: string): CreateTerminalSessionInput {
    return this.getEntry(sessionId).input;
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  async createSession(input: CreateTerminalSessionInput): Promise<TerminalSession> {
    const seq = ++this.sessionSeq;
    const id = `mock-terminal-${seq}`;
    const claudeSessionId = `mock-claude-${input.role}-${seq}`;
    const transcriptPath = path.join(this.options.transcriptRoot, `${claudeSessionId}.jsonl`);
    const startedAt = this.now();
    const session: TerminalSession = {
      id,
      repoRoot: input.repoRoot,
      taskSlug: input.taskSlug,
      role: input.role,
      status: "running",
      pid: 20_000 + seq,
      startedAt,
      lastOutputAt: startedAt,
      exitCode: null
    };
    this.entries.set(id, {
      input,
      session,
      listeners: new Set(),
      replayBuffer: "",
      writes: [],
      claudeSessionId,
      transcriptPath
    });
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, "", "utf8");
    return { ...session };
  }

  getSession(sessionId: string): TerminalSession | undefined {
    const entry = this.entries.get(sessionId);
    return entry ? { ...entry.session } : undefined;
  }

  getSessionByRole(taskSlug: string, role: RoleName): TerminalSession | undefined {
    for (const entry of this.entries.values()) {
      if (entry.session.taskSlug === taskSlug && entry.session.role === role) {
        return { ...entry.session };
      }
    }
    return undefined;
  }

  listSessions(taskSlug?: string): TerminalSession[] {
    return [...this.entries.values()]
      .filter((entry) => !taskSlug || entry.session.taskSlug === taskSlug)
      .map((entry) => ({ ...entry.session }));
  }

  write(sessionId: string, data: string): void {
    const entry = this.getEntry(sessionId);
    entry.writes.push(data);
    this.emit(entry, { type: "input", data });
    if (isBracketedPaste(data)) {
      entry.pendingPaste = normalizeTerminalWrite(data);
      return;
    }
    const prompt = isEnter(data)
      ? entry.pendingPaste
      : normalizeTerminalWrite(data);
    if (isEnter(data)) {
      entry.pendingPaste = undefined;
    }
    if (!prompt) {
      return;
    }
    const task = this.runPrompt(entry, prompt);
    this.pending.add(task);
    task.finally(() => {
      this.pending.delete(task);
    }).catch(() => undefined);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    void sessionId;
    void cols;
    void rows;
  }

  async stop(sessionId: string): Promise<void> {
    const entry = this.getEntry(sessionId);
    entry.session.status = "exited";
    entry.session.exitCode = 0;
    this.entries.delete(sessionId);
    this.emit(entry, { type: "exit", exitCode: 0 });
    entry.listeners.clear();
  }

  async restart(sessionId: string): Promise<TerminalSession> {
    const entry = this.getEntry(sessionId);
    const input = entry.input;
    const seq = ++this.sessionSeq;
    const claudeSessionId = `mock-claude-${input.role}-${seq}`;
    const transcriptPath = path.join(this.options.transcriptRoot, `${claudeSessionId}.jsonl`);
    const startedAt = this.now();
    entry.writes.length = 0;
    entry.pendingPaste = undefined;
    entry.claudeSessionId = claudeSessionId;
    entry.transcriptPath = transcriptPath;
    entry.session = {
      id: sessionId,
      repoRoot: input.repoRoot,
      taskSlug: input.taskSlug,
      role: input.role,
      status: "running",
      pid: 20_000 + seq,
      startedAt,
      lastOutputAt: startedAt,
      exitCode: null
    };
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, "", "utf8");
    return { ...entry.session };
  }

  subscribe(sessionId: string, listener: TerminalEventListener, options: SubscribeTerminalOptions = {}): Unsubscribe {
    const entry = this.getEntry(sessionId);
    entry.listeners.add(listener);
    if (options.replay !== false && entry.replayBuffer) {
      listener(this.buildEvent(entry, { type: "output", data: entry.replayBuffer }));
    }
    return () => {
      entry.listeners.delete(listener);
    };
  }

  subscribeProcessExits(listener: TerminalProcessExitListener): Unsubscribe {
    this.processExitListeners.add(listener);
    return () => {
      this.processExitListeners.delete(listener);
    };
  }

  exitProcess(sessionId: string, exitCode = 1): void {
    const entry = this.getEntry(sessionId);
    entry.session.status = exitCode === 0 ? "exited" : "crashed";
    entry.session.exitCode = exitCode;
    this.entries.delete(sessionId);
    for (const listener of this.processExitListeners) {
      listener({
        session: { ...entry.session },
        exitCode
      });
    }
    this.emit(entry, { type: "exit", exitCode });
    entry.listeners.clear();
  }

  private async runPrompt(entry: RuntimeEntry, prompt: string): Promise<void> {
    const scenario = this.scenarios.find((candidate) =>
      candidate.role === entry.session.role &&
      (!candidate.once || candidate.used === 0) &&
      matchesPrompt(candidate.matcher, prompt, entry.session)
    );
    if (!scenario) {
      await this.writeOutput(entry, `[mock Claude] no scenario matched ${entry.session.role} prompt\n`);
      return;
    }
    scenario.used += 1;
    const ctx = new MockClaudePromptContext(this, entry, prompt);
    await scenario.handler(ctx);
  }

  async dispatchHook(entry: RuntimeEntry, eventName: ClaudeHookEventName, extra: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.hookDispatcher) {
      throw new Error("MockClaudeRuntime hook dispatcher is not configured.");
    }
    const input: ClaudeHookRequest = {
      taskSlug: entry.session.taskSlug,
      role: entry.session.role,
      runtimeSessionToken: entry.input.env?.VCM_RUNTIME_SESSION_TOKEN,
      event: {
        hook_event_name: eventName,
        session_id: entry.claudeSessionId,
        transcript_path: entry.transcriptPath,
        cwd: entry.input.cwd,
        ...extra
      }
    };
    return this.hookDispatcher(input, { stopEndpoint: eventName === "Stop" });
  }

  async appendTranscriptText(entry: RuntimeEntry, text: string, stopReason = "end_turn"): Promise<void> {
    await mkdir(path.dirname(entry.transcriptPath), { recursive: true });
    const line = JSON.stringify({
      type: "assistant",
      uuid: `mock-transcript-${++this.transcriptSeq}`,
      timestamp: this.now(),
      message: {
        stop_reason: stopReason,
        content: [{ type: "text", text }]
      }
    });
    await appendFile(entry.transcriptPath, `${line}\n`, "utf8");
  }

  async writeOutput(entry: RuntimeEntry, data: string): Promise<void> {
    entry.session.lastOutputAt = this.now();
    entry.replayBuffer += data;
    this.emit(entry, { type: "output", data });
  }

  private emit(entry: RuntimeEntry, event: Omit<TerminalEvent, "id" | "timestamp" | "sessionId" | "taskSlug" | "role">): void {
    const terminalEvent = this.buildEvent(entry, event);
    for (const listener of entry.listeners) {
      listener(terminalEvent);
    }
  }

  private buildEvent(
    entry: RuntimeEntry,
    event: Omit<TerminalEvent, "id" | "timestamp" | "sessionId" | "taskSlug" | "role">
  ): TerminalEvent {
    return {
      id: `mock-terminal-event-${++this.eventSeq}`,
      timestamp: this.now(),
      sessionId: entry.session.id,
      taskSlug: entry.session.taskSlug,
      role: entry.session.role,
      ...event
    };
  }

  private getEntry(sessionId: string): RuntimeEntry {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      throw new VcmError({
        code: "TERMINAL_SESSION_MISSING",
        message: `Terminal session does not exist: ${sessionId}`,
        statusCode: 404
      });
    }
    return entry;
  }
}

export class MockClaudePromptContext {
  constructor(
    private readonly runtime: MockClaudeRuntime,
    private readonly entry: RuntimeEntry,
    readonly prompt: string
  ) {}

  get session(): TerminalSession {
    return { ...this.entry.session };
  }

  get role(): RoleName {
    return this.entry.session.role;
  }

  get taskSlug(): string {
    return this.entry.session.taskSlug;
  }

  get cwd(): string {
    return this.entry.input.cwd;
  }

  get transcriptPath(): string {
    return this.entry.transcriptPath;
  }

  async userPromptSubmit(): Promise<void> {
    await this.runtime.dispatchHook(this.entry, "UserPromptSubmit", { prompt: this.prompt });
  }

  async hook(eventName: ClaudeHookEventName, extra: Record<string, unknown> = {}): Promise<void> {
    await this.runtime.dispatchHook(this.entry, eventName, extra);
  }

  async stop(): Promise<void> {
    await this.runtime.dispatchHook(this.entry, "Stop");
  }

  async stopFailure(input: { error: string; errorDetails?: string; retryable?: boolean }): Promise<void> {
    await this.runtime.dispatchHook(this.entry, "StopFailure", {
      error: input.error,
      error_details: input.errorDetails,
      retryable: input.retryable
    });
  }

  async writeOutput(data: string): Promise<void> {
    await this.runtime.writeOutput(this.entry, data);
  }

  async appendTranscriptText(text: string, stopReason = "end_turn"): Promise<void> {
    await this.runtime.appendTranscriptText(this.entry, text, stopReason);
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(this.cwd, relativePath);
    await this.writeAbsoluteFile(absolutePath, content);
  }

  async writeAbsoluteFile(absolutePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  async appendFile(relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(this.cwd, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await appendFile(absolutePath, content, "utf8");
  }

  async readFile(relativePath: string): Promise<string> {
    return readFile(path.join(this.cwd, relativePath), "utf8");
  }
}

function normalizeTerminalWrite(data: string): string {
  return data
    .replaceAll("\x1b[200~", "")
    .replaceAll("\x1b[201~", "")
    .replace(/\r/g, "\n")
    .replace(/\n+$/g, "")
    .trim();
}

function isBracketedPaste(data: string): boolean {
  return data.includes("\x1b[200~") && data.includes("\x1b[201~");
}

function isEnter(data: string): boolean {
  return data === "\r" || data === "\n";
}

function matchesPrompt(matcher: PromptMatcher, prompt: string, session: TerminalSession): boolean {
  if (typeof matcher === "string") {
    return prompt.includes(matcher);
  }
  if (matcher instanceof RegExp) {
    return matcher.test(prompt);
  }
  return matcher(prompt, session);
}
