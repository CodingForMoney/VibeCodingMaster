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
}

export interface NodePtyRuntimeDeps {
  fs: FileSystemAdapter;
  now?: () => string;
  id?: () => string;
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

    const entry: RuntimeEntry = {
      input,
      session,
      process: child,
      listeners: new Set()
    };
    entries.set(session.id, entry);

    child.onData((data) => {
      entry.session.lastOutputAt = now();
      void deps.fs.appendText(input.logPath, data);
      emit(entry, {
        sessionId: session.id,
        taskSlug: input.taskSlug,
        role: input.role,
        type: "output",
        data
      });
    });

    child.onExit(({ exitCode }) => {
      entry.session.status = exitCode === 0 ? "exited" : "crashed";
      entry.session.exitCode = exitCode;
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
      entry.session.status = "exited";
      entry.process.kill();
    },
    async restart(sessionId) {
      const entry = getEntry(entries, sessionId);
      entry.process.kill();
      return create(entry.input, sessionId);
    },
    subscribe(sessionId, listener, options = {}) {
      const entry = getEntry(entries, sessionId);
      entry.listeners.add(listener);

      if (options.replay !== false) {
        void deps.fs.readText(entry.input.logPath)
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
