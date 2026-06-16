import * as pty from "node-pty";
import type { TerminalEvent } from "../../shared/types/terminal.js";
import { VcmError } from "../errors.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type {
  CreateTerminalSessionInput,
  TerminalEventListener,
  TerminalRuntime,
  TerminalSession
} from "./terminal-runtime.js";

interface RuntimeEntry {
  input: CreateTerminalSessionInput;
  session: TerminalSession;
  process: pty.IPty;
  listeners: Set<TerminalEventListener>;
  logWriter: TerminalLogWriter;
  disposed: boolean;
}

export interface NodePtyRuntimeDeps {
  fs: FileSystemAdapter;
  now?: () => string;
  id?: () => string;
  onLogWriteError?: (error: unknown, logPath: string) => void;
}

export const TERMINAL_REPLAY_TAIL_LIMIT_BYTES = 2 * 1024 * 1024;

export interface TerminalLogWriter {
  append(data: string): void;
  close(): Promise<void>;
}

export function createNodePtyTerminalRuntime(deps: NodePtyRuntimeDeps): TerminalRuntime {
  const entries = new Map<string, RuntimeEntry>();
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? (() => `session_${Date.now()}_${Math.random().toString(16).slice(2)}`);

  const emit = (entry: RuntimeEntry, event: Omit<TerminalEvent, "id" | "timestamp">) => {
    const terminalEvent: TerminalEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      timestamp: now(),
      ...event
    };
    for (const listener of entry.listeners) {
      listener(terminalEvent);
    }
  };

  const create = async (input: CreateTerminalSessionInput, sessionId = id()): Promise<TerminalSession> => {
    await deps.fs.ensureDir(input.logPath.replace(/[/\\][^/\\]+$/, ""));

    const child = pty.spawn(input.command, input.args, {
      cwd: input.cwd,
      env: buildPtyEnvironment(process.env, input.env),
      cols: input.cols ?? 100,
      rows: input.rows ?? 28,
      name: "xterm-256color"
    });

    const session: TerminalSession = {
      id: sessionId,
      taskSlug: input.taskSlug,
      role: input.role,
      status: "running",
      pid: child.pid,
      startedAt: now(),
      exitCode: null
    };

    const logWriter = createTerminalLogWriter(
      deps.fs,
      input.logPath,
      deps.onLogWriteError ?? defaultLogWriteErrorHandler
    );
    const entry: RuntimeEntry = {
      input,
      session,
      process: child,
      listeners: new Set(),
      logWriter,
      disposed: false
    };
    entries.set(session.id, entry);

    child.onData((data) => {
      if (entry.disposed) {
        return;
      }
      entry.session.lastOutputAt = now();
      entry.logWriter.append(data);
      emit(entry, {
        sessionId: session.id,
        taskSlug: input.taskSlug,
        role: input.role,
        type: "output",
        data
      });
    });

    child.onExit(({ exitCode }) => {
      if (entry.disposed) {
        return;
      }
      entry.disposed = true;
      entry.session.status = exitCode === 0 ? "exited" : "crashed";
      entry.session.exitCode = exitCode;
      void entry.logWriter.close();
      emit(entry, {
        sessionId: session.id,
        taskSlug: input.taskSlug,
        role: input.role,
        type: "exit",
        exitCode
      });
    });

    return { ...session };
  };

  return {
    createSession(input) {
      return create(input);
    },
    getSession(sessionId) {
      const entry = entries.get(sessionId);
      return entry ? { ...entry.session } : undefined;
    },
    getSessionByRole(taskSlug, role) {
      for (const entry of entries.values()) {
        if (entry.session.taskSlug === taskSlug && entry.session.role === role) {
          return { ...entry.session };
        }
      }
      return undefined;
    },
    listSessions(taskSlug) {
      return [...entries.values()]
        .filter((entry) => !taskSlug || entry.session.taskSlug === taskSlug)
        .map((entry) => ({ ...entry.session }));
    },
    write(sessionId, data) {
      const entry = getEntry(entries, sessionId);
      entry.process.write(data);
      emit(entry, {
        sessionId,
        taskSlug: entry.session.taskSlug,
        role: entry.session.role,
        type: "input",
        data
      });
    },
    resize(sessionId, cols, rows) {
      const entry = getEntry(entries, sessionId);
      entry.process.resize(cols, rows);
    },
    async stop(sessionId) {
      const entry = getEntry(entries, sessionId);
      entry.disposed = true;
      entry.session.status = "exited";
      entry.process.kill();
      await entry.logWriter.close();
    },
    async restart(sessionId) {
      const entry = getEntry(entries, sessionId);
      entry.disposed = true;
      entry.process.kill();
      await entry.logWriter.close();
      return create(entry.input, sessionId);
    },
    subscribe(sessionId, listener, options = {}) {
      const entry = getEntry(entries, sessionId);
      entry.listeners.add(listener);

      if (options.replay !== false) {
        void readTerminalReplayText(deps.fs, entry.input.logPath)
          .then((data) => {
            if (!data || !entry.listeners.has(listener)) {
              return;
            }

            listener({
              id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
              sessionId,
              taskSlug: entry.session.taskSlug,
              role: entry.session.role,
              type: "output",
              timestamp: now(),
              data
            });
          })
          .catch(() => {
            // The log file may not exist yet for a brand-new session.
          });
      }

      return () => {
        entry.listeners.delete(listener);
      };
    }
  };
}

export function createTerminalLogWriter(
  fs: Pick<FileSystemAdapter, "appendText">,
  logPath: string,
  onError: (error: unknown, logPath: string) => void
): TerminalLogWriter {
  let closed = false;
  let pending = Promise.resolve();

  return {
    append(data) {
      if (closed || !data) {
        return;
      }
      pending = pending
        .then(() => fs.appendText(logPath, data))
        .catch((error: unknown) => {
          try {
            onError(error, logPath);
          } catch {
            // Logging must never break terminal output delivery or future log writes.
          }
        });
    },
    async close() {
      closed = true;
      await pending.catch(() => undefined);
    }
  };
}

async function readTerminalReplayText(fs: FileSystemAdapter, logPath: string): Promise<string> {
  const data = fs.readTextTail
    ? await fs.readTextTail(logPath, TERMINAL_REPLAY_TAIL_LIMIT_BYTES)
    : tailTerminalReplay(await fs.readText(logPath));
  return tailTerminalReplay(data);
}

function defaultLogWriteErrorHandler(error: unknown, logPath: string): void {
  console.warn(`[VCM] Failed to append terminal log: ${logPath}`, error);
}

export function tailTerminalReplay(
  data: string,
  limitBytes = TERMINAL_REPLAY_TAIL_LIMIT_BYTES
): string {
  if (limitBytes <= 0 || Buffer.byteLength(data, "utf8") <= limitBytes) {
    return data;
  }

  let start = Math.max(0, data.length - limitBytes);
  let tail = data.slice(start);
  while (Buffer.byteLength(tail, "utf8") > limitBytes && start < data.length) {
    start += Math.max(1, Math.ceil((Buffer.byteLength(tail, "utf8") - limitBytes) / 4));
    tail = data.slice(start);
  }

  const firstLineBreak = tail.indexOf("\n");
  return firstLineBreak >= 0 ? tail.slice(firstLineBreak + 1) : tail;
}

export function buildPtyEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  inputEnv: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...inputEnv,
    TERM: inputEnv.TERM ?? "xterm-256color",
    COLORTERM: inputEnv.COLORTERM ?? baseEnv.COLORTERM ?? "truecolor",
    FORCE_COLOR: inputEnv.FORCE_COLOR ?? baseEnv.FORCE_COLOR ?? "3",
    CLICOLOR: inputEnv.CLICOLOR ?? baseEnv.CLICOLOR ?? "1",
    TERM_PROGRAM: inputEnv.TERM_PROGRAM ?? "VibeCodingMaster"
  };

  delete env.NO_COLOR;
  return env;
}

function getEntry(entries: Map<string, RuntimeEntry>, sessionId: string): RuntimeEntry {
  const entry = entries.get(sessionId);
  if (!entry) {
    throw new VcmError({
      code: "SESSION_MISSING",
      message: `Terminal session does not exist: ${sessionId}`,
      statusCode: 404
    });
  }
  return entry;
}
